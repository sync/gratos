// The operation span ends after every span it parents (docs/plan.html F5, "Done when"), each case on
// the executor it is about. Each test records start, finalizer and span-end events in one log and
// orders them with gates (deferreds): no sleeps, no wall-clock comparisons.
import { Cause, Effect, Exit, Stream, Tracer } from "effect";
import type { Scope } from "effect";
import { HttpServerError } from "effect/http";
import type {
  GraphQLError,
  GraphQLFieldResolver,
  GraphQLResolveInfo,
  GraphQLSchema,
} from "graphql";
import { describe, expect, it, onTestFinished } from "vitest";

import { abortKindOf } from "../../src/core/abortReason.ts";
import { createServer, incremental, jit, reportErrors, signalOf } from "../../src/index.ts";
import type { Plugin, Server } from "../../src/index.ts";
import { effect, effectSchema } from "../../src/effect/index.ts";
import { RequestEnded } from "../../src/effect/errors.ts";
import { flush, gate, gql, post, send } from "../support/http.ts";
import { makeSchema } from "../support/schema.ts";
import { readSse } from "../support/stream.ts";
import { RecordedSpan } from "./support.ts";

type Resolver = GraphQLFieldResolver<never, unknown>;
type Overrides = Readonly<Record<string, Readonly<Record<string, Resolver>>>>;

const SDL = `
  type Query { slow: String, failing: String!, late: String, item: Item, box: Box }
  type Item { value: String, later: String }
  type Box { slow: String, failing: String! }
  type Mutation { nested: Box }
  type Subscription { events: Box, source: String }
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

/** A span that also logs its end, so span ends order against the resolvers' own events. */
class LoggedSpan extends RecordedSpan {
  log: Array<string> = [];

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    this.log.push(`end ${this.name}`);
  }
}

interface Built {
  readonly server: Server;
  readonly spans: Array<LoggedSpan>;
  /** The operation spans (named `graphql …`). */
  readonly operations: () => Array<LoggedSpan>;
  readonly named: (name: string) => Array<LoggedSpan>;
  /** Resolves with the operation span once onSpanEnd has run for it. */
  readonly spanEnded: Promise<Tracer.Span>;
  /** How many times onSpanEnd ran. */
  readonly endCount: () => number;
  /** What reportErrors saw, by message. */
  readonly reported: Array<string>;
  /** The requests that reached onContext, in order. */
  readonly requests: Array<Request>;
}

const build = (
  log: Array<string>,
  plugins: ReadonlyArray<Plugin>,
  overrides: Overrides,
  options: { readonly after?: ReadonlyArray<Plugin> } = {},
): Built => {
  const spans: Array<LoggedSpan> = [];
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new LoggedSpan(spanOptions);
      span.log = log;
      spans.push(span);
      return span;
    },
  });
  const ended = gate<Tracer.Span>();
  let endCount = 0;
  const reported: Array<string> = [];
  const requests: Array<Request> = [];
  const schema = effectSchema(
    asSubscriptions(
      makeSchema(SDL, {
        Query: { item: () => ({ value: "i" }), box: () => ({}), ...overrides["Query"] },
        Item: { value: () => "i", later: () => Effect.succeed("later"), ...overrides["Item"] },
        Mutation: { nested: () => ({}), ...overrides["Mutation"] },
        ...Object.fromEntries(
          Object.entries(overrides).filter(
            ([name]) => name !== "Query" && name !== "Item" && name !== "Mutation",
          ),
        ),
      }),
    ),
    { failure, isFailure },
  );
  const server = createServer({
    schema,
    context: () => ({}),
    plugins: [
      {
        onContext: (_ctx, request) => {
          requests.push(request);
        },
      },
      reportErrors<object>((error: GraphQLError) => {
        reported.push(error.message);
      }),
      ...plugins,
      effect({
        context: Tracer.Tracer.context(tracer),
        onSpanEnd: (span) => {
          endCount += 1;
          ended.resolve(span);
        },
      }),
      ...(options.after ?? []),
    ],
    logger: { warn: () => {}, error: () => {} },
  });
  return {
    server,
    spans,
    operations: () => spans.filter((span) => span.name.startsWith("graphql ")),
    named: (name) => spans.filter((span) => span.name === name),
    spanEnded: ended.promise,
    endCount: () => endCount,
    reported,
    requests,
  };
};

/** What ended a resolver's fiber: success, a failure, or an interrupt and whose annotation. */
type Stop = "success" | "failure" | "client" | "internal" | "unannotated";

const stopOf = (exit: Exit.Exit<unknown, unknown>): Stop => {
  if (Exit.isSuccess(exit)) {
    return "success";
  }
  const interrupts = exit.cause.reasons.filter(Cause.isInterruptReason);
  if (interrupts.length === 0) {
    return "failure";
  }
  if (interrupts.some((reason) => reason.annotations.has(HttpServerError.ClientAbort.key))) {
    return "client";
  }
  if (interrupts.some((reason) => reason.annotations.has(RequestEnded.key))) {
    return "internal";
  }
  return "unannotated";
};

/**
 * A resource whose release is held open by a latch: `started` once acquired, `releasing` once
 * its finalizer runs, which then waits for `hold`. Each step is logged under `name`.
 */
const held = (log: Array<string>, name: string, onAcquire: () => void = () => {}) => {
  const started = gate();
  const releasing = gate();
  const hold = gate();
  const resource = Effect.acquireRelease(
    Effect.sync(() => {
      log.push(`${name} start`);
      started.resolve();
      onAcquire();
    }),
    () =>
      Effect.sync(() => {
        log.push(`${name} finalizer`);
        releasing.resolve();
      }).pipe(
        Effect.andThen(Effect.promise(() => hold.promise)),
        Effect.andThen(
          Effect.sync(() => {
            log.push(`${name} released`);
          }),
        ),
      ),
  );
  return { started, releasing, hold, resource };
};

/** Runs `body` with the held resource, then records how its fiber ended (after the finalizer). */
const recording = <A>(
  log: Array<string>,
  name: string,
  stops: Array<Stop>,
  body: Effect.Effect<A, unknown, Scope.Scope>,
) =>
  body.pipe(
    Effect.scoped,
    Effect.onExit((exit) =>
      Effect.sync(() => {
        const stop = stopOf(exit);
        stops.push(stop);
        log.push(`${name} exit ${stop}`);
      }),
    ),
  );

const failingField = (after: Promise<void>) => () =>
  Effect.promise(() => after).pipe(Effect.andThen(Effect.die(new Error("failing field"))));

/** The index of `entry` in the log, failing when it is missing. */
const at = (log: ReadonlyArray<string>, entry: string): number => {
  const index = log.indexOf(entry);
  expect(index, `"${entry}" in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
  return index;
};

const endedNotBefore = (operation: LoggedSpan | undefined, child: LoggedSpan | undefined) => {
  expect(operation?.ended).toBe(true);
  expect(child?.ended).toBe(true);
  expect((operation?.endTime ?? 0n) >= (child?.endTime ?? 1n)).toBe(true);
};

/** The client of a response: its reader of the body, once it has one. */
interface Client {
  reader?: ReadableStreamDefaultReader<Uint8Array> | undefined;
}

const incrementalPlugins = (): ReadonlyArray<Plugin> => [incremental()];

/** Waits, at most two seconds, for `check()` to hold, once per event-loop turn. */
const until = async (check: () => boolean): Promise<void> => {
  for (let turn = 0; !check(); turn += 1) {
    if (turn > 10_000) {
      throw new Error("condition not met");
    }
    await flush();
  }
};

describe("F5: deferred startup (incremental executor)", () => {
  it("ends the operation span after a deferred resolver that cancels its own response before its first suspension, once", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const client: Client = {};
    const sibling = held(log, "later", () => {
      // Synchronously, inside the fiber's start: the client cancels the response body.
      void client.reader?.cancel();
    });
    const built = build(log, incrementalPlugins(), {
      Item: {
        later: () =>
          recording(log, "later", stops, sibling.resource.pipe(Effect.andThen(Effect.never))),
      },
    });
    const response = await built.server.handle(
      post(
        { query: "query Deferred { item { value ... @defer { later } } }" },
        { accept: "multipart/mixed" },
      ),
    );
    const reader = response.body?.getReader();
    client.reader = reader;
    // The initial payload; the deferred work runs on the next pull.
    expect((await reader?.read())?.done).toBe(false);
    expect((await reader?.read())?.done).toBe(true);
    await sibling.releasing.promise;
    await flush();
    const [operation] = built.operations();
    // The interrupted resolver is still in its finalizer.
    expect(operation?.ended).toBe(false);
    sibling.hold.resolve();
    await built.spanEnded;
    const [resolver] = built.named("resolve Item.later");
    expect(at(log, "later finalizer")).toBeLessThan(at(log, "later released"));
    expect(at(log, "end resolve Item.later")).toBeLessThan(at(log, "end graphql Deferred"));
    expect(at(log, "later exit client")).toBeLessThan(at(log, "end graphql Deferred"));
    endedNotBefore(operation, resolver);
    expect(operation?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
    expect(built.endCount()).toBe(1);
    expect(stops).toEqual(["client"]);
  });
});

describe("F5: first pull (subscription path)", () => {
  // Written first (docs/plan.html F5): it fails on the base, so this is a gap, located but not
  // fixed here. The client's abort inside the source's first pull closes the stream at once, and
  // the iterator's return() reaches Stream.toAsyncIterableWith re-entrantly, while that first
  // next() is still forking its pull fiber: the iterator closes its scope before it knows the
  // fiber, its return() resolves before the source's finalizer has run, and the span ends while
  // the finalizer is still open. The fix needs a mechanism the plan does not describe, so it waits
  // for a council; `it.fails` turns red once it is fixed.
  it.fails("runs the source's finalizer before the span ends when the source aborts the request during its first pull, once", async () => {
    const log: Array<string> = [];
    const controller = new AbortController();
    const source = held(log, "source", () => {
      controller.abort();
    });
    onTestFinished(() => {
      source.hold.resolve();
    });
    const built = build(log, [], {
      Subscription: {
        source: () => Stream.unwrap(source.resource.pipe(Effect.as(Stream.never))),
      },
    });
    const response = await built.server.handle(
      post(
        { query: "subscription FirstPull { source }" },
        { accept: "text/event-stream", signal: controller.signal },
      ),
    );
    // Reading pulls the source: it acquires, aborts the request, and the body ends.
    expect(await response.text()).toBe("");
    await source.releasing.promise;
    await flush();
    const [operation] = built.operations();
    expect(operation?.ended).toBe(false);
    source.hold.resolve();
    await built.spanEnded;
    expect(at(log, "source released")).toBeLessThan(at(log, "end graphql FirstPull"));
    expect(operation?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
    expect(built.endCount()).toBe(1);
  });
});

describe("F5: a non-null field fails while a sibling runs", () => {
  it("waits for the interrupted sibling's finalizer on graphql-js (default executor), and ends with error, once", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const sibling = held(log, "slow");
    const built = build(log, [], {
      Query: {
        slow: () =>
          recording(log, "slow", stops, sibling.resource.pipe(Effect.andThen(Effect.never))),
        failing: failingField(sibling.started.promise),
      },
    });
    const sent = await send(built.server, post({ query: "query Short { slow failing }" }));
    // The response arrives, and its body is read, while the sibling's finalizer is still open.
    expect(sent.body?.data).toBeNull();
    expect(sent.body?.errors?.map((error) => error.message)).toEqual(["failing field"]);
    await sibling.releasing.promise;
    await flush();
    const [operation] = built.operations();
    expect(log).not.toContain("slow released");
    expect(operation?.ended).toBe(false);
    sibling.hold.resolve();
    await built.spanEnded;
    const [resolver] = built.named("resolve Query.slow");
    expect(at(log, "slow released")).toBeLessThan(at(log, "end graphql Short"));
    expect(at(log, "end resolve Query.slow")).toBeLessThan(at(log, "end graphql Short"));
    endedNotBefore(operation, resolver);
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
    expect(built.endCount()).toBe(1);
    // graphql-js's own completion abort interrupted the sibling: not the client leaving.
    expect(stops).toEqual(["internal"]);
    expect(built.reported).toEqual(["failing field"]);
  });

  it("lets the sibling run to its end on warmed jit, and ends the span after it (pinning)", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    let measured = false;
    const failed = gate();
    const sibling = held(log, "slow");
    const built = build(log, [jit({ after: 2 })], {
      Query: {
        slow: () =>
          measured
            ? recording(
                log,
                "slow",
                stops,
                sibling.resource.pipe(
                  Effect.andThen(Effect.promise(() => failed.promise)),
                  Effect.as("slow"),
                ),
              )
            : Effect.succeed("warm"),
        failing: () =>
          measured
            ? Effect.promise(() => sibling.started.promise).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    failed.resolve();
                  }),
                ),
                Effect.andThen(Effect.die(new Error("failing field"))),
              )
            : Effect.succeed("warm"),
      },
    });
    const query = "query Short { slow failing }";
    await gql(built.server, query);
    built.spans.length = 0;
    log.length = 0;
    measured = true;
    let answered = false;
    const pending = send(built.server, post({ query })).then((sent) => {
      answered = true;
      return sent;
    });
    await sibling.releasing.promise;
    await flush();
    // graphql-jit waits for the pending resolver: the response has not come yet.
    expect(answered).toBe(false);
    sibling.hold.resolve();
    const sent = await pending;
    expect(sent.body?.data).toBeNull();
    await built.spanEnded;
    const [operation] = built.operations();
    const [resolver] = built.named("resolve Query.slow");
    expect(at(log, "slow exit success")).toBeLessThan(at(log, "end graphql Short"));
    endedNotBefore(operation, resolver);
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
    expect(stops).toEqual(["success"]);
    expect(built.reported).toEqual(["failing field"]);
  });

  it("never starts an Effect that arrives after the response ended (default executor)", async () => {
    const log: Array<string> = [];
    const late = gate<Effect.Effect<string>>();
    const built = build(log, [], {
      Query: {
        late: () => late.promise,
        failing: () => Effect.die(new Error("failing field")),
      },
    });
    const sent = await send(built.server, post({ query: "query Late { late failing }" }));
    expect(sent.body?.data).toBeNull();
    await built.spanEnded;
    late.resolve(
      Effect.sync(() => {
        log.push("late start");
        return "late";
      }),
    );
    // The wrapper's continuation runs in a microtask: done once the event loop turns.
    await flush();
    expect(log).not.toContain("late start");
    expect(built.named("resolve Query.late")).toEqual([]);
    expect(built.reported).toEqual(["failing field"]);
    expect(built.endCount()).toBe(1);
  });

  it.each([
    { name: "default", plugins: (): ReadonlyArray<Plugin> => [], warmUp: 0 },
    { name: "jit", plugins: (): ReadonlyArray<Plugin> => [jit({ after: 2 })], warmUp: 1 },
  ])(
    "never interrupts the sibling under a mutation, and ends the span before drain() resolves ($name executor, pinning)",
    async ({ plugins, warmUp }) => {
      const log: Array<string> = [];
      const stops: Array<Stop> = [];
      let measured = false;
      const go = gate();
      const started = gate();
      const failed = gate();
      const sibling = held(log, "slow");
      const built = build(log, plugins(), {
        Mutation: {
          nested: () =>
            measured
              ? Effect.sync(() => {
                  started.resolve();
                }).pipe(Effect.andThen(Effect.promise(() => go.promise)), Effect.as({}))
              : Effect.succeed({}),
        },
        Box: {
          slow: () =>
            measured
              ? recording(
                  log,
                  "slow",
                  stops,
                  sibling.resource.pipe(
                    Effect.andThen(Effect.promise(() => failed.promise)),
                    Effect.as("slow"),
                  ),
                )
              : Effect.succeed("warm"),
          failing: () =>
            measured
              ? Effect.promise(() => sibling.started.promise).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      failed.resolve();
                    }),
                  ),
                  Effect.andThen(Effect.die(new Error("failing field"))),
                )
              : Effect.succeed("warm"),
        },
      });
      const query = "mutation Nested { nested { slow failing } }";
      for (let index = 0; index < warmUp; index += 1) {
        await gql(built.server, query);
      }
      built.spans.length = 0;
      log.length = 0;
      measured = true;
      const controller = new AbortController();
      const pending = built.server.handle(post({ query }, { signal: controller.signal }));
      // Its client leaves and the drain begins once the mutation has started.
      await started.promise;
      controller.abort();
      const drained = built.server.control.drain();
      go.resolve();
      sibling.hold.resolve();
      await drained;
      log.push("drained");
      const [operation] = built.operations();
      expect(operation?.endCalls).toBe(1);
      expect(at(log, "end graphql Nested")).toBeLessThan(at(log, "drained"));
      await (await pending).body?.cancel();
      await until(() => stops.length === 1);
      expect(stops).toEqual(["success"]);
      expect(operation?.endCalls).toBe(1);
    },
  );
});

describe("F5: a subscription source fails while a resolver still runs", () => {
  it("interrupts the sibling with the internal annotation, keeps the failed-source reason on the core signal, and ends after it", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const sibling = held(log, "slow");
    const built = build(log, [], {
      Subscription: {
        events: () =>
          Stream.make({}).pipe(
            Stream.concat(
              Stream.fromEffect(
                // The next pull fails once the previous event's sibling is in its finalizer.
                Effect.promise(() => sibling.releasing.promise).pipe(
                  Effect.andThen(Effect.die(new Error("source failed"))),
                ),
              ),
            ),
          ),
      },
      Box: {
        slow: () =>
          recording(log, "slow", stops, sibling.resource.pipe(Effect.andThen(Effect.never))),
        failing: failingField(sibling.started.promise),
      },
    });
    const response = await built.server.handle(
      post(
        { query: "subscription Failing { events { slow failing } }" },
        { accept: "text/event-stream" },
      ),
    );
    const events = readSse(await response.text());
    expect(events.names).toEqual(["next", "next", "complete"]);
    const [request] = built.requests;
    expect(abortKindOf(request === undefined ? undefined : signalOf(request)?.reason)).toBe(
      "source",
    );
    await flush();
    const [operation] = built.operations();
    expect(operation?.ended).toBe(false);
    sibling.hold.resolve();
    await built.spanEnded;
    expect(at(log, "slow released")).toBeLessThan(at(log, "end graphql Failing"));
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
    expect(stops).toEqual(["internal"]);
    expect(built.reported).toEqual(["failing field", "source failed"]);
  });
});

describe("F5: the core's own aborts carry a reason the Effect layer reads", () => {
  it("interrupts a held @defer sibling with the internal annotation when a result hook fails the stream", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const sibling = held(log, "later");
    const built = build(
      log,
      incrementalPlugins(),
      {
        Item: {
          value: () => Effect.promise(() => sibling.started.promise).pipe(Effect.as("i")),
          later: () =>
            recording(log, "later", stops, sibling.resource.pipe(Effect.andThen(Effect.never))),
        },
      },
      {
        after: [
          {
            onResult: (payload) => {
              if ("incremental" in payload) {
                throw new Error("result hook failed");
              }
              return undefined;
            },
          },
        ],
      },
    );
    const response = await built.server.handle(
      post(
        { query: "query Failing { item { ... @defer { value } ... @defer { later } } }" },
        { accept: "multipart/mixed" },
      ),
    );
    await expect(response.text()).rejects.toThrow("result hook failed");
    await sibling.releasing.promise;
    const [request] = built.requests;
    expect(abortKindOf(request === undefined ? undefined : signalOf(request)?.reason)).toBe(
      "stream",
    );
    sibling.hold.resolve();
    await built.spanEnded;
    expect(at(log, "later released")).toBeLessThan(at(log, "end graphql Failing"));
    expect(stops).toEqual(["internal"]);
  });

  it("interrupts an orphaned sibling with the internal annotation when a streamed result is never sent", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const sibling = held(log, "slow");
    const built = build(log, incrementalPlugins(), {
      Box: {
        slow: () =>
          recording(log, "slow", stops, sibling.resource.pipe(Effect.andThen(Effect.never))),
        failing: failingField(sibling.started.promise),
      },
    });
    // A client that accepts no multipart: the incremental result is closed unsent (a 406).
    const sent = await send(
      built.server,
      post(
        { query: "query Unsent { item { value ... @defer { later } } box { slow failing } }" },
        { accept: "application/json" },
      ),
    );
    expect(sent.status).toBe(406);
    await sibling.releasing.promise;
    const [request] = built.requests;
    expect(abortKindOf(request === undefined ? undefined : signalOf(request)?.reason)).toBe(
      "unsent",
    );
    sibling.hold.resolve();
    await built.spanEnded;
    expect(at(log, "slow released")).toBeLessThan(at(log, "end graphql Unsent"));
    expect(stops).toEqual(["internal"]);
  });

  it("interrupts the fiber of an abandoned claim's next() with the internal annotation, its reason on the execution's own signal", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const sibling = held(log, "slow");
    let execution: AbortSignal | undefined;
    let entries = 0;
    const built = build(
      log,
      [
        {
          // Catches the nested entry's error and answers with a fallback.
          onExecute: () => async (next) => {
            try {
              return await next();
            } catch {
              return { data: { slow: "fallback" } };
            }
          },
        },
      ],
      {
        Query: {
          slow: (_source: never, _args: unknown, _ctx: unknown, info: GraphQLResolveInfo) => {
            const own: { readonly getAbortSignal?: () => AbortSignal | undefined } = info;
            execution = own.getAbortSignal?.();
            return recording(
              log,
              "slow",
              stops,
              sibling.resource.pipe(Effect.andThen(Effect.never)),
            );
          },
        },
      },
      {
        after: [
          {
            // The second entry is the one around the claim's next(): it runs the default
            // executor (whose resolver forks the fiber), then fails.
            wrapExecution: (_request, run) => {
              entries += 1;
              const entry = entries;
              const result = run();
              if (entry === 2) {
                throw new Error("wrapper failed");
              }
              return result;
            },
          },
        ],
      },
    );
    const sent = await send(built.server, post({ query: "query Abandoned { slow }" }));
    expect(sent.body).toEqual({ data: { slow: "fallback" } });
    await sibling.releasing.promise;
    expect(abortKindOf(execution?.reason)).toBe("abandoned");
    sibling.hold.resolve();
    await until(() => stops.length === 1);
    expect(stops).toEqual(["internal"]);
  });

  it("reads the reason from the core signal on warmed jit, whose resolvers have no execution signal", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    let measured = false;
    const sibling = held(log, "slow");
    const built = build(
      log,
      [jit({ after: 2 })],
      {
        Query: {
          slow: () =>
            measured
              ? recording(log, "slow", stops, sibling.resource.pipe(Effect.andThen(Effect.never)))
              : Effect.succeed("warm"),
        },
      },
      {
        after: [
          {
            // Fails after running the core's entry (jit): the request fails, and the core stops
            // the execution it left running through the core signal.
            wrapExecution: (_request, run) => {
              const result = run();
              if (measured) {
                throw new Error("wrapper failed");
              }
              return result;
            },
          },
        ],
      },
    );
    const query = "query Abandoned { slow }";
    await gql(built.server, query);
    built.spans.length = 0;
    log.length = 0;
    measured = true;
    const pending = send(built.server, post({ query }));
    await sibling.releasing.promise;
    const [, request] = built.requests;
    expect(abortKindOf(request === undefined ? undefined : signalOf(request)?.reason)).toBe(
      "abandoned",
    );
    sibling.hold.resolve();
    expect((await pending).status).toBe(500);
    expect(stops).toEqual(["internal"]);
  });

  it.each([
    { name: "default", plugins: (): ReadonlyArray<Plugin> => [], warmUp: 0 },
    { name: "jit", plugins: (): ReadonlyArray<Plugin> => [jit({ after: 2 })], warmUp: 1 },
    { name: "incremental", plugins: incrementalPlugins, warmUp: 0 },
  ])("keeps ClientAbort for a client that leaves ($name executor)", async ({ plugins, warmUp }) => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    let measured = false;
    const sibling = held(log, "slow");
    const built = build(log, plugins(), {
      Query: {
        slow: () =>
          measured
            ? recording(log, "slow", stops, sibling.resource.pipe(Effect.andThen(Effect.never)))
            : Effect.succeed("warm"),
      },
    });
    const query = "query Left { slow }";
    for (let index = 0; index < warmUp; index += 1) {
      await gql(built.server, query);
    }
    measured = true;
    const controller = new AbortController();
    const pending = built.server.handle(post({ query }, { signal: controller.signal }));
    await sibling.started.promise;
    controller.abort();
    await sibling.releasing.promise;
    sibling.hold.resolve();
    expect((await pending).status).toBe(499);
    await until(() => stops.length === 1);
    expect(stops).toEqual(["client"]);
  });
});
