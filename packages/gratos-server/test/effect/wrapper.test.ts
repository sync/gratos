// effectSchema, fromCause, wrapSubscribe and the guard, on standalone handle(Request), once per
// executor (docs/plan.html M5 "Done when": semantic non-null, return paths, error mapping,
// aborts, fibers, timeouts, guard).
import { Cause, Context, Data, Effect, Match, Predicate, Stream } from "effect";
import { createSourceEventStream, execute, parse, validateSubscriptionArgs } from "graphql";
import type { GraphQLError, GraphQLFieldResolver, GraphQLSchema } from "graphql";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer, gqlError, maskErrors, reportErrors } from "../../src/index.ts";
import type { Plugin, Server } from "../../src/index.ts";
import {
  effect,
  effectSchema,
  makeGuard,
  OperationType,
  ResolverDefect,
  wrapSubscribe,
} from "../../src/effect/index.ts";
import { internals } from "../../src/effect/schema.ts";
import { currentScope, scopeOfRequest } from "../../src/effect/state.ts";
import { flush, gate, gql, post, send } from "../support/http.ts";
import { makeSchema } from "../support/schema.ts";
import { readSse } from "../support/stream.ts";
import { executors, recordingTracer, until } from "./support.ts";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  Predicate.hasProperty(value, Symbol.asyncIterator);

const isIterator = (value: unknown): value is AsyncIterator<unknown> =>
  Predicate.hasProperty(value, "next") && Predicate.isFunction(value.next);

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class Forbidden extends Data.TaggedError("Forbidden")<{ readonly scopes: ReadonlyArray<string> }> {}
type AppError = NotFound | Forbidden;

const failure = Match.type<AppError>().pipe(
  Match.tagsExhaustive({
    NotFound: (error) => gqlError(`${error.id} not found`, 404, { code: "NOT_FOUND" }),
    Forbidden: () => gqlError("Forbidden", 403, { code: "FORBIDDEN" }),
  }),
);

const SDL = `
  type Query {
    value: String
    marked: String
    unmarked: String
    nested: Item
    items: [Item]
    slow: String
    guarded: String
  }
  type Item { value: String }
  type Mutation { write: String, writeTwo: String }
  type Subscription { events: Item, failing(die: Boolean): String, greet: String }
`;

type Resolver = GraphQLFieldResolver<never, unknown>;
type Overrides = Readonly<Record<string, Readonly<Record<string, Resolver>>>>;

/** The context values the tests use: an object (shared or fresh), a primitive, or nothing. */
type TestContext = object | string | undefined;

/** The `extensions.gratos` marker of an Effect field whose success must not be null. */
const NON_NULL = { gratos: { semanticNonNull: true } };

interface Built {
  readonly server: Server;
  readonly schema: GraphQLSchema;
  readonly tracer: ReturnType<typeof recordingTracer>;
  /** The requests that reached onContext, in order. */
  readonly requests: Array<Request>;
}

const resolvers = (overrides: Overrides) => ({
  Query: { value: () => Effect.succeed("v"), ...overrides["Query"] },
  Item: {
    value: (source: { value: string }) => Effect.succeed(source.value),
    ...overrides["Item"],
  },
  ...Object.fromEntries(
    Object.entries(overrides).filter(([name]) => name !== "Query" && name !== "Item"),
  ),
});

/**
 * makeSchema attaches `resolve`; on Subscription it is the source resolver, so it becomes
 * `subscribe`, and each event is resolved as itself (as Grats generates it).
 */
const asSubscriptions = (schema: GraphQLSchema): GraphQLSchema => {
  for (const field of Object.values(schema.getSubscriptionType()?.getFields() ?? {})) {
    if (field.resolve !== undefined) {
      field.subscribe = field.resolve;
      field.resolve = (payload: unknown) => payload;
    }
  }
  return schema;
};

/** Subscribes to `greet` and reads the whole SSE response. */
const greet = async (built: Built) => {
  const response = await built.server.handle(
    post({ query: "subscription { greet }" }, { accept: "text/event-stream" }),
  );
  return readSse(await response.text());
};

async function* generated() {
  yield "hi";
}

/** Subscription sources that are an Effect or an Exit of what graphql-js needs. */
const sources = {
  exit: () => Effect.succeed(Stream.make("hi")),
  sync: () => Effect.sync(() => Stream.make("hi")),
  async: () => Effect.succeed(Stream.make("hi")).pipe(Effect.delay("1 millis")),
  promised: () => Promise.resolve(Effect.succeed(Stream.make("hi"))),
  promisedAsync: () =>
    Promise.resolve(Effect.succeed(Stream.make("hi")).pipe(Effect.delay("1 millis"))),
  iterable: () => Effect.sync(generated),
};

describe.each(executors)("the Effect wrapper ($name executor)", (executor) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const build = (
    overrides: Overrides,
    options: {
      readonly plugins?: ReadonlyArray<Plugin>;
      readonly extensions?: Readonly<Record<string, Readonly<Record<string, typeof NON_NULL>>>>;
      readonly onDefect?: ((defect: ResolverDefect) => void) | undefined;
      readonly mapper?: (error: AppError) => GraphQLError;
      /** The context factory (default: a fresh object per request). */
      readonly context?: () => TestContext;
    } = {},
  ): Built => {
    const tracer = recordingTracer();
    const requests: Array<Request> = [];
    const recorder: Plugin = {
      onContext: (_ctx, request) => {
        requests.push(request);
      },
    };
    const schema = effectSchema(
      asSubscriptions(makeSchema(SDL, resolvers(overrides), options.extensions ?? {})),
      { failure: options.mapper ?? failure, onDefect: options.onDefect },
    );
    const server = createServer({
      schema,
      context: options.context ?? (() => ({})),
      plugins: [
        recorder,
        ...executor.plugins(),
        ...(options.plugins ?? []),
        effect({ context: tracer.context }),
      ],
    });
    return { server, schema, tracer, requests };
  };

  /** Sends the warm-up requests (jit compiles on the second use), then the measured one. */
  const run = async (built: Built, query: string) => {
    for (let index = 0; index < executor.warmUp; index += 1) {
      await gql(built.server, query);
    }
    return gql(built.server, query);
  };

  describe("semantic non-null", () => {
    it("turns a null success of a marked Effect field into a field error", async () => {
      const built = build(
        {
          Query: {
            marked: () => Effect.succeed(null),
            unmarked: () => Effect.succeed(null),
          },
        },
        { extensions: { Query: { marked: NON_NULL } } },
      );
      const sent = await run(built, "{ marked unmarked }");
      expect(sent.body).toEqual({
        data: { marked: null, unmarked: null },
        errors: [
          {
            message: "Cannot return null for semantically non-nullable field.",
            locations: [{ line: 1, column: 3 }],
            path: ["marked"],
          },
        ],
      });
    });

    it("checks the value of an async Effect too", async () => {
      const built = build(
        { Query: { marked: () => Effect.succeed(null).pipe(Effect.delay("1 millis")) } },
        { extensions: { Query: { marked: NON_NULL } } },
      );
      const sent = await run(built, "{ marked }");
      expect(sent.error?.message).toBe("Cannot return null for semantically non-nullable field.");
    });
  });

  describe("return paths", () => {
    it("answers an Exit with no fiber", async () => {
      const built = build({ Query: { value: () => Effect.succeed("exit") } });
      const fork = vi.spyOn(internals, "runForkWith");
      const sent = await run(built, "{ value }");
      expect(sent.body).toEqual({ data: { value: "exit" } });
      expect(fork).not.toHaveBeenCalled();
      expect(built.tracer.named("resolve Query.value")).toEqual([]);
    });

    it("returns a synchronous Effect's value, not a Promise (graphql-js stays synchronous)", () => {
      const built = build({ Query: { value: () => Effect.sync(() => "sync") } });
      const fork = vi.spyOn(internals, "runForkWith");
      const result = execute({ schema: built.schema, document: parse("{ value }") });
      expect("then" in result).toBe(false);
      expect(result).toEqual({ data: { value: "sync" } });
      expect(fork).toHaveBeenCalledTimes(1);
    });

    it("returns a plain value unchanged", () => {
      const built = build({ Query: { value: () => "plain" } });
      const result = execute({ schema: built.schema, document: parse("{ value }") });
      expect(result).toEqual({ data: { value: "plain" } });
    });

    it("answers a guard refusal with no fiber and no span", async () => {
      const guard = makeGuard<AppError>({
        authorize: () => false,
        refuse: () => new Forbidden({ scopes: [] }),
      });
      const resolve = vi.fn(() => Effect.succeed("never"));
      const built = build({
        Query: {
          guarded: () => guard.guard({ scopes: ["admin"], effect: Effect.suspend(resolve) }),
        },
      });
      const fork = vi.spyOn(internals, "runForkWith");
      const sent = await run(built, "{ guarded }");
      expect(sent.error).toMatchObject({ message: "Forbidden", extensions: { code: "FORBIDDEN" } });
      expect(fork).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(built.tracer.named("resolve Query.guarded")).toEqual([]);
    });

    it("runs an async Effect in a fiber, inside a resolver span of the operation span", async () => {
      const built = build({
        Query: { slow: () => Effect.succeed("late").pipe(Effect.delay("1 millis")) },
      });
      const sent = await run(built, "query Slow { slow }");
      expect(sent.body).toEqual({ data: { slow: "late" } });
      const [operation] = built.tracer.named("graphql Slow").slice(-1);
      const [resolver] = built.tracer.named("resolve Query.slow").slice(-1);
      expect(resolver?.parentId).toBe(operation?.spanId);
      expect(resolver?.traceId).toBe(operation?.traceId);
    });

    it("classifies a thenable's value: a Promise of an Effect is run", async () => {
      const built = build({
        Query: { value: () => Promise.resolve(Effect.succeed("from a promise")) },
      });
      const sent = await run(built, "{ value }");
      expect(sent.body).toEqual({ data: { value: "from a promise" } });
    });
  });

  describe("subscription sources", () => {
    it.each(Object.entries(sources))(
      "runs a source that is an Effect or an Exit (%s)",
      async (_name, source) => {
        const built = build({ Subscription: { greet: source } });
        const read = await greet(built);
        expect(read.payloads.map((payload) => payload.data)).toEqual([{ greet: "hi" }]);
        expect(read.names).toEqual(["next", "complete"]);
      },
    );

    it("interrupts a source Effect still running when the client leaves", async () => {
      const started = gate();
      let interrupted = 0;
      const built = build({
        Subscription: {
          greet: () =>
            Effect.sync(() => {
              started.resolve();
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted += 1;
                }),
              ),
            ),
        },
      });
      const controller = new AbortController();
      const pending = built.server.handle(
        post(
          { query: "subscription { greet }" },
          { accept: "text/event-stream", signal: controller.signal },
        ),
      );
      await started.promise;
      controller.abort();
      expect((await pending).status).toBe(499);
      await until(() => interrupted === 1);
    });

    it("maps a source Effect's typed failure", async () => {
      const built = build({
        Subscription: { greet: () => Effect.fail(new NotFound({ id: "src" })) },
      });
      const read = await greet(built);
      expect(read.payloads[0]?.errors?.[0]).toMatchObject({
        message: "src not found",
        extensions: { code: "NOT_FOUND" },
      });
    });
  });

  describe("error mapping", () => {
    it("maps a typed failure with the app's matcher", async () => {
      const built = build({ Query: { value: () => Effect.fail(new NotFound({ id: "o-9" })) } });
      const sent = await run(built, "{ value }");
      expect(sent.error).toMatchObject({
        message: "o-9 not found",
        path: ["value"],
        extensions: { code: "NOT_FOUND", http: { status: 404 } },
      });
    });

    it("counts a tagged error returned as data as an Effect", async () => {
      const built = build({ Query: { value: () => new NotFound({ id: "data" }) } });
      const sent = await run(built, "{ value }");
      expect(sent.error).toMatchObject({ message: "data not found" });
    });

    it("masks a defect, which reportErrors sees as a ResolverDefect with the pretty cause", async () => {
      const reported: Array<GraphQLError> = [];
      const built = build(
        {
          Query: {
            value: () => Effect.die(new Error("kaboom")).pipe(Effect.delay("1 millis")),
          },
        },
        {
          plugins: [
            reportErrors((error) => {
              reported.push(error);
            }),
            maskErrors(),
          ],
        },
      );
      const sent = await run(built, "{ value }");
      expect(sent.error).toEqual({
        message: "Unexpected error.",
        locations: [{ line: 1, column: 3 }],
        path: ["value"],
      });
      const original = reported.at(-1)?.originalError;
      expect(original).toBeInstanceOf(ResolverDefect);
      expect(original?.message).toBe("kaboom");
      expect(original?.stack).toContain("kaboom");
    });

    it("maps the typed error of a Fail plus Die and reports the defect", async () => {
      const defects: Array<ResolverDefect> = [];
      const built = build(
        {
          Query: {
            value: () =>
              Effect.failCause(
                Cause.combine(
                  Cause.fail(new NotFound({ id: "both" })),
                  Cause.die(new Error("also")),
                ),
              ),
          },
        },
        {
          onDefect: (defect) => {
            defects.push(defect);
          },
        },
      );
      const sent = await run(built, "{ value }");
      expect(sent.error).toMatchObject({ message: "both not found" });
      expect(defects.length).toBe(1 + executor.warmUp);
      expect(defects[0]?.defect).toEqual(new Error("also"));
    });

    it("masks an interrupt that is not a client abort", async () => {
      const built = build(
        { Query: { value: () => Effect.interrupt.pipe(Effect.delay("1 millis")) } },
        { plugins: [maskErrors()] },
      );
      const sent = await run(built, "{ value }");
      expect(sent.error?.message).toBe("Unexpected error.");
    });

    it("maps a typed stream failure, and masks a stream defect", async () => {
      const built = build(
        {
          Subscription: {
            failing: (_source, args: { readonly die?: boolean }) =>
              args.die === true
                ? Stream.die(new Error("stream bug"))
                : Stream.fail(new NotFound({ id: "s" })),
          },
        },
        { plugins: [maskErrors()] },
      );
      const subscribe = async (query: string) => {
        const response = await built.server.handle(
          post({ query }, { accept: "text/event-stream" }),
        );
        return readSse(await response.text());
      };
      const typed = await subscribe("subscription { failing }");
      expect(typed.names).toEqual(["next", "complete"]);
      expect(typed.payloads[0]?.errors?.[0]).toMatchObject({
        message: "s not found",
        extensions: { code: "NOT_FOUND" },
      });
      // A defect is not a typed failure: the client gets the masked message.
      const defect = await subscribe("subscription { failing(die: true) }");
      expect(defect.names).toEqual(["next", "complete"]);
      expect(defect.payloads[0]?.errors?.[0]?.message).toBe("Unexpected error.");
    });
  });

  describe("aborts", () => {
    it("interrupts a query's fibers when the client leaves, and reports nothing", async () => {
      const reported: Array<GraphQLError> = [];
      let interrupted = 0;
      let hang = false;
      const started = gate();
      const built = build(
        {
          Query: {
            slow: () =>
              hang
                ? Effect.sync(() => {
                    started.resolve();
                  }).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        interrupted += 1;
                      }),
                    ),
                  )
                : Effect.succeed("warm").pipe(Effect.delay("1 millis")),
          },
        },
        {
          plugins: [
            reportErrors((error) => {
              reported.push(error);
            }),
          ],
        },
      );
      for (let index = 0; index < executor.warmUp; index += 1) {
        await gql(built.server, "{ slow }");
      }
      hang = true;
      const controller = new AbortController();
      const pending = send(
        built.server,
        post({ query: "{ slow }" }, { signal: controller.signal }),
      );
      await started.promise;
      controller.abort();
      const sent = await pending;
      expect(interrupted).toBe(1);
      // graphql-js answers the abort with a 499; jit ignores the signal and still answers, with
      // the cancelled() sentinel at the field, which reportErrors skips.
      expect(sent.status).toBe(executor.name === "jit" ? 200 : 499);
      expect(reported).toEqual([]);
      expect(built.tracer.open()).toEqual([]);
    });

    it("lets a mutation finish after its client left", async () => {
      const writes: Array<string> = [];
      const hold = gate();
      const started = gate();
      let holding = false;
      const built = build({
        Mutation: {
          write: () =>
            Effect.gen(function* () {
              if (holding) {
                started.resolve();
                yield* Effect.promise(() => hold.promise);
              }
              writes.push("write");
              return "done";
            }),
        },
      });
      for (let index = 0; index < executor.warmUp; index += 1) {
        await gql(built.server, "mutation { write }");
      }
      writes.length = 0;
      holding = true;
      const controller = new AbortController();
      const pending = built.server.handle(
        post({ query: "mutation { write }" }, { signal: controller.signal }),
      );
      await started.promise;
      controller.abort();
      await flush();
      hold.resolve();
      await pending;
      expect(writes).toEqual(["write"]);
    });
  });

  describe("request scopes", () => {
    it("keeps a mutation's scope when a concurrent query shares its context object", async () => {
      const shared = {};
      const hold = gate();
      const started = gate();
      let holding = false;
      const guard = makeGuard<AppError>({
        authorize: () => true,
        refuse: () => new Forbidden({ scopes: [] }),
        timeout: "20 millis",
      });
      const built = build(
        {
          Query: { slow: () => Effect.succeed("q").pipe(Effect.delay("1 millis")) },
          Mutation: {
            write: () =>
              Effect.gen(function* () {
                if (holding) {
                  started.resolve();
                  yield* Effect.promise(() => hold.promise);
                }
                return "one";
              }),
            // Past the query timeout: only a mutation's scope (no timeout) lets it commit.
            writeTwo: () =>
              guard.guard({ effect: Effect.succeed("two").pipe(Effect.delay("40 millis")) }),
          },
        },
        { context: () => shared },
      );
      const MUTATION = "mutation M { first: write second: writeTwo }";
      for (let index = 0; index < executor.warmUp; index += 1) {
        await gql(built.server, MUTATION);
        await gql(built.server, "query Q { slow }");
      }
      built.tracer.clear();
      holding = true;
      const mutation = gql(built.server, MUTATION);
      await started.promise;
      // The query binds its own scope while the mutation is between its two fields.
      const query = await gql(built.server, "query Q { slow }");
      expect(query.body).toEqual({ data: { slow: "q" } });
      hold.resolve();
      const sent = await mutation;
      expect(sent.body).toEqual({ data: { first: "one", second: "two" } });
      const [operation] = built.tracer.named("graphql M");
      const [second] = built.tracer.named("resolve Mutation.writeTwo");
      expect(second?.parentId).toBe(operation?.spanId);
    });

    it.each([
      ["a primitive context", () => "ctx"],
      ["an undefined context", () => undefined],
    ])("finds the scope with %s", async (_name, context) => {
      const built = build(
        { Query: { slow: () => Effect.succeed("late").pipe(Effect.delay("1 millis")) } },
        { context },
      );
      const sent = await run(built, "query P { slow }");
      expect(sent.body).toEqual({ data: { slow: "late" } });
      const [operation] = built.tracer.named("graphql P").slice(-1);
      const [resolver] = built.tracer.named("resolve Query.slow").slice(-1);
      expect(resolver?.parentId).toBe(operation?.spanId);
    });

    it.runIf(executor.name === "incremental")(
      "finds the scope of deferred work when every root field is deferred",
      async () => {
        const built = build({
          Query: { slow: () => Effect.succeed("late").pipe(Effect.delay("1 millis")) },
        });
        const response = await built.server.handle(
          post({ query: "query D { ... @defer { slow } }" }, { accept: "multipart/mixed" }),
        );
        expect(await response.text()).toContain('"slow":"late"');
        const [operation] = built.tracer.named("graphql D");
        const [resolver] = built.tracer.named("resolve Query.slow");
        expect(resolver?.parentId).toBe(operation?.spanId);
      },
    );

    it("finds the scope with no context factory", async () => {
      const tracer = recordingTracer();
      const schema = effectSchema(
        makeSchema(
          SDL,
          resolvers({
            Query: { slow: () => Effect.succeed("late").pipe(Effect.delay("1 millis")) },
          }),
        ),
        { failure },
      );
      const server = createServer({
        schema,
        plugins: [...executor.plugins(), effect({ context: tracer.context })],
      });
      for (let index = 0; index <= executor.warmUp; index += 1) {
        expect((await gql(server, "query P { slow }")).body).toEqual({ data: { slow: "late" } });
      }
      const [operation] = tracer.named("graphql P").slice(-1);
      const [resolver] = tracer.named("resolve Query.slow").slice(-1);
      expect(resolver?.parentId).toBe(operation?.spanId);
    });
  });

  describe("fibers", () => {
    it("leaves the request scope with no fiber after N subscription events", async () => {
      let maxFibers = 0;
      const built = build({
        Subscription: {
          events: () => Stream.make({ value: "a" }, { value: "b" }, { value: "c" }),
        },
        Item: {
          value: (source: { value: string }) =>
            Effect.sync(() => {
              maxFibers = Math.max(maxFibers, currentScope()?.fibers.size ?? 0);
              return source.value;
            }).pipe(Effect.delay("1 millis")),
        },
      });
      const response = await built.server.handle(
        post({ query: "subscription { events { value } }" }, { accept: "text/event-stream" }),
      );
      const read = readSse(await response.text());
      expect(read.payloads.map((payload) => payload.data)).toEqual([
        { events: { value: "a" } },
        { events: { value: "b" } },
        { events: { value: "c" } },
      ]);
      const request = built.requests.at(-1);
      expect(maxFibers).toBe(1);
      expect(request === undefined ? undefined : scopeOfRequest(request)?.fibers.size).toBe(0);
    });
  });

  describe("timeouts", () => {
    const guard = makeGuard<AppError>({
      authorize: () => true,
      refuse: () => new Forbidden({ scopes: [] }),
      timeout: "20 millis",
    });

    it("dies a slow query with GuardTimeout: a 504 that never reaches the app's matcher", async () => {
      const mapper = vi.fn(failure);
      const built = build(
        { Query: { slow: () => guard.guard({ effect: Effect.never }) } },
        { mapper },
      );
      const sent = await run(built, "{ slow }");
      expect(sent.error).toMatchObject({
        message: "Request timeout",
        path: ["slow"],
        extensions: { http: { status: 504 } },
      });
      expect(mapper).not.toHaveBeenCalled();
    });

    it("lets a slow mutation commit", async () => {
      const built = build({
        Mutation: {
          write: () =>
            guard.guard({ effect: Effect.succeed("committed").pipe(Effect.delay("60 millis")) }),
        },
      });
      const sent = await run(built, "mutation { write }");
      expect(sent.body).toEqual({ data: { write: "committed" } });
    });

    it("lets a subscription outlive the timeout, and bounds only its setup", async () => {
      const mapper = vi.fn(failure);
      let slowSetup = false;
      const built = build(
        {
          Subscription: {
            events: () =>
              guard.guardStream({
                stream: Effect.gen(function* () {
                  if (slowSetup) {
                    yield* Effect.never;
                  }
                  return Stream.make({ value: "1" }, { value: "2" }, { value: "3" }).pipe(
                    Stream.tap(() => Effect.sleep("15 millis")),
                  );
                }),
              }),
          },
        },
        { mapper },
      );
      const subscribe = async () => {
        const response = await built.server.handle(
          post({ query: "subscription { events { value } }" }, { accept: "text/event-stream" }),
        );
        return readSse(await response.text());
      };
      const long = await subscribe();
      expect(long.payloads.map((payload) => payload.data)).toEqual([
        { events: { value: "1" } },
        { events: { value: "2" } },
        { events: { value: "3" } },
      ]);
      slowSetup = true;
      const timedOut = await subscribe();
      expect(timedOut.names).toEqual(["next", "complete"]);
      expect(timedOut.payloads[0]?.errors?.[0]).toMatchObject({
        message: "Request timeout",
        extensions: { http: { status: 504 } },
      });
      expect(mapper).not.toHaveBeenCalled();
    });
  });
});

describe("wrapSubscribe", () => {
  it("returns a request-local iterable whose iterator is always the same one", async () => {
    const events: Array<string> = [];
    const schema = makeSchema("type Query { a: String } type Subscription { never: String }");
    const field = schema.getSubscriptionType()?.getFields()["never"];
    if (field === undefined) {
      throw new Error("no field");
    }
    field.subscribe = wrapSubscribe(
      () =>
        Stream.unwrap(
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("acquired");
            }),
            () =>
              Effect.sync(() => {
                events.push("released");
              }),
          ).pipe(Effect.as(Stream.never)),
        ),
      { failure },
    );
    // graphql-js hands back the source iterable the subscribe resolver returned.
    const validated = validateSubscriptionArgs({
      schema,
      document: parse("subscription { never }"),
    });
    if (!("schema" in validated)) {
      throw new Error("invalid subscription");
    }
    const source = await createSourceEventStream(validated);
    if (!isAsyncIterable(source)) {
      throw new Error("not an AsyncIterable");
    }
    expect(events).toEqual([]);
    const pulling: unknown = source[Symbol.asyncIterator]();
    const closing: unknown = source[Symbol.asyncIterator]();
    expect(closing).toBe(pulling);
    if (!isIterator(pulling)) {
      throw new Error("not an AsyncIterator");
    }
    // A pull that never settles by itself; return() on "another" iterator closes this one.
    const pending = pulling.next();
    await until(() => events.includes("acquired"));
    await pulling.return?.();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(events).toEqual(["acquired", "released"]);
  });
});

describe("the guard without a server", () => {
  const guard = makeGuard<AppError>({
    authorize: ({ scopes }) => scopes.includes("ok"),
    refuse: () => new Forbidden({ scopes: [] }),
    flags: ["beta"],
    timeout: "10 millis",
  });

  it("refuses with an Exit, and checks flags", () => {
    const refused = guard.guard({ scopes: ["nope"], effect: Effect.succeed(1) });
    expect(Effect.runSyncExit(refused)._tag).toBe("Failure");
    const flagged = guard.guard({ flag: "gamma", effect: Effect.succeed(1) });
    expect(Effect.runSyncExit(flagged)._tag).toBe("Failure");
    expect(
      Effect.runSync(guard.guard({ scopes: ["ok"], flag: "beta", effect: Effect.succeed(1) })),
    ).toBe(1);
  });

  it("times out as a query by default, and never as a mutation", async () => {
    const slow = guard.guard({ effect: Effect.succeed("done").pipe(Effect.delay("30 millis")) });
    const asQuery = await Effect.runPromiseExit(slow);
    expect(asQuery._tag).toBe("Failure");
    const asMutation = await Effect.runPromise(
      slow.pipe(Effect.provideService(OperationType, "mutation")),
    );
    expect(asMutation).toBe("done");
  });

  it("reads the OperationType reference the effect() plugin writes", () => {
    expect(Context.get(Context.empty(), OperationType)).toBe("query");
  });
});
