// effect()'s tracing on standalone handle(Request), once per executor (docs/plan.html M5 "Done
// when", Tracing): phase spans inside the operation span, cache hits, the early-exit span, the one
// idempotent end (body wrapper, null body), streamed responses, mutations that outlive their
// client, the jit phase, and plugin order with serverTiming.
import { Clock, Context, Duration, Effect, Stream } from "effect";
import type { GraphQLFieldResolver, GraphQLSchema } from "graphql";
import { describe, expect, it } from "vitest";

import { createServer, gqlError, jit, serverTiming } from "../../src/index.ts";
import type { Plugin, Server } from "../../src/index.ts";
import { effect, effectSchema } from "../../src/effect/index.ts";
import { flush, gate, gql, post } from "../support/http.ts";
import { makeSchema } from "../support/schema.ts";
import { readSse } from "../support/stream.ts";
import { executors, recordingTracer } from "./support.ts";
import type { RecordedSpan, RecordingTracer } from "./support.ts";

type Resolver = GraphQLFieldResolver<never, unknown>;
type Overrides = Readonly<Record<string, Readonly<Record<string, Resolver>>>>;

const SDL = `
  type Query { value: String, slow: String, item: Item }
  type Item { value: String, later: String }
  type Mutation { first: String, second: String }
  type Subscription { events: String }
`;

const failure = (): never => {
  throw new Error("no typed failures in this suite");
};

const asSubscriptions = (schema: GraphQLSchema): GraphQLSchema => {
  for (const field of Object.values(schema.getSubscriptionType()?.getFields() ?? {})) {
    if (field.resolve !== undefined) {
      field.subscribe = field.resolve;
      field.resolve = (payload: unknown) => payload;
    }
  }
  return schema;
};

interface Built {
  readonly server: Server;
  readonly tracer: RecordingTracer;
  readonly ended: Array<RecordedSpan>;
}

const build = (
  plugins: ReadonlyArray<Plugin>,
  overrides: Overrides = {},
  options: { readonly after?: ReadonlyArray<Plugin>; readonly quiet?: boolean } = {},
): Built => {
  const tracer = recordingTracer();
  const ended: Array<RecordedSpan> = [];
  const schema = effectSchema(
    asSubscriptions(
      makeSchema(SDL, {
        Query: {
          value: () => Effect.succeed("v").pipe(Effect.delay("1 millis")),
          item: () => ({ value: "i" }),
          ...overrides["Query"],
        },
        Item: {
          later: () => Effect.succeed("later").pipe(Effect.delay("1 millis")),
          ...overrides["Item"],
        },
        ...Object.fromEntries(
          Object.entries(overrides).filter(([name]) => name !== "Query" && name !== "Item"),
        ),
      }),
    ),
    { failure },
  );
  const server = createServer({
    schema,
    context: () => ({}),
    plugins: [
      ...plugins,
      effect({
        context: tracer.context,
        onSpanEnd: (span) => {
          const recorded = tracer.spans.find((candidate) => candidate === span);
          if (recorded !== undefined) {
            ended.push(recorded);
          }
        },
      }),
      ...(options.after ?? []),
    ],
    logger: options.quiet === true ? { warn: () => {}, error: () => {} } : console,
  });
  return { server, tracer, ended };
};

/** The operation spans (named `graphql …`). */
const operations = (tracer: RecordingTracer) =>
  tracer.spans.filter((span) => span.name.startsWith("graphql "));

const childrenOf = (tracer: RecordingTracer, parent: RecordedSpan | undefined) =>
  tracer.spans.filter((span) => span.parentId === parent?.spanId);

describe.each(executors)("effect() tracing ($name executor)", (executor) => {
  const warm = async (server: Server, query: string) => {
    for (let index = 0; index < executor.warmUp; index += 1) {
      await gql(server, query);
    }
  };

  it("starts phase spans at or after the operation span, inside it, on one trace", async () => {
    const built = build(executor.plugins());
    const sent = await gql(built.server, "query Named { value }");
    expect(sent.body).toEqual({ data: { value: "v" } });
    const [operation] = operations(built.tracer);
    expect(operation?.name).toBe("graphql Named");
    expect(operation?.outcome).toBe("ok");
    const children = childrenOf(built.tracer, operation);
    expect(children.map((span) => span.name).toSorted()).toEqual([
      "parse",
      "resolve Query.value",
      "validate",
    ]);
    for (const child of children) {
      expect(child.traceId).toBe(operation?.traceId);
      expect(child.startTime >= (operation?.startTime ?? 0n)).toBe(true);
      expect((child.endTime ?? 0n) <= (operation?.endTime ?? 0n)).toBe(true);
    }
    expect(built.ended).toEqual([operation]);
    expect(operation?.endCalls).toBe(1);
  });

  it("emits no parse or validate span on a cache hit", async () => {
    const built = build(executor.plugins());
    await gql(built.server, "{ value }");
    built.tracer.clear();
    await gql(built.server, "{ value }");
    const [operation] = operations(built.tracer);
    const names = childrenOf(built.tracer, operation).map((span) => span.name);
    expect(names).not.toContain("parse");
    expect(names).not.toContain("validate");
  });

  it("gives a validation error a graphql anonymous error span, with its phases", async () => {
    const built = build(executor.plugins());
    const sent = await gql(built.server, "{ nope }");
    expect(sent.status).toBe(400);
    const [operation] = operations(built.tracer);
    expect(operation?.name).toBe("graphql anonymous");
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
    expect(
      childrenOf(built.tracer, operation)
        .map((span) => span.name)
        .toSorted(),
    ).toEqual(["parse", "validate"]);
  });

  it("ends an onRequest 2xx answer with an ok span", async () => {
    const answering: Plugin = { onRequest: () => new Response("ok", { status: 200 }) };
    const built = build([answering, ...executor.plugins()]);
    const response = await built.server.handle(post({ query: "{ value }" }));
    expect(await response.text()).toBe("ok");
    const [operation] = operations(built.tracer);
    expect(operation?.name).toBe("graphql anonymous");
    expect(operation?.outcome).toBe("ok");
    expect(operation?.endCalls).toBe(1);
  });

  it("ends a 499 from a standalone abort exactly once, with cancel, and leaves no span open", async () => {
    const started = gate();
    let hang = false;
    const built = build(executor.plugins(), {
      Query: {
        slow: () =>
          hang
            ? Effect.sync(() => {
                started.resolve();
              }).pipe(Effect.andThen(Effect.never))
            : Effect.succeed("warm"),
      },
    });
    await warm(built.server, "{ slow }");
    built.tracer.clear();
    built.ended.length = 0;
    hang = true;
    const controller = new AbortController();
    const pending = built.server.handle(post({ query: "{ slow }" }, { signal: controller.signal }));
    await started.promise;
    controller.abort();
    const response = await pending;
    await response.text();
    const [operation] = operations(built.tracer);
    // jit ignores the abort signal, but the core cancels its late result too.
    expect(response.status).toBe(499);
    expect(operation?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
    expect(built.ended).toEqual([operation]);
    expect(built.tracer.open()).toEqual([]);
  });

  it("ends an SSE subscription's span once, at or after its last payload was written", async () => {
    const built = build(executor.plugins(), {
      Subscription: {
        events: () => Stream.make("a", "b", "c").pipe(Stream.tap(() => Effect.sleep("1 millis"))),
      },
    });
    const response = await built.server.handle(
      post({ query: "subscription Events { events }" }, { accept: "text/event-stream" }),
    );
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let lastPayloadAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      lastPayloadAt = performance.now();
    }
    expect(readSse(text).names).toEqual(["next", "next", "next", "complete"]);
    const [operation] = operations(built.tracer);
    expect(operation?.name).toBe("graphql Events");
    expect(operation?.endCalls).toBe(1);
    expect(built.ended).toEqual([operation]);
    expect((operation?.endedAtPerf ?? 0) >= lastPayloadAt).toBe(true);
    expect(operation?.outcome).toBe("ok");
  });

  it("ends a mutation whose client left after its first resolver started after its last resolver, ok", async () => {
    const hold = gate();
    const started = gate();
    let holding = false;
    const built = build(executor.plugins(), {
      Mutation: {
        first: () =>
          Effect.gen(function* () {
            if (holding) {
              started.resolve();
              yield* Effect.promise(() => hold.promise);
            }
            return "one";
          }),
        second: () => Effect.succeed("two").pipe(Effect.delay("1 millis")),
      },
    });
    await warm(built.server, "mutation Write { first second }");
    built.tracer.clear();
    built.ended.length = 0;
    holding = true;
    const controller = new AbortController();
    const pending = built.server.handle(
      post({ query: "mutation Write { first second }" }, { signal: controller.signal }),
    );
    await started.promise;
    controller.abort();
    // The client is gone: the body is cancelled (the span's end is deferred, not cancelled).
    await flush();
    hold.resolve();
    const response = await pending;
    await response.body?.cancel();
    const [operation] = operations(built.tracer);
    const resolvers = built.tracer.spans.filter((span) => span.name.startsWith("resolve "));
    expect(resolvers.map((span) => span.name)).toEqual([
      "resolve Mutation.first",
      "resolve Mutation.second",
    ]);
    for (const resolver of resolvers) {
      expect((resolver.endTime ?? 0n) <= (operation?.endTime ?? -1n)).toBe(true);
    }
    expect(operation?.outcome).toBe("ok");
    expect(operation?.endCalls).toBe(1);
    expect(built.ended).toEqual([operation]);
  });

  it("ends a started standalone mutation's span before drain() resolves, its client gone and its body unread", async () => {
    const hold = gate();
    const started = gate();
    let holding = false;
    const built = build(executor.plugins(), {
      Mutation: {
        first: () =>
          Effect.gen(function* () {
            if (holding) {
              started.resolve();
              yield* Effect.promise(() => hold.promise);
            }
            return "one";
          }),
      },
    });
    await warm(built.server, "mutation Write { first }");
    built.tracer.clear();
    holding = true;
    const controller = new AbortController();
    const pending = built.server.handle(
      post({ query: "mutation Write { first }" }, { signal: controller.signal }),
    );
    await started.promise;
    controller.abort();
    const drained = built.server.control.drain();
    hold.resolve();
    await drained;
    // Before anything touches the body: the span has ended, ok.
    const [operation] = operations(built.tracer);
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("ok");
    await (await pending).body?.cancel();
    expect(operation?.endCalls).toBe(1);
  });

  it.each([
    ["its client stays", false],
    ["its client left first", true],
  ])("ends a mutation whose result hook throws (a 500) with error (%s)", async (_name, leave) => {
    const hold = gate();
    const started = gate();
    let holding = false;
    const built = build(
      executor.plugins(),
      {
        Mutation: {
          first: () =>
            Effect.gen(function* () {
              if (holding) {
                started.resolve();
                yield* Effect.promise(() => hold.promise);
              }
              return "one";
            }),
        },
      },
      {
        after: [
          {
            onResult: () => {
              throw new Error("result hook failed");
            },
          },
        ],
        quiet: true,
      },
    );
    await warm(built.server, "mutation Write { first }");
    built.tracer.clear();
    holding = true;
    const controller = new AbortController();
    const pending = built.server.handle(
      post({ query: "mutation Write { first }" }, { signal: controller.signal }),
    );
    await started.promise;
    if (leave) {
      controller.abort();
    }
    hold.resolve();
    const response = await pending;
    expect(response.status).toBe(500);
    await response.body?.cancel();
    const [operation] = operations(built.tracer);
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
  });

  it("ends a mutation whose response body fails with error", async () => {
    let failing = false;
    const failingBody: Plugin = {
      onResponse: (response) =>
        !failing
          ? undefined
          : new Response(
              new ReadableStream({
                pull: (controller) => {
                  controller.error(new Error("body failed"));
                },
              }),
              { status: response.status, headers: response.headers },
            ),
    };
    const built = build([...executor.plugins(), failingBody], {
      Mutation: { first: () => Effect.succeed("one") },
    });
    await warm(built.server, "mutation Write { first }");
    built.tracer.clear();
    failing = true;
    const response = await built.server.handle(post({ query: "mutation Write { first }" }));
    await expect(response.text()).rejects.toThrow("body failed");
    const [operation] = operations(built.tracer);
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
  });

  it("ends a failing mutation whose client left with error, never cancel", async () => {
    const hold = gate();
    const started = gate();
    const built = build(executor.plugins(), {
      Mutation: {
        first: () =>
          Effect.gen(function* () {
            started.resolve();
            yield* Effect.promise(() => hold.promise);
            return "one";
          }),
        second: () => Effect.die(gqlError("write failed", 500)),
      },
    });
    const controller = new AbortController();
    const pending = built.server.handle(
      post({ query: "mutation { first second }" }, { signal: controller.signal }),
    );
    await started.promise;
    controller.abort();
    await flush();
    hold.resolve();
    await (await pending).body?.cancel();
    const [operation] = operations(built.tracer);
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
  });

  it.each([
    ["serverTiming() first", true],
    ["effect() first", false],
  ])("ends the span whatever the order with serverTiming (%s)", async (_name, timingFirst) => {
    const built = timingFirst
      ? build([serverTiming(), ...executor.plugins()])
      : build(executor.plugins(), {}, { after: [serverTiming()] });
    const response = await built.server.handle(post({ query: "{ value }" }));
    expect(response.headers.get("server-timing")).toContain("total;dur=");
    await response.text();
    const [operation] = operations(built.tracer);
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("ok");
  });
});

describe("effect() tracing of incremental delivery and jit", () => {
  it("ends a @defer response's span once, at or after its last payload", async () => {
    const built = build(executors[2]?.plugins() ?? []);
    const response = await built.server.handle(
      post(
        { query: "query Deferred { item { value ... @defer { later } } }" },
        { accept: "multipart/mixed" },
      ),
    );
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const reader = body.getReader();
    let lastPayloadAt = 0;
    let chunks = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
      chunks += 1;
      lastPayloadAt = performance.now();
    }
    expect(chunks).toBeGreaterThanOrEqual(2);
    const [operation] = operations(built.tracer);
    expect(operation?.name).toBe("graphql Deferred");
    expect(operation?.endCalls).toBe(1);
    expect(built.ended).toEqual([operation]);
    expect((operation?.endedAtPerf ?? 0) >= lastPayloadAt).toBe(true);
    const later = built.tracer.named("resolve Item.later");
    expect(later[0]?.parentId).toBe(operation?.spanId);
  });

  it("emits a jit child span on the third request for a document", async () => {
    const built = build([jit({ after: 3 })]);
    const jitSpans: Array<number> = [];
    for (let request = 1; request <= 4; request += 1) {
      built.tracer.clear();
      await gql(built.server, "{ value }");
      const [operation] = operations(built.tracer);
      if (childrenOf(built.tracer, operation).some((span) => span.name === "jit")) {
        jitSpans.push(request);
      }
    }
    expect(jitSpans).toEqual([3]);
  });
});

/** A Clock reading `nanos`, sleeping on real timers. */
const makeClock = (nanos: () => bigint): Clock.Clock => ({
  currentTimeMillisUnsafe: () => Number(nanos() / 1_000_000n),
  currentTimeMillis: Effect.sync(() => Number(nanos() / 1_000_000n)),
  currentTimeNanosUnsafe: nanos,
  currentTimeNanos: Effect.sync(nanos),
  monotonicTimeNanosUnsafe: nanos,
  monotonicTimeNanos: Effect.sync(nanos),
  sleep: (duration) =>
    Effect.promise(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, Duration.toMillis(duration));
        }),
    ),
});

const twiceAsFast = (): bigint => BigInt(Math.round(performance.now() * 2_000_000));

describe("effect() tracing with a Clock that is not performance.now()", () => {
  /** A Clock that never moves: the coarsest one, as a millisecond Clock is within a millisecond. */
  const clock = makeClock(() => 1_000_000_000n);

  it("ends the operation span after a phase reported after onContext (a jit compile)", async () => {
    const tracer = recordingTracer();
    const server = createServer({
      schema: effectSchema(
        makeSchema("type Query { value: String }", {
          Query: { value: () => Effect.succeed("v").pipe(Effect.delay("2 millis")) },
        }),
        { failure },
      ),
      plugins: [
        jit({ after: 2 }),
        effect({ context: Context.add(tracer.context, Clock.Clock, clock) }),
      ],
    });
    await gql(server, "{ value }");
    tracer.clear();
    // The second use compiles, after onContext: its jit phase is emitted at once.
    expect((await gql(server, "{ value }")).body).toEqual({ data: { value: "v" } });
    const [operation] = operations(tracer);
    const [compile] = tracer.named("jit");
    expect(compile?.parentId).toBe(operation?.spanId);
    expect((compile?.startTime ?? -1n) >= (operation?.startTime ?? 0n)).toBe(true);
    expect((compile?.endTime ?? 0n) <= (operation?.endTime ?? -1n)).toBe(true);
  });

  it("ends the operation span after its resolver spans, on a Clock that runs ahead", async () => {
    // Twice as fast as performance.now(): the anchored timeline alone falls behind it.
    const fast = makeClock(twiceAsFast);
    const tracer = recordingTracer();
    const server = createServer({
      schema: effectSchema(
        makeSchema("type Query { value: String }", {
          Query: { value: () => Effect.succeed("v").pipe(Effect.delay("5 millis")) },
        }),
        { failure },
      ),
      plugins: [effect({ context: Context.add(tracer.context, Clock.Clock, fast) })],
    });
    expect((await gql(server, "{ value }")).body).toEqual({ data: { value: "v" } });
    const [operation] = operations(tracer);
    const [resolver] = tracer.named("resolve Query.value");
    expect(resolver?.parentId).toBe(operation?.spanId);
    expect((resolver?.endTime ?? 0n) <= (operation?.endTime ?? -1n)).toBe(true);
  });
});
