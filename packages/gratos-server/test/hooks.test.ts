// The hook contract (docs/plan.html M4a, "Contract types"): a test for each hook.
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter, EventEmitterAsyncResource } from "node:events";

import { GraphQLError, legacyExecuteIncrementally } from "graphql";
import type { ExecutionResult, OperationDefinitionNode } from "graphql";
import { describe, expect, it, vi } from "vitest";

import { createServer, gqlError, incremental, signalOf } from "../src/index.ts";
import type { Executor, Phase, Plugin, Server } from "../src/index.ts";
import { flush, gate, gql, post, send, URL_ } from "./support/http.ts";
import type { Sent } from "./support/http.ts";
import { basicSchema, makeSchema } from "./support/schema.ts";
import { readUntil } from "./support/stream.ts";

const silent = { warn: () => {}, error: () => {} };
const answer42: Executor = () => ({ data: { count: 42 } });
const delegate: Executor = (next) => next();

describe("onServer", () => {
  it("runs once at startup with the schema and control", () => {
    const schema = basicSchema();
    const onServer = vi.fn();
    const server = createServer({ schema, plugins: [{ onServer }] });
    expect(onServer).toHaveBeenCalledTimes(1);
    expect(onServer.mock.calls[0]?.[0].schema).toBe(schema);
    expect(onServer.mock.calls[0]?.[0].control).toBe(server.control);
  });

  it("can replace the schema; an async hook delays requests until it is done", async () => {
    const next = basicSchema({ Query: { count: () => 2 } });
    const started = gate();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onServer: async ({ control }) => {
            await started.promise;
            control.replaceSchema(next);
          },
        },
      ],
    });
    const pending = gql(server, "{ count }");
    started.resolve();
    expect((await pending).body).toEqual({ data: { count: 2 } });
    expect(server.control.generation()).toBe(1);
  });

  it("once an async startup is done, a request keeps the schema it pinned at handle() entry", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onServer: () => Promise.resolve() }],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
    // Started before replaceSchema: it finishes on generation 0.
    const pending = gql(server, "{ count }");
    server.control.replaceSchema(basicSchema({ Query: { count: () => 2 } }));
    expect((await pending).body).toEqual({ data: { count: 1 } });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 2 } });
  });

  it("a synchronous throw fails createServer", () => {
    expect(() =>
      createServer({
        schema: basicSchema(),
        plugins: [
          {
            onServer: () => {
              throw new Error("bad plugin");
            },
          },
        ],
      }),
    ).toThrow("bad plugin");
  });

  it("an async failure answers requests with a 500", async () => {
    const server = createServer({
      schema: basicSchema(),
      logger: silent,
      plugins: [{ onServer: () => Promise.reject(new Error("bad plugin")) }],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(500);
    expect(sent.error?.message).toBe("Unexpected error.");
  });
});

describe("onRequest", () => {
  it("runs first and can answer the request; onResponse still runs", async () => {
    const onResponse = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onRequest: (request) =>
            request.method === "GET" ? new Response("ok", { status: 200 }) : undefined,
        },
        { onResponse },
      ],
    });
    const response = await server.handle(new Request(URL_));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect((await gql(server, "{ count }")).status).toBe(200);
  });
});

describe("onParams", () => {
  it("can replace the params", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onParams: (params) => ({ ...params, query: "{ hello }" }) }],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { hello: "hello world" } });
  });

  it("runs before the no-query check (a hash-only request can get a query)", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onParams: (params) =>
            params.query === undefined ? { ...params, query: "{ count }" } : undefined,
        },
      ],
    });
    const sent = await send(server, post({ extensions: { id: "x" } }));
    expect(sent.body).toEqual({ data: { count: 1 } });
  });

  it("a throw becomes a 400 GraphQL error response", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onParams: () => {
            throw new Error("bad params");
          },
        },
      ],
    });
    const sent = await gql(server, "{ count }", { accept: "application/json" });
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ errors: [{ message: "bad params" }] });
  });

  it("a thrown GraphQLError keeps its extensions", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onParams: () => Promise.reject(new GraphQLError("nope", { extensions: { code: "X" } })),
        },
      ],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ errors: [{ message: "nope", extensions: { code: "X" } }] });
  });

  it("a throw is a 400 even when the error carries another status (gqlError)", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onParams: () => {
            throw gqlError("Bad params", 422, { code: "BAD_PARAMS" });
          },
        },
      ],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      errors: [
        { message: "Bad params", extensions: { code: "BAD_PARAMS", http: { status: 422 } } },
      ],
    });
  });
});

describe("onPhase", () => {
  it("gets parse and validate with times on a cache miss, in order", async () => {
    const phases: Array<Phase> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onPhase: (phase) => void phases.push(phase) }],
    });
    await gql(server, "{ count }");
    expect(phases.map(({ name }) => name)).toEqual(["parse", "validate"]);
    const [parse, validate] = phases;
    expect(parse!.start).toBeLessThanOrEqual(parse!.end);
    expect(parse!.end).toBeLessThanOrEqual(validate!.start);
    expect(validate!.start).toBeLessThanOrEqual(validate!.end);
  });

  it("gets parse alone for a syntax error, and parse + validate for an invalid document", async () => {
    const names: Array<string> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onPhase: ({ name }) => void names.push(name) }],
    });
    await gql(server, "{ count");
    expect(names).toEqual(["parse"]);
    await gql(server, "{ nope }");
    expect(names).toEqual(["parse", "parse", "validate"]);
  });

  it("is synchronous: a Promise-returning hook does not typecheck", () => {
    const plugin: Plugin = {
      // @ts-expect-error onPhase is a hot-loop hook and must be synchronous.
      onPhase: async () => {},
    };
    expect(plugin.onPhase).toBeDefined();
  });
});

describe("onContext", () => {
  it("gets the context, the request and the resolved operation", async () => {
    const onContext = vi.fn();
    const context = vi.fn((_request: Request, input: { operation: OperationDefinitionNode }) => ({
      user: "ada",
      operation: input.operation,
    }));
    const server = createServer({ schema: basicSchema(), context, plugins: [{ onContext }] });
    const request = post({ query: "query A { count } mutation B { bump }", operationName: "B" });
    await server.handle(request);
    const [ctx, seenRequest, operation] = onContext.mock.calls[0]!;
    expect(ctx).toEqual({ user: "ada", operation });
    expect(seenRequest).toBe(request);
    expect(operation.operation).toBe("mutation");
    expect(operation.name.value).toBe("B");
    expect(context.mock.calls[0]?.[0]).toBe(request);
  });

  it("runs after the context factory and before execution", async () => {
    const order: Array<string> = [];
    const server = createServer({
      schema: basicSchema({ Query: { count: () => order.push("resolve") } }),
      context: () => {
        order.push("context");
        return {};
      },
      plugins: [{ onContext: () => void order.push("onContext") }],
    });
    await gql(server, "{ count }");
    expect(order).toEqual(["context", "onContext", "resolve"]);
  });

  it("a thrown GraphQLError (from the factory or onContext) answers with it", async () => {
    const server = createServer({
      schema: basicSchema(),
      context: () => {
        throw gqlError("Not signed in", 401);
      },
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(401);
    expect(sent.error?.message).toBe("Not signed in");
  });

  it("any other throw is a masked 500", async () => {
    const error = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      logger: { warn: () => {}, error },
      plugins: [{ onContext: () => Promise.reject(new Error("db down")) }],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(500);
    expect(sent.body?.errors).toEqual([
      { message: "Unexpected error.", extensions: { http: { status: 500 } } },
    ]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("onExecute", () => {
  it("gets { operation, document, operationName } and the ExecutionArgs", async () => {
    const onExecute = vi.fn();
    const ctx = { id: 1 };
    const server = createServer({
      schema: basicSchema(),
      context: () => ctx,
      rootValue: { root: true },
      plugins: [{ onExecute }],
    });
    const request = post({
      query: "query A($v: Int!) { n(value: $v) } query B { count }",
      operationName: "A",
      variables: { v: 3 },
    });
    await server.handle(request);
    const [input, args] = onExecute.mock.calls[0]!;
    expect(input.operation.name.value).toBe("A");
    expect(input.operationName).toBe("A");
    expect(input.document.definitions).toHaveLength(2);
    expect(input.request).toBe(request);
    expect(typeof input.operationKey).toBe("object");
    expect(args.schema).toBe(server.control.schema());
    expect(args.document).toBe(input.document);
    expect(args.operationName).toBe("A");
    expect(args.variableValues).toEqual({ v: 3 });
    expect(args.contextValue).toBe(ctx);
    expect(args.rootValue).toEqual({ root: true });
  });

  it("every hook runs in list order; the first executor returned wins", async () => {
    const calls: Array<string> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        { onExecute: () => void calls.push("first") },
        {
          onExecute: () => {
            calls.push("second");
            return answer42;
          },
        },
        {
          onExecute: () => {
            calls.push("third");
            return () => ({ data: { count: 3 } });
          },
        },
      ],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 42 } });
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("a refusal listed after a claim refuses, and no executor runs", async () => {
    const executor = vi.fn(answer42);
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        { onExecute: () => executor },
        {
          onExecute: () => {
            throw gqlError("refused", 403);
          },
        },
      ],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(403);
    expect(executor).not.toHaveBeenCalled();
  });

  it("next runs the next claim in list order, else the default executor", async () => {
    const chained = createServer({
      schema: basicSchema(),
      plugins: [{ onExecute: () => delegate }, { onExecute: () => answer42 }],
    });
    expect((await gql(chained, "{ count }")).body).toEqual({ data: { count: 42 } });
    const alone = createServer({ schema: basicSchema(), plugins: [{ onExecute: () => delegate }] });
    expect((await gql(alone, "{ count }")).body).toEqual({ data: { count: 1 } });
  });

  it("the default executor runs when no hook claims the operation", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onExecute: () => undefined }],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
  });

  it("a thrown GraphQLError refuses the operation with its status (else 400)", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onExecute: ({ operation }) => {
            if (operation.operation === "mutation") {
              throw new GraphQLError("no mutations");
            }
            return undefined;
          },
        },
      ],
    });
    const sent = await gql(server, "mutation { bump }");
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ errors: [{ message: "no mutations" }] });
  });

  it("is synchronous: a Promise-returning hook does not typecheck", () => {
    const plugin: Plugin = {
      // @ts-expect-error onExecute is a hot-loop hook and must be synchronous.
      onExecute: async () => undefined,
    };
    expect(plugin.onExecute).toBeDefined();
  });
});

/** What a recording execution wrapper sets: the request it runs for. */
interface Current {
  request?: Request | undefined;
}

/** A wrapper that records the request it runs for, and its enter/exit order. */
const recording = (name: string, log: Array<string>, current: Current): Plugin => ({
  wrapExecution: (request, run) => {
    const previous = current.request;
    current.request = request;
    log.push(`${name} enter`);
    try {
      return run();
    } finally {
      log.push(`${name} exit`);
      current.request = previous;
    }
  },
});

/**
 * A server whose resolvers record whether they ran in their own request's store (the context
 * is the Request), and whose executor calls `next()` synchronously, inside the executor call,
 * from a listener `emitterOf` gives (an EventEmitterAsyncResource calls its listeners in the
 * async context it was created in, not the caller's).
 */
const nextFromEmitter = (emitterOf: () => EventEmitterAsyncResource) => {
  const storage = new AsyncLocalStorage<Request>();
  const seen: Array<boolean> = [];
  const server = createServer({
    schema: basicSchema({
      Query: {
        count: (_source, _args, request: unknown) => {
          seen.push(storage.getStore() === request);
          return 1;
        },
      },
    }),
    context: (request) => request,
    plugins: [
      {
        onExecute: () => (next) => {
          const emitter = emitterOf();
          let result: ReturnType<typeof next> | undefined;
          emitter.once("go", () => {
            result = next();
          });
          emitter.emit("go");
          return result ?? { errors: [new GraphQLError("no result")] };
        },
      },
      { wrapExecution: (request, run) => storage.run(request, run) },
    ],
  });
  return { server, seen };
};

describe("wrapExecution", () => {
  it("wraps the executor call, nesting in list order, with the resolver's own context", async () => {
    const log: Array<string> = [];
    const current: Current = {};
    const ctx = { app: true };
    let seen: [Request | undefined, unknown] | undefined;
    const server = createServer({
      schema: basicSchema({
        Query: {
          count: (_source, _args, context) => {
            seen = [current.request, context];
            return 1;
          },
        },
      }),
      context: () => ctx,
      plugins: [recording("a", log, current), recording("b", log, current)],
    });
    const request = post({ query: "{ count }" });
    expect((await send(server, request)).body).toEqual({ data: { count: 1 } });
    expect(seen).toEqual([request, ctx]);
    expect(log).toEqual(["a enter", "b enter", "b exit", "a exit"]);
  });

  it("wraps each subscription event's execution", async () => {
    const log: Array<string> = [];
    const current: Current = {};
    const seen: Array<Request | undefined> = [];
    const schema = basicSchema({}, "type Subscription { tick: Int }");
    const tick = schema.getSubscriptionType()?.getFields()["tick"];
    if (tick === undefined) {
      throw new Error("no tick");
    }
    tick.subscribe = async function* () {
      yield 1;
      yield 2;
    };
    tick.resolve = (payload: number) => {
      seen.push(current.request);
      return payload;
    };
    const server = createServer({ schema, plugins: [recording("a", log, current)] });
    const request = post({ query: "subscription { tick }" }, { accept: "text/event-stream" });
    const response = await server.handle(request);
    expect(await response.text()).toContain('"tick":2');
    expect(seen).toEqual([request, request]);
  });

  it("carries an AsyncLocalStorage store into deferred work, and wraps each deferred pull", async () => {
    const storage = new AsyncLocalStorage<Request>();
    let entries = 0;
    let seen: Request | undefined;
    const server = createServer({
      schema: basicSchema({
        Query: {
          count: () => {
            seen = storage.getStore();
            return 1;
          },
        },
      }),
      plugins: [
        incremental(),
        {
          wrapExecution: (request, run) => {
            entries += 1;
            return storage.run(request, run);
          },
        },
      ],
    });
    // Every root field is deferred: graphql-js runs it after the executor call has returned.
    const request = post({ query: "{ ... @defer { count } }" }, { accept: "multipart/mixed" });
    const response = await server.handle(request);
    expect(await response.text()).toContain('"count":1');
    expect(seen).toBe(request);
    // The executor call, then each pull of the subsequent payloads.
    expect(entries).toBeGreaterThan(1);
  });

  it("enters the wrappers again when an executor calls next() from outside the request", async () => {
    const storage = new AsyncLocalStorage<Request>();
    // An EventEmitter calls its listeners in the emitter's context, not the listener's.
    const emitter = new EventEmitter();
    const listening = gate();
    let seen: Request | undefined;
    let resolved = false;
    const server = createServer({
      schema: basicSchema({
        Query: {
          count: () => {
            resolved = true;
            seen = storage.getStore();
            return 1;
          },
        },
      }),
      plugins: [
        {
          onExecute: () => (next) =>
            new Promise((resolve) => {
              emitter.once("go", () => {
                resolve(next());
              });
              listening.resolve();
            }),
        },
        { wrapExecution: (request, run) => storage.run(request, run) },
      ],
    });
    const request = post({ query: "{ count }" });
    const sending = send(server, request);
    await listening.promise;
    expect(storage.getStore()).toBeUndefined();
    emitter.emit("go");
    expect((await sending).body).toEqual({ data: { count: 1 } });
    expect(resolved).toBe(true);
    expect(seen).toBe(request);
  });

  it("enters the wrappers again, nested, when an executor calls next() inside the executor call", async () => {
    const log: Array<string> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onExecute: () => delegate }, recording("a", log, {})],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
    expect(log).toEqual(["a enter", "a enter", "a exit", "a exit"]);
  });

  it("runs a next() made from another request's context in its own request's wrappers", async () => {
    let first: EventEmitterAsyncResource | undefined;
    // Created in the first request's executor call (inside its wrappers, in its store): the
    // second request's executor calls next() from a listener it calls in that store.
    const { server, seen } = nextFromEmitter(
      () => (first ??= new EventEmitterAsyncResource({ name: "first request" })),
    );
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
    expect(seen).toEqual([true, true]);
  });

  it("runs a next() made from an emitter created outside any request in the wrappers", async () => {
    const emitter = new EventEmitterAsyncResource({ name: "outside" });
    const { server, seen } = nextFromEmitter(() => emitter);
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
    expect(seen).toEqual([true]);
  });

  it("wraps a subscription source's pulls and its cleanup", async () => {
    const storage = new AsyncLocalStorage<Request>();
    const seen: Array<string> = [];
    const schema = basicSchema({}, "type Subscription { tick: Int }");
    const tick = schema.getSubscriptionType()?.getFields()["tick"];
    if (tick === undefined) {
      throw new Error("no tick");
    }
    const request = post({ query: "subscription { tick }" }, { accept: "text/event-stream" });
    const where = (): string => (storage.getStore() === request ? "in" : "out");
    let pulls = 0;
    tick.subscribe = () => ({
      [Symbol.asyncIterator]: () => {
        seen.push(`iterator ${where()}`);
        return {
          next: () => {
            seen.push(`next ${where()}`);
            pulls += 1;
            // One event, then a pull that only the close settles (an idle source).
            return pulls === 1
              ? Promise.resolve({ done: false, value: 1 })
              : new Promise<IteratorResult<number>>(() => {});
          },
          return: () => {
            seen.push(`return ${where()}`);
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    });
    tick.resolve = (payload: number) => payload;
    const server = createServer({
      schema,
      plugins: [{ wrapExecution: (req, run) => storage.run(req, run) }],
    });
    const response = await server.handle(request);
    const { reader } = await readUntil(response.body ?? new ReadableStream(), (text) =>
      text.includes('"tick":1'),
    );
    // A second read, pending on the idle pull, which the cancel interrupts.
    const pending = reader.read();
    while (pulls < 2) {
      await flush();
    }
    await reader.cancel();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(seen).toEqual(["iterator in", "next in", "next in", "return in"]);
  });
});

/** A server with a @stream source, and what its source's `return()` saw. */
interface StreamServer {
  readonly server: Server;
  readonly seen: Array<string>;
  readonly pulls: () => number;
}

/**
 * A server whose `items` field is a @stream source: one item, then an idle pull that only the
 * cleanup settles. Its `return()` records whether the request's wrapper store is in effect.
 * The executor is the default one, with the core's abort signal; with `outsideStore` it runs
 * outside the wrappers' store, so nothing it starts carries the store.
 */
const streamServer = (request: Request, outsideStore = false): StreamServer => {
  const storage = new AsyncLocalStorage<Request>();
  const seen: Array<string> = [];
  const where = (): string => (storage.getStore() === request ? "in" : "out");
  let pulls = 0;
  const server = createServer({
    schema: makeSchema("type Query { items: [Int] }", {
      Query: {
        items: () => {
          const release = Promise.withResolvers<IteratorResult<number>>();
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                pulls += 1;
                return pulls === 1 ? Promise.resolve({ done: false, value: 1 }) : release.promise;
              },
              return: () => {
                seen.push(`return ${where()}`);
                release.resolve({ done: true, value: undefined });
                return Promise.resolve({ done: true, value: undefined });
              },
            }),
          };
        },
      },
    }),
    plugins: [
      ...(outsideStore
        ? [
            {
              onExecute: (_input, args) => () =>
                storage.exit(() => legacyExecuteIncrementally(args)),
            } satisfies Plugin,
          ]
        : []),
      incremental(),
      { wrapExecution: (req, run) => storage.run(req, run) },
    ],
    logger: silent,
  });
  return { server, seen, pulls: () => pulls };
};

/**
 * Waits, at most `timeoutMs`, for the source's `return()` to have been called (`returned` records
 * each call); a regression fails with a message naming the missing call instead of polling forever.
 */
const returnCalled = async (returned: ReadonlyArray<string>, timeoutMs = 2000): Promise<void> => {
  const start = performance.now();
  while (returned.length === 0) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`the source's return() was not called within ${timeoutMs} ms`);
    }
    await flush();
  }
};

/** Reads the initial result, then leaves a read pending on the idle pull. */
const readToIdlePull = async (
  response: Response,
  pulls: () => number,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; pending: Promise<unknown> }> => {
  const { reader } = await readUntil(response.body ?? new ReadableStream(), (text) =>
    text.includes('"hasNext":true'),
  );
  const pending = reader.read().catch(() => undefined);
  while (pulls() < 2) {
    await flush();
  }
  return { reader, pending };
};

describe("wrapExecution of a @stream source's cleanup", () => {
  it("closes a cancelled @stream's source inside the request's wrappers", async () => {
    // The executor runs without the abort signal (graphql-js would close the source from its
    // abort listener, outside the wrappers): only the core's close of the results reaches it.
    const storage = new AsyncLocalStorage<Request>();
    const request = post(
      { query: "{ items @stream(initialCount: 1) }" },
      { accept: "multipart/mixed" },
    );
    const seen: Array<string> = [];
    const where = (): string => (storage.getStore() === request ? "in" : "out");
    let pulls = 0;
    const server = createServer({
      schema: makeSchema("type Query { items: [Int] }", {
        Query: {
          // One item, then an idle pull that only the cleanup settles.
          items: () => {
            const release = Promise.withResolvers<IteratorResult<number>>();
            return {
              [Symbol.asyncIterator]: () => ({
                next: () => {
                  pulls += 1;
                  return pulls === 1 ? Promise.resolve({ done: false, value: 1 }) : release.promise;
                },
                return: () => {
                  seen.push(`return ${where()}`);
                  release.resolve({ done: true, value: undefined });
                  return Promise.resolve({ done: true, value: undefined });
                },
              }),
            };
          },
        },
      }),
      plugins: [
        {
          onExecute: (_input, args) => () =>
            legacyExecuteIncrementally({ ...args, abortSignal: undefined }),
        },
        incremental(),
        { wrapExecution: (req, run) => storage.run(req, run) },
      ],
    });
    const response = await server.handle(request);
    const { reader } = await readUntil(response.body ?? new ReadableStream(), (text) =>
      text.includes('"hasNext":true'),
    );
    // A second read, pending on the idle pull, which the cancel ends.
    const pending = reader.read();
    while (pulls < 2) {
      await flush();
    }
    await reader.cancel();
    await pending;
    await returnCalled(seen);
    expect(seen).toEqual(["return in"]);
  });

  it("closes a @stream source inside the wrappers on a body cancel, with the abort signal", async () => {
    // graphql-js closes the source from its own listener on the core signal: the core aborts
    // that signal inside the request's wrappers.
    const request = post(
      { query: "{ items @stream(initialCount: 1) }" },
      { accept: "multipart/mixed" },
    );
    const { server, seen, pulls } = streamServer(request);
    const { reader, pending } = await readToIdlePull(await server.handle(request), pulls);
    await reader.cancel();
    await pending;
    await returnCalled(seen);
    expect(seen).toEqual(["return in"]);
  });

  it("closes a @stream source inside the wrappers when the request's signal aborts", async () => {
    const client = new AbortController();
    const request = post(
      { query: "{ items @stream(initialCount: 1) }" },
      { accept: "multipart/mixed", signal: client.signal },
    );
    const { server, seen, pulls } = streamServer(request);
    const { pending } = await readToIdlePull(await server.handle(request), pulls);
    client.abort();
    await pending;
    await returnCalled(seen);
    expect(seen).toEqual(["return in"]);
  });

  it("closes an unsent incremental result inside the wrappers (a 406)", async () => {
    // The executor runs outside the wrappers' store, so nothing it started carries the store:
    // only the core's own close, and its abort of the core signal, can enter the wrappers.
    const request = post(
      { query: "{ items @stream(initialCount: 1) }" },
      { accept: "application/json" },
    );
    const { server, seen } = streamServer(request, true);
    const response = await server.handle(request);
    expect(response.status).toBe(406);
    await returnCalled(seen);
    expect(seen).toEqual(["return in"]);
  });
});

/**
 * A @stream server (see streamServer) whose wrapper throws once armed: by `arm()`, or, with
 * `armOnExecute`, once the executor has returned (only the core's later entries fail). Its
 * logger records errors.
 */
const throwingWrapperServer = (armOnExecute: boolean, withSignal = true) => {
  let armed = false;
  let pulls = 0;
  const returned: Array<string> = [];
  const error = vi.fn();
  const server = createServer({
    schema: makeSchema("type Query { items: [Int] }", {
      Query: {
        items: () => {
          const release = Promise.withResolvers<IteratorResult<number>>();
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                pulls += 1;
                return pulls === 1 ? Promise.resolve({ done: false, value: 1 }) : release.promise;
              },
              return: () => {
                returned.push("return");
                release.resolve({ done: true, value: undefined });
                return Promise.resolve({ done: true, value: undefined });
              },
            }),
          };
        },
      },
    }),
    plugins: [
      {
        // Without the signal only the core's own close of the results reaches the source.
        onExecute: (_input, args) => (next) => {
          const result = withSignal
            ? next()
            : legacyExecuteIncrementally({ ...args, abortSignal: undefined });
          armed ||= armOnExecute;
          return result;
        },
      },
      incremental(),
      {
        wrapExecution: (_request, run) => {
          if (armed) {
            throw new Error("wrapper failed");
          }
          return run();
        },
      },
    ],
    logger: { warn: () => {}, error },
  });
  const arm = (): void => {
    armed = true;
  };
  return { server, returned, error, arm, pulls: () => pulls };
};

describe("a wrapper that throws on the core's own entries", () => {
  it("still aborts the core signal and closes an unsent result (a 406)", async () => {
    const request = post(
      { query: "{ items @stream(initialCount: 1) }" },
      { accept: "application/json" },
    );
    const { server, returned, error } = throwingWrapperServer(true);
    const response = await server.handle(request);
    expect(response.status).toBe(406);
    expect(signalOf(request)?.aborted).toBe(true);
    await returnCalled(returned);
    expect(returned).toEqual(["return"]);
    expect(error).toHaveBeenCalledWith(
      "gratos-server: a wrapExecution wrapper failed on an abort.",
      expect.any(Error),
    );
  });

  it("still closes an unsent result directly when the executor ignores the signal", async () => {
    const request = post(
      { query: "{ items @stream(initialCount: 1) }" },
      { accept: "application/json" },
    );
    const { server, returned, error } = throwingWrapperServer(true, false);
    const response = await server.handle(request);
    expect(response.status).toBe(406);
    await returnCalled(returned);
    expect(returned).toEqual(["return"]);
    expect(error).toHaveBeenCalledWith(
      "gratos-server: a wrapExecution wrapper failed on a close.",
      expect.any(Error),
    );
  });

  it("still aborts the core signal and releases the source when a stream's body is cancelled", async () => {
    const request = post(
      { query: "{ items @stream(initialCount: 1) }" },
      { accept: "multipart/mixed" },
    );
    const { server, returned, error, arm, pulls } = throwingWrapperServer(false);
    const { reader, pending } = await readToIdlePull(await server.handle(request), pulls);
    arm();
    await expect(reader.cancel()).resolves.toBeUndefined();
    await pending;
    expect(signalOf(request)?.aborted).toBe(true);
    await returnCalled(returned);
    expect(returned).toEqual(["return"]);
    expect(error).toHaveBeenCalledWith(
      "gratos-server: a wrapExecution wrapper failed on an abort.",
      expect.any(Error),
    );
  });
});

describe("aborts of an unread JSON body", () => {
  it("runs the core signal's listeners inside the wrappers when the body is cancelled", async () => {
    const storage = new AsyncLocalStorage<Request>();
    const request = post({ query: "{ count }" });
    const seen: Array<string> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          wrapExecution: (wrapped, run) => storage.run(wrapped, run),
          onResponse: (_response, req) => {
            // A plugin listening on the core signal (as effect() does) sees its request's store.
            signalOf(req)?.addEventListener("abort", () => {
              seen.push(storage.getStore() === req ? "abort in" : "abort out");
            });
          },
        },
      ],
    });
    const response = await server.handle(request);
    await response.body?.cancel();
    await flush();
    expect(seen).toEqual(["abort in"]);
  });

  it("aborts the core signal even when a wrapper throws on a client abort, and logs it", async () => {
    const client = new AbortController();
    const request = post({ query: "{ count }" }, { signal: client.signal });
    const error = vi.fn();
    let armed = false;
    const server = createServer({
      schema: basicSchema(),
      logger: { warn: () => {}, error },
      plugins: [
        {
          wrapExecution: (_wrapped, run) => {
            if (armed) {
              throw new Error("wrapper failed");
            }
            return run();
          },
        },
      ],
    });
    const response = await server.handle(request);
    armed = true;
    client.abort();
    expect(signalOf(request)?.aborted).toBe(true);
    expect(error).toHaveBeenCalledWith(
      "gratos-server: a wrapExecution wrapper failed on a client abort.",
      expect.any(Error),
    );
    await response.body?.cancel();
  });
});

describe("onResult", () => {
  it("gets each payload with the context and can replace it", async () => {
    const ctx = { id: 7 };
    const seen: Array<[ExecutionResult, unknown]> = [];
    const server = createServer({
      schema: basicSchema(),
      context: () => ctx,
      plugins: [
        {
          onResult: (payload, context) => {
            seen.push([payload, context]);
            return { ...payload, extensions: { seen: true } };
          },
        },
        {
          onResult: (payload) => {
            seen.push([payload, undefined]);
            return undefined;
          },
        },
      ],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.body).toEqual({ data: { count: 1 }, extensions: { seen: true } });
    expect(seen[0]).toEqual([{ data: { count: 1 } }, ctx]);
    expect(seen[1]?.[0]).toEqual({ data: { count: 1 }, extensions: { seen: true } });
  });

  it("sees variable-coercion errors (they come from execution)", async () => {
    const onResult = vi.fn();
    const server = createServer({ schema: basicSchema(), plugins: [{ onResult }] });
    await gql(server, "query ($v: Int!) { n(value: $v) }", { variables: { v: "x" } });
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("does not run for parse or validation errors (nothing executed)", async () => {
    const onResult = vi.fn();
    const server = createServer({ schema: basicSchema(), plugins: [{ onResult }] });
    await gql(server, "{ nope }");
    expect(onResult).not.toHaveBeenCalled();
  });

  it("an executor that throws becomes a 500 result that onResult sees", async () => {
    const onResult = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onExecute: () => () => {
            throw new Error("executor bug");
          },
        },
        { onResult },
      ],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(500);
    expect(onResult.mock.calls[0]?.[0].errors[0].originalError.message).toBe("executor bug");
  });

  it("is synchronous: a Promise-returning hook does not typecheck", () => {
    const plugin: Plugin = {
      // @ts-expect-error onResult is a hot-loop hook and must be synchronous.
      onResult: async () => undefined,
    };
    expect(plugin.onResult).toBeDefined();
  });
});

describe("onResponse", () => {
  const paths: ReadonlyArray<[string, (server: Server) => Promise<Response | Sent>]> = [
    ["a success", (server) => gql(server, "{ count }")],
    ["a 405", (server) => server.handle(new Request(URL_))],
    [
      "a 415",
      (server) => send(server, post({ query: "{ count }" }, { contentType: "text/plain" })),
    ],
    ["a 406", (server) => send(server, post({ query: "{ count }" }, { accept: "text/html" }))],
    ["a 400 body", (server) => send(server, post("nope"))],
    ["a parse error", (server) => gql(server, "{")],
    ["a validation error", (server) => gql(server, "{ nope }")],
    [
      "a context failure",
      (server) => gql(server, "query fail { count }", { operationName: "fail" }),
    ],
  ];

  it.each(paths)("runs exactly once on %s", async (_name, run) => {
    const onResponse = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      logger: silent,
      context: (_request, { params }) => {
        if (params.operationName === "fail") {
          throw new Error("context failed");
        }
        return {};
      },
      plugins: [{ onResponse }],
    });
    await run(server);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("gets the response, the request and the context, and can replace the response", async () => {
    const ctx = { id: 1 };
    const onResponse = vi.fn((response: Response, _request: Request, _ctx: unknown) => {
      const headers = new Headers(response.headers);
      headers.set("x-seen", "yes");
      return new Response(response.body, { status: response.status, headers });
    });
    const server = createServer({
      schema: basicSchema(),
      context: () => ctx,
      plugins: [{ onResponse }],
    });
    const request = post({ query: "{ count }" });
    const response = await server.handle(request);
    expect(response.headers.get("x-seen")).toBe("yes");
    expect(await response.json()).toEqual({ data: { count: 1 } });
    expect(onResponse.mock.calls[0]?.[1]).toBe(request);
    expect(onResponse.mock.calls[0]?.[2]).toBe(ctx);
  });

  it("a throwing hook is logged and the next hook still runs", async () => {
    const error = vi.fn();
    const second = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      logger: { warn: () => {}, error },
      plugins: [
        {
          onResponse: () => {
            throw new Error("hook bug");
          },
        },
        { onResponse: second },
      ],
    });
    const sent = await gql(server, "{ count }");
    expect(sent.status).toBe(200);
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("hook lists", () => {
  it("are built once at startup (a hook added later is never called)", async () => {
    const late = vi.fn(() => undefined);
    const plugin: Plugin = {};
    const server = createServer({ schema: basicSchema(), plugins: [plugin] });
    Object.assign(plugin, { onResult: late });
    await gql(server, "{ count }");
    expect(late).not.toHaveBeenCalled();
  });
});

describe("hideSuggestions", () => {
  it("is off by default and on when a plugin asks for it", async () => {
    const plain = createServer({ schema: basicSchema() });
    const hidden = createServer({ schema: basicSchema(), plugins: [{ hideSuggestions: true }] });
    const query = "{ hell }";
    expect((await gql(plain, query)).error?.message).toMatch(/Did you mean/);
    expect((await gql(hidden, query)).error?.message).not.toMatch(/Did you mean/);
  });
});
