// The operation span ends after every span it parents (docs/plan.html F5, "Done when"), each case on
// the executor it is about. Each test records start, finalizer and span-end events in one log and
// orders them with gates (deferreds): no sleeps, no wall-clock comparisons.
import { Cause, Context, Effect, Exit, Fiber, Predicate, Stream, Tracer } from "effect";
import type { Scope } from "effect";
import { HttpServerError } from "effect/http";
import { Kind, parse } from "graphql";
import type {
  GraphQLError,
  GraphQLFieldResolver,
  GraphQLResolveInfo,
  GraphQLSchema,
  OperationDefinitionNode,
} from "graphql";
import { describe, expect, it, onTestFinished } from "vitest";

import { abortKindOf, abortReason } from "../../src/core/abortReason.ts";
import {
  createServer,
  incremental,
  isCancelled,
  jit,
  reportErrors,
  signalOf,
} from "../../src/index.ts";
import type { Plugin, Server } from "../../src/index.ts";
import { effect, effectSchema, fromCause } from "../../src/effect/index.ts";
import { RequestEnded } from "../../src/effect/errors.ts";
import { tracked } from "../../src/effect/schema.ts";
import type { RequestScope } from "../../src/effect/state.ts";
import { flush, gate, gql, post, send } from "../support/http.ts";
import { makeSchema } from "../support/schema.ts";
import { readApolloMultipart, readSse, readUntil } from "../support/stream.ts";
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
  /** Resolves once onSpanEnd has run for this span. */
  readonly reported = gate();

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
  /**
   * Resolves with the latest operation span once onSpanEnd has run for that span: keyed to the
   * request measured, not to a warm-up request before it.
   */
  readonly spanEnded: () => Promise<LoggedSpan>;
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
          spans.find((candidate) => candidate === span)?.reported.resolve();
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
    spanEnded: async () => {
      const operation = spans.findLast((span) => span.name.startsWith("graphql "));
      if (operation === undefined) {
        throw new Error("no operation span");
      }
      await operation.reported.promise;
      return operation;
    },
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
 * its finalizer runs, which then waits for `hold` (released when the test finishes, at the latest).
 * Each step is logged under `name`.
 */
const held = (log: Array<string>, name: string, onAcquire: () => void = () => {}) => {
  const started = gate();
  const releasing = gate();
  const hold = gate();
  // A failing assertion never leaves the finalizer suspended; tests still release it explicitly
  // where the release sets the order of events.
  onTestFinished(() => {
    hold.resolve();
  });
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
    await built.spanEnded();
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

/** A Stream whose one pull never ends, logging `${name} pull exit` once its fiber exits. */
const pendingPull = (log: Array<string>, name: string): Stream.Stream<never> =>
  Stream.fromEffect(
    Effect.never.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          log.push(`${name} pull exit`);
        }),
      ),
    ),
  );

/** How many times `entry` is in the log. */
const count = (log: ReadonlyArray<string>, entry: string): number =>
  log.filter((logged) => logged === entry).length;

describe("F5: a source aborts the request during a pull's synchronous start (subscription path)", () => {
  // The client's abort inside the pull closes the stream at once, and the iterator's return()
  // reaches Stream.toAsyncIterableWith re-entrantly, while next() is still forking the pull's
  // fiber. tracked() waits for that next() to return before it closes the inner iterator, which
  // then interrupts the fiber and waits for the release (see "upstream facts" below).
  it.each([
    {
      pull: "first",
      events: 0,
      streamOf: (log: Array<string>, resource: Effect.Effect<void, never, Scope.Scope>) =>
        Stream.unwrap(resource.pipe(Effect.as(pendingPull(log, "source")))),
    },
    {
      pull: "a later",
      events: 1,
      // The first pull's batch runs out; the next pull forks again and aborts in its acquire.
      streamOf: (log: Array<string>, resource: Effect.Effect<void, never, Scope.Scope>) =>
        Stream.make("first").pipe(
          Stream.concat(Stream.unwrap(resource.pipe(Effect.as(pendingPull(log, "source"))))),
        ),
    },
  ])(
    "runs the source's finalizer once, before the span ends, and settles the pull's fiber ($pull pull)",
    async ({ events, streamOf }) => {
      const log: Array<string> = [];
      const controller = new AbortController();
      const acquired = held(log, "source", () => {
        controller.abort();
      });
      const built = build(log, [], {
        Subscription: { source: () => streamOf(log, acquired.resource) },
      });
      const response = await built.server.handle(
        post(
          { query: "subscription Pulled { source }" },
          { accept: "text/event-stream", signal: controller.signal },
        ),
      );
      // Reading pulls the source: it acquires, aborts the request, and the body ends.
      expect(readSse(await response.text()).names).toEqual(Array<string>(events).fill("next"));
      await acquired.releasing.promise;
      await flush();
      const [operation] = built.operations();
      expect(operation?.ended).toBe(false);
      acquired.hold.resolve();
      await built.spanEnded();
      // The pull's fiber was interrupted (it never leaks), then the scope ran the release.
      expect(at(log, "source pull exit")).toBeLessThan(at(log, "source finalizer"));
      expect(at(log, "source released")).toBeLessThan(at(log, "end graphql Pulled"));
      expect(count(log, "source finalizer")).toBe(1);
      expect(count(log, "end graphql Pulled")).toBe(1);
      expect(operation?.outcome).toBe("cancel");
      expect(operation?.endCalls).toBe(1);
      expect(built.endCount()).toBe(1);
    },
  );
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
    await built.spanEnded();
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
    // The warm-up's span has ended before the measured request starts.
    await built.spanEnded();
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
    const operation = await built.spanEnded();
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
    await built.spanEnded();
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
    async ({ name, plugins, warmUp }) => {
      const log: Array<string> = [];
      const stops: Array<Stop> = [];
      let measured = false;
      // Whether the measured resolver ran with info.getAbortSignal (graphql-js) or without (jit).
      const signals: Array<boolean> = [];
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
          slow: (_source: unknown, _args: unknown, _context: unknown, info: GraphQLResolveInfo) => {
            if (!measured) {
              return Effect.succeed("warm");
            }
            signals.push("getAbortSignal" in info);
            return recording(
              log,
              "slow",
              stops,
              sibling.resource.pipe(
                Effect.andThen(Effect.promise(() => failed.promise)),
                Effect.as("slow"),
              ),
            );
          },
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
      // The measured request ran on the executor named: graphql-jit gives no execution signal.
      expect(signals).toEqual([name !== "jit"]);
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
    // Event 1 carries its non-null error; event 2 is the source's own error, before complete.
    expect(events.payloads.map((payload) => payload.errors?.map((error) => error.message))).toEqual(
      [["failing field"], ["source failed"]],
    );
    const [request] = built.requests;
    expect(abortKindOf(request === undefined ? undefined : signalOf(request)?.reason)).toBe(
      "source",
    );
    await flush();
    const [operation] = built.operations();
    expect(operation?.ended).toBe(false);
    sibling.hold.resolve();
    await built.spanEnded();
    expect(at(log, "slow released")).toBeLessThan(at(log, "end graphql Failing"));
    expect(operation?.outcome).toBe("error");
    expect(operation?.endCalls).toBe(1);
    expect(stops).toEqual(["internal"]);
    expect(built.reported).toEqual(["failing field", "source failed"]);
  });
});

describe("F5: the core's own aborts carry a reason the Effect layer reads", () => {
  it.each([
    { annotation: "RequestEnded", interrupt: RequestEnded.annotation, cancelled: true },
    {
      annotation: "ClientAbort",
      interrupt: HttpServerError.ClientAbort.annotation,
      cancelled: true,
    },
    { annotation: "no", interrupt: undefined, cancelled: false },
  ])(
    "maps an interrupt with $annotation annotation through fromCause",
    async ({ interrupt, cancelled }) => {
      const fiber = Effect.runFork(Effect.never);
      fiber.interruptUnsafe(undefined, interrupt);
      const exit = await Effect.runPromise(Fiber.await(fiber));
      const error = Exit.isFailure(exit)
        ? fromCause(exit.cause, { failure, isFailure })
        : undefined;
      expect(isCancelled(error)).toBe(cancelled);
      // Any other interrupt is a defect, as before.
      expect(Predicate.isTagged(error, "ResolverDefect")).toBe(!cancelled);
    },
  );

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
    await built.spanEnded();
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
    await built.spanEnded();
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
    // Whether the measured resolver ran with info.getAbortSignal (graphql-js) or without (jit).
    const signals: Array<boolean> = [];
    const sibling = held(log, "slow");
    const built = build(
      log,
      [jit({ after: 2 })],
      {
        Query: {
          slow: (_source: unknown, _args: unknown, _context: unknown, info: GraphQLResolveInfo) => {
            if (!measured) {
              return Effect.succeed("warm");
            }
            signals.push("getAbortSignal" in info);
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
    // The measured request ran on graphql-jit: its resolver had no execution signal.
    expect(signals).toEqual([false]);
    expect(stops).toEqual(["internal"]);
  });

  it.each([
    { name: "default", plugins: (): ReadonlyArray<Plugin> => [], warmUp: 0 },
    { name: "jit", plugins: (): ReadonlyArray<Plugin> => [jit({ after: 2 })], warmUp: 1 },
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

  it("keeps ClientAbort for a client that leaves after the initial payload (incremental executor)", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const sibling = held(log, "later");
    const built = build(log, incrementalPlugins(), {
      Item: {
        later: () =>
          recording(log, "later", stops, sibling.resource.pipe(Effect.andThen(Effect.never))),
      },
    });
    const controller = new AbortController();
    const response = await built.server.handle(
      post(
        { query: "query Left { item { value ... @defer { later } } }" },
        { accept: "multipart/mixed", signal: controller.signal },
      ),
    );
    // An incremental response: the default executor would have answered with one JSON body.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^multipart\/mixed/);
    if (response.body === null) {
      throw new Error("no body");
    }
    const { text, reader } = await readUntil(
      response.body,
      (read) => readApolloMultipart(read).parts.length > 0,
    );
    expect(readApolloMultipart(text).parts).toMatchObject([
      { data: { item: { value: "i" } }, hasNext: true },
    ]);
    // The deferred work runs on the next pull; the client leaves once its resolver has started.
    const rest = reader.read();
    await sibling.started.promise;
    controller.abort();
    await sibling.releasing.promise;
    sibling.hold.resolve();
    expect((await rest).done).toBe(true);
    await until(() => stops.length === 1);
    expect(stops).toEqual(["client"]);
  });

  it("keeps ClientAbort for a client that leaves with a reason the core made for another request", async () => {
    const log: Array<string> = [];
    const stops: Array<Stop> = [];
    const sibling = held(log, "slow");
    const built = build(log, [], {
      Query: {
        slow: () =>
          recording(log, "slow", stops, sibling.resource.pipe(Effect.andThen(Effect.never))),
      },
    });
    const controller = new AbortController();
    const pending = built.server.handle(
      post({ query: "query Left { slow }" }, { signal: controller.signal }),
    );
    await sibling.started.promise;
    // The client's own reason is any value: here one the core made for another request's unsent
    // result. Its kind is the other request's; this request's client still left.
    const reused = abortReason("unsent");
    expect(abortKindOf(reused)).toBe("unsent");
    controller.abort(reused);
    await sibling.releasing.promise;
    sibling.hold.resolve();
    expect((await pending).status).toBe(499);
    await until(() => stops.length === 1);
    expect(stops).toEqual(["client"]);
  });
});

/** A bound request scope, for tracked() on its own. */
const boundScope = (): RequestScope => {
  const [operation] = parse("subscription Pulled { source }").definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operation === undefined) {
    throw new Error("no operation");
  }
  return {
    operations: new Set([operation]),
    context: Context.empty(),
    fibers: new Set(),
    starts: new Set(),
    streams: new Set(),
    interruptOnAbort: true,
    signal: undefined,
    stopped: undefined,
    spanEnded: () => {},
  };
};

/**
 * A stub inner iterator that logs its calls. Its `next()` runs `during` synchronously (where a
 * test closes the tracked iterator re-entrantly), then returns; `closed` holds its `return()` and
 * `throw()` open.
 */
const stubIterator = (
  log: Array<string>,
  during: () => void,
  closed: Promise<void> = Promise.resolve(),
) => {
  const calls = { next: 0 };
  const iterator: AsyncIterator<string> = {
    next: () => {
      calls.next += 1;
      log.push("inner next");
      during();
      log.push("inner next returned");
      return Promise.resolve({ done: false, value: "a" });
    },
    return: () => {
      log.push("inner return");
      return closed.then(() => ({ done: true, value: undefined }));
    },
    throw: () => {
      log.push("inner throw");
      return closed.then(() => ({ done: true, value: undefined }));
    },
  };
  return { calls, iterator };
};

describe("F5: tracked() waits for a pull's synchronous start before it closes the iterator", () => {
  it("(a) calls the inner return() of a re-entrant return() only once next() has returned", async () => {
    const log: Array<string> = [];
    const scope = boundScope();
    let returned: Promise<IteratorResult<string>> | undefined;
    const { iterator } = stubIterator(log, () => {
      returned = wrapped.return?.();
    });
    const wrapped = tracked(iterator, scope);
    const pulled = wrapped.next();
    expect(log).toEqual(["inner next", "inner next returned"]);
    expect(scope.streams.size).toBe(1);
    expect(await returned).toEqual({ done: true, value: undefined });
    expect(log).toEqual(["inner next", "inner next returned", "inner return"]);
    expect(scope.streams.size).toBe(0);
    await pulled;
  });

  it("(b) calls the inner return() of any other return() in the same tick (pinning)", async () => {
    const log: Array<string> = [];
    const scope = boundScope();
    const { iterator } = stubIterator(log, () => {});
    const wrapped = tracked(iterator, scope);
    await wrapped.next();
    const returned = wrapped.return?.();
    expect(log).toEqual(["inner next", "inner next returned", "inner return"]);
    await returned;
    expect(scope.streams.size).toBe(0);
  });

  it("(c) releases the gate when the inner next() throws synchronously", async () => {
    const log: Array<string> = [];
    const scope = boundScope();
    let returned: Promise<IteratorResult<string>> | undefined;
    let settled = false;
    const iterator: AsyncIterator<string> = {
      next: () => {
        log.push("inner next");
        returned = wrapped.return?.();
        void returned?.then(() => {
          settled = true;
        });
        log.push("inner next throws");
        throw new Error("pull failed");
      },
      return: () => {
        log.push("inner return");
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    const wrapped = tracked(iterator, scope);
    await expect(wrapped.next()).rejects.toThrow("pull failed");
    await flush();
    // The re-entrant return() went on once the throw left the stack.
    expect(settled).toBe(true);
    expect(log).toEqual(["inner next", "inner next throws", "inner return"]);
    expect(scope.streams.size).toBe(0);
  });

  it("(d) resolves a next() called while the return is in progress as done, without the inner next()", async () => {
    const log: Array<string> = [];
    const scope = boundScope();
    const hold = gate();
    let returned: Promise<IteratorResult<string>> | undefined;
    const { calls, iterator } = stubIterator(
      log,
      () => {
        returned = wrapped.return?.();
      },
      hold.promise,
    );
    const wrapped = tracked(iterator, scope);
    const pulled = wrapped.next();
    // Before the waiting return() has called the inner one, then while that is held open.
    const early = wrapped.next();
    await flush();
    expect(log).toEqual(["inner next", "inner next returned", "inner return"]);
    const late = wrapped.next();
    expect(await early).toEqual({ done: true, value: undefined });
    expect(await late).toEqual({ done: true, value: undefined });
    expect(calls.next).toBe(1);
    hold.resolve();
    await returned;
    await pulled;
    expect(calls.next).toBe(1);
  });

  it("(e) gates a re-entrant throw() the same way", async () => {
    const log: Array<string> = [];
    const scope = boundScope();
    let thrown: Promise<IteratorResult<string>> | undefined;
    const { iterator } = stubIterator(log, () => {
      thrown = wrapped.throw?.(new Error("closed"));
    });
    const wrapped = tracked(iterator, scope);
    const pulled = wrapped.next();
    expect(log).toEqual(["inner next", "inner next returned"]);
    expect(await thrown).toEqual({ done: true, value: undefined });
    expect(log).toEqual(["inner next", "inner next returned", "inner throw"]);
    expect(scope.streams.size).toBe(0);
    await pulled;
  });
});

// Upstream facts (docs/plan.html F3's style, test/jit.test.ts): the raw library behaviour behind a
// workaround. It fails when Effect changes the behaviour, and its message names the workaround to
// review then.
describe("upstream facts", () => {
  it("Stream.toAsyncIterableWith resolves a re-entrant return() before the release has finished (workaround: tracked()'s first-pull gate)", async () => {
    const log: Array<string> = [];
    const hold = gate();
    onTestFinished(() => {
      hold.resolve();
    });
    let returned: Promise<IteratorResult<never>> | undefined;
    const iterator: AsyncIterator<never> = Stream.toAsyncIterableWith(
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.sync(() => {
            // Re-entrantly, inside the first pull's synchronous start.
            returned = iterator.return?.();
          }),
          () =>
            Effect.sync(() => {
              log.push("release");
            }).pipe(
              Effect.andThen(Effect.promise(() => hold.promise)),
              Effect.andThen(
                Effect.sync(() => {
                  log.push("released");
                }),
              ),
            ),
        ).pipe(Effect.as(Stream.never)),
      ),
      Context.empty(),
    )[Symbol.asyncIterator]();
    void iterator.next();
    await returned;
    log.push("returned");
    expect(
      log,
      "An upstream fact changed: review the workaround in src/effect/schema.ts, tracked() (the first-pull gate)",
    ).toEqual(["release", "returned"]);
  });
});
