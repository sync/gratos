// effect()'s tracing on standalone handle(Request), once per executor (docs/plan.html M5 "Done
// when", Tracing): phase spans inside the operation span, cache hits, the early-exit span, the one
// idempotent end (body wrapper, null body), streamed responses, mutations that outlive their
// client, the jit phase, and plugin order with serverTiming.
import { Clock, Context, Duration, Effect, Stream, Tracer } from "effect";
import type { ExecutionResult, GraphQLFieldResolver, GraphQLSchema } from "graphql";
import { describe, expect, it } from "vitest";

import { createServer, gqlError, jit, serverTiming } from "../../src/index.ts";
import type { Plugin, Server } from "../../src/index.ts";
import { effect, effectSchema } from "../../src/effect/index.ts";
import { closeRoute, registerRoute } from "../../src/effect/state.ts";
import { flush, gate, gql, post } from "../support/http.ts";
import { makeSchema } from "../support/schema.ts";
import { readSse } from "../support/stream.ts";
import { executors, recordingTracer, until } from "./support.ts";
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

/** No failure is a typed one in this suite. */
const isFailure = (_error: unknown): _error is never => false;

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
    { failure, isFailure },
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

/** Reads an SSE body to its end, calling `onEvent` with the text read so far. */
const readBody = async (response: Response, onEvent: (text: string) => void = () => {}) => {
  const body = response.body;
  if (body === null) {
    throw new Error("no body");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    text += decoder.decode(value, { stream: true });
    onEvent(text);
  }
};

/** Reads an SSE body until its `complete` event, and returns the reader, the end still unread. */
const readToComplete = async (response: Response) => {
  const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: complete")) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error("EOF before complete");
    }
    text += decoder.decode(value, { stream: true });
  }
  return reader;
};

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

  it("ends a 499 from a standalone abort after its interrupted resolver's held finalizer, once", async () => {
    const started = gate();
    const releasing = gate();
    const hold = gate();
    let hang = false;
    const built = build(executor.plugins(), {
      Query: {
        slow: () =>
          hang
            ? Effect.acquireRelease(
                Effect.sync(() => {
                  started.resolve();
                }),
                () =>
                  Effect.sync(() => {
                    releasing.resolve();
                  }).pipe(Effect.andThen(Effect.promise(() => hold.promise))),
              ).pipe(Effect.andThen(Effect.never), Effect.scoped)
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
    // jit ignores the abort signal: the core answers its 499 once its result came, after the
    // finalizer. The other executors answer at once.
    const early = executor.name === "jit" ? undefined : await pending;
    await releasing.promise;
    await flush();
    const [operation] = operations(built.tracer);
    // The interrupted resolver's fiber is still in its finalizer.
    expect(operation?.ended).toBe(false);
    hold.resolve();
    const response = early ?? (await pending);
    await response.text();
    expect(response.status).toBe(499);
    await until(() => built.tracer.open().length === 0);
    const [resolver] = built.tracer.named("resolve Query.slow");
    expect(resolver?.parentId).toBe(operation?.spanId);
    expect(operation?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
    expect(built.ended).toEqual([operation]);
    expect((operation?.endTime ?? 0n) >= (resolver?.endTime ?? 1n)).toBe(true);
    expect((operation?.endedAtPerf ?? 0) >= (resolver?.endedAtPerf ?? 1)).toBe(true);
  });

  it("ends a 499 after the held finalizer of a resolver whose own startup saw the abort", async () => {
    const releasing = gate();
    const hold = gate();
    const controller = new AbortController();
    let hang = false;
    const built = build(executor.plugins(), {
      Query: {
        slow: () =>
          hang
            ? Effect.acquireRelease(
                Effect.sync(() => {
                  // The client leaves while the fiber's synchronous part runs.
                  controller.abort();
                }),
                () =>
                  Effect.sync(() => {
                    releasing.resolve();
                  }).pipe(Effect.andThen(Effect.promise(() => hold.promise))),
              ).pipe(Effect.andThen(Effect.never), Effect.scoped)
            : Effect.succeed("warm"),
      },
    });
    await warm(built.server, "{ slow }");
    built.tracer.clear();
    built.ended.length = 0;
    hang = true;
    const pending = built.server.handle(post({ query: "{ slow }" }, { signal: controller.signal }));
    const early = executor.name === "jit" ? undefined : await pending;
    await releasing.promise;
    await flush();
    const [operation] = operations(built.tracer);
    expect(operation?.ended).toBe(false);
    hold.resolve();
    const response = early ?? (await pending);
    await response.text();
    expect(response.status).toBe(499);
    await until(() => built.tracer.open().length === 0);
    const [resolver] = built.tracer.named("resolve Query.slow");
    expect(operation?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
    expect((operation?.endTime ?? 0n) >= (resolver?.endTime ?? 1n)).toBe(true);
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

  it("ends an SSE subscription aborted through its request's signal with cancel, once", async () => {
    const built = build(executor.plugins(), {
      Subscription: { events: () => Stream.make("a").pipe(Stream.concat(Stream.never)) },
    });
    const controller = new AbortController();
    const response = await built.server.handle(
      post(
        { query: "subscription Aborted { events }" },
        { accept: "text/event-stream", signal: controller.signal },
      ),
    );
    // The core ends the body (EOF) once the client's signal aborts.
    const text = await readBody(response, (sofar) => {
      if (sofar.includes('"events":"a"')) {
        controller.abort();
      }
    });
    expect(readSse(text).names).toEqual(["next"]);
    const [operation] = operations(built.tracer);
    expect(operation?.name).toBe("graphql Aborted");
    // The span ends once the Stream has closed its scope, after the body ended.
    await until(() => operation?.ended === true);
    expect(operation?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
    expect(built.ended).toEqual([operation]);
    expect(built.tracer.open()).toEqual([]);
  });

  it("ends an SSE subscription whose source failed with error, not cancel", async () => {
    const built = build(
      executor.plugins(),
      {
        Subscription: {
          events: () => Stream.make("a").pipe(Stream.concat(Stream.die(new Error("boom")))),
        },
      },
      { quiet: true },
    );
    const response = await built.server.handle(
      post({ query: "subscription Failing { events }" }, { accept: "text/event-stream" }),
    );
    // The core stops the stream (and aborts its own signal) after the source's error payload.
    const events = readSse(await readBody(response));
    expect(events.names).toEqual(["next", "next", "complete"]);
    const [operation] = operations(built.tracer);
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
  });

  it("ends with cancel when the client leaves while a failed source's error is processed", async () => {
    const client = new AbortController();
    const built = build(
      executor.plugins(),
      {
        Subscription: {
          events: () => Stream.make("a").pipe(Stream.concat(Stream.die(new Error("boom")))),
        },
      },
      {
        quiet: true,
        after: [
          {
            // The core signal is already aborted to stop the failed source; the client leaves
            // before the error and the closing frame are queued.
            onResult: (payload) => {
              if (payload.errors !== undefined) {
                client.abort();
              }
              return undefined;
            },
          },
        ],
      },
    );
    const response = await built.server.handle(
      post(
        { query: "subscription Failing { events }" },
        { accept: "text/event-stream", signal: client.signal },
      ),
    );
    expect(readSse(await readBody(response)).names).toEqual(["next"]);
    await flush();
    const [operation] = operations(built.tracer);
    expect(operation?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
  });

  it.each([
    { source: "ended", events: () => Stream.make("a"), outcome: "ok", then: "reads EOF" },
    { source: "ended", events: () => Stream.make("a"), outcome: "ok", then: "cancels" },
    {
      source: "failed",
      events: () => Stream.make("a").pipe(Stream.concat(Stream.die(new Error("boom")))),
      outcome: "error",
      then: "reads EOF",
    },
    {
      source: "failed",
      events: () => Stream.make("a").pipe(Stream.concat(Stream.die(new Error("boom")))),
      outcome: "error",
      then: "cancels",
    },
  ])(
    "keeps the outcome of an SSE subscription whose source $source once complete is sent, though its client leaves before EOF and $then",
    async ({ events, outcome, then }) => {
      const built = build(executor.plugins(), { Subscription: { events } }, { quiet: true });
      const controller = new AbortController();
      const response = await built.server.handle(
        post(
          { query: "subscription Done { events }" },
          { accept: "text/event-stream", signal: controller.signal },
        ),
      );
      const reader = await readToComplete(response);
      // The core has sent its closing event; the client leaves before it reads the end.
      controller.abort();
      if (then === "cancels") {
        await reader.cancel();
      } else {
        expect((await reader.read()).done).toBe(true);
      }
      await flush();
      const [operation] = operations(built.tracer);
      expect(operation?.outcome).toBe(outcome);
      expect(operation?.endCalls).toBe(1);
    },
  );

  it("keeps the outcome of an SSE stream the core ended when its route closes after the client left", async () => {
    const built = build(executor.plugins(), { Subscription: { events: () => Stream.make("a") } });
    const controller = new AbortController();
    const request = post(
      { query: "subscription Routed { events }" },
      { accept: "text/event-stream", signal: controller.signal },
    );
    // As effectRoute registers it; its Scope closes once the transport is done with the body.
    const route = registerRoute(request, performance.now(), built.tracer.context);
    const reader = await readToComplete(await built.server.handle(request));
    controller.abort();
    closeRoute(route);
    await flush();
    const [operation] = operations(built.tracer);
    expect(operation?.outcome).toBe("ok");
    expect(operation?.endCalls).toBe(1);
    await reader.cancel();
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

  it.each(["reads EOF", "cancels"] as const)(
    "keeps the ok outcome of a @defer response once its closing delimiter is sent, though its client leaves before EOF and %s",
    async (then) => {
      const built = build(executors[2]?.plugins() ?? []);
      const controller = new AbortController();
      const response = await built.server.handle(
        post(
          { query: "query Deferred { item { value ... @defer { later } } }" },
          { accept: "multipart/mixed", signal: controller.signal },
        ),
      );
      const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
      const decoder = new TextDecoder();
      let text = "";
      // The closing delimiter (`-----`) is the core ending the multipart body itself.
      while (!text.includes("\r\n-----")) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error("EOF before the closing delimiter");
        }
        text += decoder.decode(value, { stream: true });
      }
      controller.abort();
      if (then === "cancels") {
        await reader.cancel();
      } else {
        expect((await reader.read()).done).toBe(true);
      }
      await flush();
      const [operation] = operations(built.tracer);
      expect(operation?.name).toBe("graphql Deferred");
      expect(operation?.outcome).toBe("ok");
      expect(operation?.endCalls).toBe(1);
    },
  );

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
        { failure, isFailure },
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
        { failure, isFailure },
      ),
      plugins: [effect({ context: Context.add(tracer.context, Clock.Clock, fast) })],
    });
    expect((await gql(server, "{ value }")).body).toEqual({ data: { value: "v" } });
    const [operation] = operations(tracer);
    const [resolver] = tracer.named("resolve Query.value");
    expect(resolver?.parentId).toBe(operation?.spanId);
    expect((resolver?.endTime ?? 0n) <= (operation?.endTime ?? -1n)).toBe(true);
  });

  it.each([
    ["an async", (value: Effect.Effect<string>) => value.pipe(Effect.delay("2 millis"))],
    ["a synchronous", (value: Effect.Effect<string>) => value],
  ])(
    "ends the operation span after %s resolver span when the Clock rolls back after it",
    async (_name, timing) => {
      const tracer = recordingTracer();
      let ahead = false;
      // 10 s, then 20 s while the resolver ends (its span's end reads it), then 10 s again.
      const rolling = makeClock(() =>
        ahead && !tracer.named("resolve Query.value").some((span) => span.ended)
          ? 20_000_000_000n
          : 10_000_000_000n,
      );
      const server = createServer({
        schema: effectSchema(
          makeSchema("type Query { value: String }", {
            Query: {
              value: () =>
                timing(Effect.sync(() => "v")).pipe(
                  Effect.map((value) => {
                    ahead = true;
                    return value;
                  }),
                ),
            },
          }),
          { failure, isFailure },
        ),
        plugins: [effect({ context: Context.add(tracer.context, Clock.Clock, rolling) })],
      });
      expect((await gql(server, "{ value }")).body).toEqual({ data: { value: "v" } });
      const [operation] = operations(tracer);
      const [resolver] = tracer.named("resolve Query.value");
      expect(resolver?.endTime).toBe(20_000_000_000n);
      expect((resolver?.endTime ?? 0n) <= (operation?.endTime ?? -1n)).toBe(true);
    },
  );
});

describe("effect() tracing under an external parent span", () => {
  it("keeps an unsampled external parent's sampling decision", async () => {
    const tracer = recordingTracer();
    const parent = Tracer.externalSpan({
      spanId: "external-span",
      traceId: "external-trace",
      sampled: false,
    });
    const server = createServer({
      schema: effectSchema(
        makeSchema("type Query { value: String }", {
          Query: { value: () => Effect.succeed("v").pipe(Effect.delay("1 millis")) },
        }),
        { failure, isFailure },
      ),
      plugins: [effect({ context: Context.add(tracer.context, Tracer.ParentSpan, parent) })],
    });
    expect((await gql(server, "query External { value }")).body).toEqual({
      data: { value: "v" },
    });
    const [operation] = tracer.named("graphql External");
    expect(operation?.parentId).toBe("external-span");
    expect(operation?.traceId).toBe("external-trace");
    expect(operation?.sampled).toBe(false);
    // Its children inherit the decision.
    expect(tracer.named("resolve Query.value")[0]?.sampled).toBe(false);
  });
});

/** A resource whose release waits for `hold`, and the gates a test watches. */
const held = () => {
  const acquired = gate();
  const releasing = gate();
  const hold = gate();
  const resource = Effect.acquireRelease(
    Effect.sync(() => {
      acquired.resolve();
    }),
    () =>
      Effect.sync(() => {
        releasing.resolve();
      }).pipe(Effect.andThen(Effect.promise(() => hold.promise)), Effect.withSpan("release held")),
  );
  return { acquired, releasing, hold, resource };
};

/** An onResult hook that throws on every payload `fails` picks. */
const throwing = (fails: (payload: ExecutionResult) => boolean): Plugin => ({
  onResult: (payload) => {
    if (fails(payload)) {
      throw new Error("hook failed");
    }
    return undefined;
  },
});

/** Reads a body to its end, and says whether it failed (a result hook threw) instead. */
const readFails = async (response: Response): Promise<boolean> => {
  const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
  for (;;) {
    try {
      const { done } = await reader.read();
      if (done) {
        return false;
      }
    } catch {
      return true;
    }
  }
};

describe("effect() tracing of a streamed response that fails", () => {
  it("ends the span of a @defer response whose result hook throws after a held sibling's release, once", async () => {
    const { acquired, releasing, hold, resource } = held();
    const built = build(
      executors[2]?.plugins() ?? [],
      {
        Item: {
          // Sent once the held sibling holds its resource; its payload makes the hook throw.
          value: () => Effect.promise(() => acquired.promise).pipe(Effect.as("i")),
          later: () => resource.pipe(Effect.andThen(Effect.never), Effect.scoped),
        },
      },
      {
        after: [throwing((payload) => "incremental" in payload)],
        quiet: true,
      },
    );
    const response = await built.server.handle(
      post(
        { query: "query Failing { item { ... @defer { value } ... @defer { later } } }" },
        { accept: "multipart/mixed" },
      ),
    );
    expect(await readFails(response)).toBe(true);
    await releasing.promise;
    await flush();
    const [operation] = operations(built.tracer);
    // The failed stream stopped its executor: the held sibling's fiber is still in its finalizer.
    expect(operation?.ended).toBe(false);
    hold.resolve();
    await until(() => built.tracer.open().length === 0);
    const [resolver] = built.tracer.named("resolve Item.later");
    const [release] = built.tracer.named("release held");
    expect(resolver?.parentId).toBe(operation?.spanId);
    expect(release?.parentId).toBe(resolver?.spanId);
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
    expect(built.ended).toEqual([operation]);
    expect((operation?.endTime ?? 0n) >= (release?.endTime ?? 1n)).toBe(true);
    expect((operation?.endedAtPerf ?? 0) >= (release?.endedAtPerf ?? 1)).toBe(true);
  });

  it.each(executors)(
    "ends the span of an SSE stream whose result hook throws after its Stream's held release, once ($name executor)",
    async (executor) => {
      const { releasing, hold, resource } = held();
      const built = build(
        executor.plugins(),
        {
          Subscription: {
            events: () =>
              Stream.unwrap(
                resource.pipe(Effect.as(Stream.make("a").pipe(Stream.concat(Stream.never)))),
              ),
          },
        },
        { after: [throwing((payload) => payload.data !== undefined)], quiet: true },
      );
      const response = await built.server.handle(
        post({ query: "subscription Failing { events }" }, { accept: "text/event-stream" }),
      );
      expect(await readFails(response)).toBe(true);
      await releasing.promise;
      await flush();
      const [operation] = operations(built.tracer);
      // The failed stream closed its source: the Stream's scope is still closing.
      expect(operation?.ended).toBe(false);
      hold.resolve();
      await until(() => built.tracer.open().length === 0);
      const [release] = built.tracer.named("release held");
      expect(operation?.outcome).toBe("error");
      expect(operation?.endCalls).toBe(1);
      expect(built.ended).toEqual([operation]);
      expect((operation?.endTime ?? 0n) >= (release?.endTime ?? 1n)).toBe(true);
      expect((operation?.endedAtPerf ?? 0) >= (release?.endedAtPerf ?? 1)).toBe(true);
    },
  );
});
