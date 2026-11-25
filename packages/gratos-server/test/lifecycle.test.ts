// Signals, mutations and the drain (docs/plan.html M4a, and the appendix's M4a notes): the core's
// per-request AbortController, signalOf/startOf/mutationOf, the one synchronous gate step before
// the executor, control.drain({ warnAfterMs }), 503 SERVER_DRAINING, and aborts.
import { execute } from "graphql";
import type { ExecutionResult, GraphQLResolveInfo } from "graphql";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_CLOSED_REQUEST,
  gqlError,
  createServer,
  mutationOf,
  readOnly,
  reportErrors,
  signalOf,
  startOf,
} from "../src/index.ts";
import type { ExecuteInput, ExecutorResult, Plugin } from "../src/index.ts";
import { flush, gate, gql, post, send, sleep, waitFor } from "./support/http.ts";
import { basicSchema } from "./support/schema.ts";
import { readMultipart } from "./support/stream.ts";

const silent = { warn: () => {}, error: () => {} };

afterEach(() => {
  vi.useRealTimers();
});

describe("signalOf, startOf", () => {
  it("are recorded at handle() entry, before any onRequest plugin, keyed by the uncloned Request", async () => {
    let seen: { signal: AbortSignal | undefined; start: number | undefined } | undefined;
    const before = performance.now();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onRequest: (request) => {
            seen = { signal: signalOf(request), start: startOf(request) };
          },
        },
      ],
    });
    const request = post({ query: "{ count }" });
    await server.handle(request);
    expect(seen?.signal).toBe(signalOf(request));
    expect(seen?.signal?.aborted).toBe(false);
    expect(seen?.start).toBeGreaterThanOrEqual(before);
    expect(seen?.start).toBeLessThanOrEqual(performance.now());
    expect(signalOf(post({}))).toBeUndefined();
  });

  it("the core signal is linked to Request.signal, which stays read-only", async () => {
    const client = new AbortController();
    const hold = gate();
    const server = createServer({
      schema: basicSchema(),
      context: () => hold.promise.then(() => ({})),
    });
    const request = post({ query: "{ count }" }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    const signal = signalOf(request);
    expect(signal).not.toBe(request.signal);
    expect(signal?.aborted).toBe(false);
    client.abort(new Error("gone"));
    expect(signal?.aborted).toBe(true);
    hold.resolve();
    expect((await pending).status).toBe(CLIENT_CLOSED_REQUEST);
  });

  it("an already-aborted Request gives an aborted core signal", async () => {
    const client = new AbortController();
    client.abort();
    const server = createServer({ schema: basicSchema() });
    const request = post({ query: "{ count }" }, { signal: client.signal });
    const response = await server.handle(request);
    expect(signalOf(request)?.aborted).toBe(true);
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
  });

  it("cancelling the response body aborts the core signal", async () => {
    const server = createServer({ schema: basicSchema() });
    const request = post({ query: "{ count }" });
    const response = await server.handle(request);
    expect(signalOf(request)?.aborted).toBe(false);
    await response.body?.cancel();
    expect(signalOf(request)?.aborted).toBe(true);
  });

  it("is passed to query execution and never to mutations", async () => {
    const signals: Record<string, AbortSignal | undefined> = {};
    const capture: Plugin = {
      onExecute: ({ operation }: ExecuteInput, args) =>
        void (signals[`args:${operation.operation}`] = args.abortSignal ?? undefined),
    };
    const server = createServer({
      schema: basicSchema({
        Query: {
          count: (_s, _a, _c, info: GraphQLResolveInfo) => {
            signals["info:query"] = info.getAbortSignal();
            return 1;
          },
        },
        Mutation: {
          bump: (_s, _a, _c, info: GraphQLResolveInfo) => {
            signals["info:mutation"] = info.getAbortSignal();
            return 1;
          },
        },
      }),
      plugins: [capture],
    });
    const query = post({ query: "{ count }" });
    await server.handle(query);
    await server.handle(post({ query: "mutation { bump }" }));
    expect(signals["args:query"]).toBe(signalOf(query));
    // graphql-js derives the resolvers' signal from the one it is given.
    expect(signals["info:query"]).toBeInstanceOf(AbortSignal);
    expect(signals["args:mutation"]).toBeUndefined();
  });
});

describe("mutationOf", () => {
  it("is undefined for queries", async () => {
    const server = createServer({ schema: basicSchema() });
    const request = post({ query: "{ count }" });
    await server.handle(request);
    expect(mutationOf(request)).toBeUndefined();
  });

  it("is published once the operation is known, before context; started is true before the executor runs", async () => {
    const events: Array<string> = [];
    let state: ReturnType<typeof mutationOf>;
    const server = createServer({
      schema: basicSchema({
        Mutation: {
          bump: () => {
            events.push("resolver");
            return 1;
          },
        },
      }),
      context: (request) => {
        state = mutationOf(request);
        void state?.started.then((started) => events.push(`started:${started}`));
        void state?.settled.then(() => events.push("settled"));
        return {};
      },
      plugins: [
        {
          onExecute: () => () => {
            events.push("executor");
            return Promise.resolve().then(() => {
              events.push("resolved");
              return { data: { bump: 1 } };
            });
          },
        },
      ],
    });
    const sent = await gql(server, "mutation { bump }");
    expect(sent.body).toEqual({ data: { bump: 1 } });
    expect(await state?.started).toBe(true);
    await state?.settled;
    await flush();
    expect(events).toEqual(["executor", "started:true", "resolved", "settled"]);
  });

  it("started resolves false on every path that never calls the executor", async () => {
    const outcomes: Array<boolean | undefined> = [];
    const record = async (request: Request, server: ReturnType<typeof createServer>) => {
      await server.handle(request);
      outcomes.push(await mutationOf(request)?.started);
      await mutationOf(request)?.settled;
    };
    const failing = createServer({
      schema: basicSchema(),
      logger: silent,
      context: () => {
        throw new Error("no session");
      },
    });
    await record(post({ query: "mutation { bump }" }), failing);
    const refusing = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onExecute: () => {
            throw new (class extends Error {})("plain");
          },
        },
      ],
      logger: silent,
    });
    await record(post({ query: "mutation { bump }" }), refusing);
    const client = new AbortController();
    client.abort();
    await record(
      post({ query: "mutation { bump }" }, { signal: client.signal }),
      createServer({ schema: basicSchema() }),
    );
    const draining = createServer({ schema: basicSchema() });
    await draining.control.drain();
    await record(post({ query: "mutation { bump }" }), draining);
    expect(outcomes).toEqual([false, false, false, false]);
  });
});

describe("mutationOf(req).status", () => {
  it("is the status of the answer built from a settled mutation's result", async () => {
    const server = createServer({ schema: basicSchema() });
    const request = post({ query: "mutation { bump }" });
    const seen: Array<number | undefined> = [mutationOf(request)?.status()];
    const response = await server.handle(request);
    expect(response.status).toBe(200);
    seen.push(mutationOf(request)?.status());
    expect(seen).toEqual([undefined, 200]);
  });

  it("is a 500 when building the answer failed (a throwing result hook)", async () => {
    let status: number | undefined;
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onResult: () => {
            throw new Error("hook failed");
          },
        },
        {
          onResponse: (_response, request) => {
            status = mutationOf(request)?.status();
          },
        },
      ],
      logger: silent,
    });
    const response = await server.handle(post({ query: "mutation { bump }" }));
    expect(response.status).toBe(500);
    expect(status).toBe(500);
  });

  it("stays undefined for a mutation that never started", async () => {
    const server = createServer({ schema: basicSchema() });
    await server.control.drain();
    const request = post({ query: "mutation { bump }" });
    expect((await server.handle(request)).status).toBe(503);
    expect(mutationOf(request)?.status()).toBeUndefined();
  });
});

describe("no late start", () => {
  it("a client that leaves during the context phase never starts the mutation (499, onResponse runs)", async () => {
    const hold = gate();
    const executor = vi.fn(() => ({ data: { bump: 1 } }));
    const onResponse = vi.fn();
    const onResult = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      context: () => hold.promise.then(() => ({})),
      plugins: [{ onExecute: () => executor, onResult, onResponse }],
    });
    const client = new AbortController();
    const request = post({ query: "mutation { bump }" }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    client.abort();
    hold.resolve();
    const response = await pending;
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(response.body).toBeNull();
    expect(executor).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(await mutationOf(request)?.started).toBe(false);
  });

  it("applies to queries too", async () => {
    const hold = gate();
    const resolver = vi.fn(() => 1);
    const server = createServer({
      schema: basicSchema({ Query: { count: resolver } }),
      context: () => hold.promise.then(() => ({})),
    });
    const client = new AbortController();
    const pending = server.handle(post({ query: "{ count }" }, { signal: client.signal }));
    await flush();
    client.abort();
    hold.resolve();
    expect((await pending).status).toBe(CLIENT_CLOSED_REQUEST);
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("aborted execution", () => {
  it("AbortedGraphQLExecutionError is caught, not reported, and the terminal path still runs", async () => {
    const started = gate();
    const cleanup = vi.fn();
    const onResult = vi.fn();
    const onResponse = vi.fn();
    const server = createServer({
      schema: basicSchema({
        Query: {
          hello: (_s, _a, _c, info: GraphQLResolveInfo) =>
            new Promise((_resolve, reject) => {
              started.resolve();
              info.getAbortSignal()?.addEventListener("abort", () => {
                cleanup();
                reject(new Error("aborted"));
              });
            }),
        },
      }),
      plugins: [{ onResult, onResponse }],
    });
    const client = new AbortController();
    const pending = server.handle(post({ query: "{ hello }" }, { signal: client.signal }));
    await started.promise;
    client.abort();
    const response = await pending;
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(response.body).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("a query's single result that settles after the client left is a 499, unprocessed", async () => {
    const late = gate<ExecutionResult>();
    const executed = gate();
    const onResult = vi.fn();
    const onResponse = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        // An executor that ignores the abort signal (as graphql-jit does).
        {
          onExecute: () => () => {
            executed.resolve();
            return late.promise;
          },
        },
        { onResult, onResponse },
      ],
    });
    const client = new AbortController();
    const pending = server.handle(post({ query: "{ count }" }, { signal: client.signal }));
    await executed.promise;
    client.abort();
    late.resolve({ data: { count: 1 } });
    const response = await pending;
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(response.body).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("a mutation keeps running after the client leaves and its result is still encoded", async () => {
    const hold = gate();
    const committed = vi.fn();
    let resolverSignal: AbortSignal | undefined;
    const server = createServer({
      schema: basicSchema({
        Mutation: {
          bump: async (_s, _a, _c, info: GraphQLResolveInfo) => {
            resolverSignal = info.getAbortSignal();
            await hold.promise;
            committed();
            return 1;
          },
        },
      }),
    });
    const client = new AbortController();
    const request = post({ query: "mutation { bump }" }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    client.abort();
    expect(signalOf(request)?.aborted).toBe(true);
    // The resolvers' signal (graphql-js always provides one) is not linked to the client.
    expect(resolverSignal?.aborted).toBe(false);
    hold.resolve();
    const response = await pending;
    expect(committed).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });
});

describe("a started mutation that fails after the client left", () => {
  it("is processed and reported (not a 499)", async () => {
    const hold = gate();
    const log = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      logger: silent,
      plugins: [
        reportErrors(log),
        {
          onExecute: () => async () => {
            await hold.promise;
            throw new Error("write failed");
          },
        },
      ],
    });
    const client = new AbortController();
    const request = post({ query: "mutation { bump }" }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    expect(await mutationOf(request)?.started).toBe(true);
    client.abort();
    hold.resolve();
    const response = await pending;
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ message: "Unexpected error." });
  });
});

describe("a mutation that fails before dispatch after the client left", () => {
  it("never started, so it is a cancellation: 499 and nothing reported", async () => {
    const context = gate();
    const log = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      logger: silent,
      context: () => context.promise.then(() => ({})),
      plugins: [
        reportErrors(log),
        {
          onExecute: () => {
            throw new Error("hook failed");
          },
        },
      ],
    });
    const client = new AbortController();
    const request = post({ query: "mutation { bump }" }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    client.abort();
    context.resolve();
    const response = await pending;
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(log).not.toHaveBeenCalled();
    expect(await mutationOf(request)?.started).toBe(false);
  });
});

describe("a context failure after the client left", () => {
  it.each([
    ["a refusal (GraphQLError)", gqlError("Not allowed", 403)],
    ["an ordinary Error", new Error("session store down")],
  ])("%s is a cancellation (499)", async (_name, failure) => {
    const context = gate();
    const onResult = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      logger: silent,
      context: () =>
        context.promise.then(() => {
          throw failure;
        }),
      plugins: [{ onResult }],
    });
    const client = new AbortController();
    const request = post({ query: "mutation { bump }" }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    client.abort();
    context.resolve();
    const response = await pending;
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(response.body).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    expect(await mutationOf(request)?.started).toBe(false);
  });
});

describe("an onExecute refusal after the client left", () => {
  it.each([
    ["a query", "{ count }"],
    ["a mutation", "mutation { bump }"],
  ])("%s is a cancellation (499), like an ordinary onExecute failure", async (_name, query) => {
    const context = gate();
    const onResult = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      context: () => context.promise.then(() => ({})),
      plugins: [
        {
          onExecute: () => {
            throw gqlError("Not allowed", 403);
          },
          onResult,
        },
      ],
    });
    const client = new AbortController();
    const request = post({ query }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    client.abort();
    context.resolve();
    const response = await pending;
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(response.body).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    expect(await mutationOf(request)?.started).toBe(
      query.startsWith("mutation") ? false : undefined,
    );
  });

  it("a drain still wins for an unstarted mutation (drain > disconnect > refusal)", async () => {
    const client = new AbortController();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onExecute: () => {
            void server.control.drain();
            client.abort();
            throw gqlError("Not allowed", 403);
          },
        },
      ],
    });
    const request = post({ query: "mutation { bump }" }, { signal: client.signal });
    const sent = await send(server, request);
    expect(sent.status).toBe(503);
    expect(sent.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
    expect(await mutationOf(request)?.started).toBe(false);
  });
});

/** An iterator whose pulls do a mutation's write: only a pull runs it, and return() is recorded. */
const writingIterator = <T>(events: Array<string>, value: T): AsyncGenerator<T, void, void> => {
  const iterator: AsyncGenerator<T, void, void> = {
    next: async () => {
      events.push("write");
      return { done: false, value };
    },
    return: async () => {
      events.push("closed");
      return { done: true, value: undefined };
    },
    throw: (error: unknown) => Promise.reject(error),
    [Symbol.asyncIterator]: () => iterator,
    [Symbol.asyncDispose]: async () => undefined,
  };
  return iterator;
};

describe("a custom executor that streams a mutation's result", () => {
  it.each([
    [
      "events",
      "text/event-stream, application/json",
      (events: Array<string>): ExecutorResult => writingIterator(events, { data: { bump: 1 } }),
    ],
    [
      "an incremental result",
      "multipart/mixed, application/json",
      (events: Array<string>): ExecutorResult => ({
        initialResult: { data: { bump: 1 }, hasNext: true },
        subsequentResults: writingIterator(events, { hasNext: false }),
      }),
    ],
  ])(
    "(%s) is closed before drain() resolves, never pulled, and the request fails",
    async (_name, accept, streamed) => {
      const events: Array<string> = [];
      const logged: Array<string> = [];
      const server = createServer({
        schema: basicSchema(),
        logger: { warn: () => {}, error: (message) => logged.push(message) },
        plugins: [{ onExecute: () => () => streamed(events) }],
      });
      const request = post({ query: "mutation { bump }" }, { accept });
      const response = await server.handle(request);
      expect(await mutationOf(request)?.started).toBe(true);
      await server.control.drain();
      expect(events).toEqual(["closed"]);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        errors: [{ message: "Unexpected error.", extensions: { http: { status: 500 } } }],
      });
      expect(events).toEqual(["closed"]);
      expect(logged).toEqual(["gratos-server: an executor streamed the result of a mutation."]);
    },
  );

  it("a streamed query is still served", async () => {
    const events: Array<string> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onExecute: () => () => ({
            initialResult: { data: { count: 1 }, hasNext: true },
            subsequentResults: writingIterator(events, { hasNext: false }),
          }),
        },
      ],
    });
    const response = await server.handle(
      post({ query: "{ count }" }, { accept: "multipart/mixed, application/json" }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(events).toEqual(["write", "closed"]);
  });
});

describe("completion of a disconnected mutation", () => {
  it("settled and the drain wait until onResult has seen the result", async () => {
    const hold = gate();
    let errors = 0;
    const seen: Array<string> = [];
    const server = createServer({
      schema: basicSchema({
        Mutation: {
          bump: async () => {
            await hold.promise;
            throw new Error("write failed");
          },
        },
      }),
      plugins: [
        {
          onResult: (payload) => {
            errors += payload.errors?.length ?? 0;
            return undefined;
          },
        },
      ],
    });
    const client = new AbortController();
    const request = post({ query: "mutation { bump }" }, { signal: client.signal });
    const pending = server.handle(request);
    await flush();
    // An M5-style span finalizer: it ends the span with the errors onResult counted.
    void mutationOf(request)?.settled.then(() => seen.push(`settled:${errors}`));
    const drained = server.control.drain().then(() => seen.push(`drained:${errors}`));
    client.abort();
    hold.resolve();
    await drained;
    await pending;
    expect(seen).toEqual(["settled:1", "drained:1"]);
  });
});

/** A server whose mutation has two serial async fields, each held by its own gate. */
const twoFieldServer = (
  options: { slowContext?: Promise<void>; warn?: (...args: Array<unknown>) => void } = {},
) => {
  const events: Array<string> = [];
  const first = gate();
  const second = gate();
  /** Counts real executor calls (the plugin wraps the default executor). */
  const executor = vi.fn();
  const firstStarted = gate();
  const server = createServer({
    schema: basicSchema(
      {
        Mutation: {
          bump: async () => {
            firstStarted.resolve();
            await first.promise;
            events.push("first committed");
            return 1;
          },
          bump2: async () => {
            await second.promise;
            events.push("second committed");
            return 2;
          },
        },
      },
      "extend type Mutation { bump2: Int! }",
    ),
    logger: { warn: options.warn ?? (() => {}), error: () => {} },
    context: async () => {
      await options.slowContext;
      return {};
    },
    plugins: [
      {
        onExecute: (_input, args) => () => {
          executor();
          return execute(args);
        },
      },
    ],
  });
  return { server, events, first, second, firstStarted, executor };
};

describe("control.drain", () => {
  it("waits for every tracked mutation, including the gap between serial fields", async () => {
    const { server, events, first, second, firstStarted } = twoFieldServer();
    const pending = gql(server, "mutation { bump bump2 }");
    await firstStarted.promise;
    const drained = server.control.drain().then(() => events.push("drained"));
    first.resolve();
    await sleep(5);
    expect(events).toEqual(["first committed"]);
    second.resolve();
    await drained;
    expect(events).toEqual(["first committed", "second committed", "drained"]);
    expect((await pending).body).toEqual({ data: { bump: 1, bump2: 2 } });
  });

  it("keeps a started mutation tracked until its work settles when a wrapper throws after it ran", async () => {
    const events: Array<string> = [];
    const hold = gate();
    const started = gate();
    const error = vi.fn();
    const server = createServer({
      schema: basicSchema({
        Mutation: {
          bump: async () => {
            started.resolve();
            await hold.promise;
            events.push("committed");
            return 1;
          },
        },
      }),
      logger: { warn: () => {}, error },
      plugins: [
        {
          // Calls the executor, then fails: the mutation it started keeps running.
          wrapExecution: (_request, run) => {
            run();
            throw new Error("wrapper failed");
          },
        },
      ],
    });
    const pending = gql(server, "mutation { bump }");
    await started.promise;
    const drained = server.control.drain().then(() => events.push("drained"));
    await sleep(5);
    expect(events).toEqual([]);
    hold.resolve();
    await drained;
    expect(events).toEqual(["committed", "drained"]);
    const sent = await pending;
    expect(sent.status).toBe(500);
  });

  it("keeps a started mutation tracked when a wrapper around an executor's next() throws after it ran", async () => {
    const events: Array<string> = [];
    const hold = gate();
    const started = gate();
    let entries = 0;
    const server = createServer({
      schema: basicSchema({
        Mutation: {
          bump: async () => {
            started.resolve();
            await hold.promise;
            events.push("committed");
            return 1;
          },
        },
      }),
      logger: silent,
      plugins: [
        // Delegates: its next() enters the wrappers again, inside the executor call.
        { onExecute: () => (next) => next() },
        {
          // The second entry is the one around next(): it starts the mutation, then fails.
          wrapExecution: (_request, run) => {
            entries += 1;
            const result = run();
            if (entries === 2) {
              throw new Error("wrapper failed");
            }
            return result;
          },
        },
      ],
    });
    const pending = gql(server, "mutation { bump }");
    await started.promise;
    const drained = server.control.drain().then(() => events.push("drained"));
    await sleep(5);
    expect(events).toEqual([]);
    hold.resolve();
    await drained;
    expect(events).toEqual(["committed", "drained"]);
    expect((await pending).status).toBe(500);
  });

  it("aborts a query a wrapper started before it threw, and answers its 500", async () => {
    const started = gate();
    let aborted = false;
    const request = post({ query: "{ hello }" });
    const server = createServer({
      schema: basicSchema({
        Query: {
          // Settles only once its abort signal aborts (the client stays connected).
          hello: (_source, _args, _context, info: GraphQLResolveInfo) =>
            new Promise<string>((resolve) => {
              started.resolve();
              info.getAbortSignal()?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve("late");
                },
                { once: true },
              );
            }),
        },
      }),
      logger: silent,
      plugins: [
        {
          // Calls the executor, then fails: the query it started keeps waiting.
          wrapExecution: (_request, run) => {
            run();
            throw new Error("wrapper failed");
          },
        },
      ],
    });
    const sent = send(server, request);
    await started.promise;
    const answered = await Promise.race([sent, sleep(1000).then(() => "hung" as const)]);
    expect(answered).not.toBe("hung");
    expect(answered === "hung" ? undefined : answered.status).toBe(500);
    expect(aborted).toBe(true);
    expect(signalOf(request)?.aborted).toBe(true);
  });

  it("observes the rejection of an execution a wrapper around next() left running while the executor awaits a fallback", async () => {
    const unhandled: Array<unknown> = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const caught = gate();
    const abandon = gate();
    const fallback = gate();
    try {
      let entries = 0;
      const server = createServer({
        schema: basicSchema(),
        logger: silent,
        plugins: [
          {
            // Catches the nested entry's error and answers with a fallback it waits for.
            onExecute: () => async (next) => {
              try {
                return await next();
              } catch {
                caught.resolve();
                await fallback.promise;
                return { data: { hello: "fallback" } };
              }
            },
          },
          // Its execution, which the throwing wrapper leaves running, fails once told to.
          {
            onExecute: () => async () => {
              await abandon.promise;
              throw new Error("abandoned");
            },
          },
          {
            // The second entry is the one around next(): it runs it, then fails.
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
      });
      const sent = gql(server, "{ hello }");
      // The abandoned execution rejects while the fallback is still held, and Node gets a full
      // event-loop turn to report the rejection before anything else can observe it.
      await caught.promise;
      abandon.resolve();
      await flush();
      expect(unhandled).toEqual([]);
      fallback.resolve();
      const response = await sent;
      expect(response.error).toBeUndefined();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { hello: "fallback" } });
    } finally {
      fallback.resolve();
      process.off("unhandledRejection", listener);
    }
  });

  it("stops a query a wrapper around next() left running when the executor answers with a fallback", async () => {
    const started = gate();
    let aborted = false;
    let entries = 0;
    const request = post({ query: "{ hello }" });
    const server = createServer({
      schema: basicSchema({
        Query: {
          // Settles only once its abort signal aborts (the client stays connected).
          hello: (_source, _args, _context, info: GraphQLResolveInfo) =>
            new Promise<string>((resolve) => {
              started.resolve();
              info.getAbortSignal()?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve("late");
                },
                { once: true },
              );
            }),
        },
      }),
      logger: silent,
      plugins: [
        {
          // Catches the nested entry's error and answers with a fallback.
          onExecute: () => async (next) => {
            try {
              return await next();
            } catch {
              return { data: { hello: "fallback" } };
            }
          },
        },
        {
          // The second entry is the one around next(): it starts the query, then fails.
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
    });
    const response = await send(server, request);
    await started.promise;
    expect(response.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { hello: "fallback" } });
    expect(aborted).toBe(true);
    // Its own signal aborted: the core signal (the fallback's) is untouched.
    expect(signalOf(request)?.aborted).toBe(false);
  });

  it("stops the execution a claim's delayed next() starts once the wrapper around that claim failed and the executor answered with a fallback", async () => {
    const delayed = gate();
    let settled = false;
    let entries = 0;
    const request = post({ query: "{ hello }" });
    const server = createServer({
      schema: basicSchema({
        Query: {
          // Settles only once its abort signal aborts (the client stays connected).
          hello: (_source, _args, _context, info: GraphQLResolveInfo) =>
            new Promise<string>((resolve) => {
              info.getAbortSignal()?.addEventListener(
                "abort",
                () => {
                  resolve("late");
                },
                { once: true },
              );
            }),
        },
      }),
      logger: silent,
      plugins: [
        {
          // Catches the nested entry's error and answers with a fallback.
          onExecute: () => async (next) => {
            try {
              return await next();
            } catch {
              return { data: { hello: "fallback" } };
            }
          },
        },
        {
          // Delegates only later (a queue, say), after the entry it was called in has failed.
          onExecute: () => async (next) => {
            await delayed.promise;
            try {
              return await next();
            } finally {
              settled = true;
            }
          },
        },
        {
          // The second entry is the one around the first claim's next(): it runs the second
          // claim, then fails.
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
    });
    const response = await send(server, request);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { hello: "fallback" } });
    delayed.resolve();
    // Its next() runs with the signal of the entry it was called in, which stopped with it.
    await waitFor(() => settled, "the delayed next()'s execution settling");
    expect(signalOf(request)?.aborted).toBe(false);
  });

  it("closes a stream a wrapper around next() left running, and sends the stream the executor answers with instead", async () => {
    let returns = 0;
    let calls = 0;
    let entries = 0;
    /** An incremental result with one deferred payload, sent after `delay` ms. */
    const incrementalOf = (hello: string, delay: number): ExecutorResult => ({
      initialResult: { data: { hello }, hasNext: true },
      subsequentResults: {
        next: async () => {
          await sleep(delay);
          return {
            done: false,
            value: { incremental: [{ data: { count: 1 }, path: [] }], hasNext: false },
          };
        },
        return: async () => {
          if (hello === "abandoned") {
            returns += 1;
          }
          return { done: true, value: undefined };
        },
        throw: (error: unknown) => Promise.reject(error),
        [Symbol.asyncIterator]() {
          return this;
        },
        [Symbol.asyncDispose]: () => Promise.resolve(),
      },
    });
    const request = post({ query: "{ hello }" }, { accept: "multipart/mixed" });
    const server = createServer({
      schema: basicSchema(),
      logger: silent,
      plugins: [
        {
          // Catches the nested entry's error and delegates again.
          onExecute: () => (next) => {
            try {
              return next();
            } catch {
              return next();
            }
          },
        },
        {
          onExecute: () => () => {
            calls += 1;
            return calls === 1 ? incrementalOf("abandoned", 0) : incrementalOf("sent", 10);
          },
        },
        {
          // The second entry is the one around the first next(): it runs it, then fails.
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
    });
    const response = await server.handle(request);
    expect(response.status).toBe(200);
    const parts = readMultipart(await response.text());
    expect(parts).toEqual([
      { data: { hello: "sent" }, hasNext: true },
      { incremental: [{ data: { count: 1 }, path: [] }], hasNext: false },
    ]);
    await waitFor(() => returns > 0, "the abandoned stream's return() call");
    expect(signalOf(request)?.aborted).toBe(false);
  });

  it("a continuation on mutationOf(req).settled runs before drain() resolves", async () => {
    const { server, events, first, second, firstStarted } = twoFieldServer();
    const request = post({ query: "mutation { bump bump2 }" });
    const pending = server.handle(request);
    await firstStarted.promise;
    void mutationOf(request)?.settled.then(() => events.push("span ended"));
    const drained = server.control.drain().then(() => events.push("drained"));
    first.resolve();
    second.resolve();
    await drained;
    await pending;
    expect(events).toEqual(["first committed", "second committed", "span ended", "drained"]);
  });

  it("refuses new mutations with 503 SERVER_DRAINING, and still serves queries", async () => {
    const executor = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onExecute: () => void executor() }],
    });
    await server.control.drain();
    expect(server.control.draining()).toBe(true);
    for (const accept of ["application/graphql-response+json", "application/json"]) {
      const sent = await gql(server, "mutation { bump }", { accept });
      expect(sent.status).toBe(503);
      expect(sent.body).toEqual({
        errors: [
          {
            message: "The server is shutting down and accepts no new mutations.",
            extensions: { code: "SERVER_DRAINING", http: { status: 503 } },
          },
        ],
      });
    }
    expect(executor).not.toHaveBeenCalled();
    expect((await gql(server, "{ count }")).status).toBe(200);
  });

  it("resolves at once when nothing is running", async () => {
    const server = createServer({ schema: basicSchema() });
    await server.control.drain({ warnAfterMs: 1 });
  });

  it("warnAfterMs logs once when the threshold passes, then every warnAfterMs while blocked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.fn();
    const { server, first, second, firstStarted } = twoFieldServer({ warn });
    const pending = gql(server, "mutation Pay { bump bump2 }");
    await firstStarted.promise;
    const drained = server.control.drain({ warnAfterMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(warn).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "gratos-server: drain is waiting for 1 mutation(s) to finish.",
    );
    expect(warn.mock.calls[0]?.[1]).toEqual([{ operation: "Pay", runningMs: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(warn).toHaveBeenCalledTimes(2);
    first.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(warn).toHaveBeenCalledTimes(3);
    second.resolve();
    await drained;
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(3);
    await pending;
  });

  describe("shutdown while a mutation is in a slow context factory (appendix, one gate step)", () => {
    it("drain before the gate: zero executor calls, started false, 503", async () => {
      const context = gate();
      const { server, executor, events } = twoFieldServer({ slowContext: context.promise });
      const request = post({ query: "mutation { bump bump2 }" });
      const pending = send(server, request);
      await flush();
      const drained = server.control.drain();
      let drainDone = false;
      void drained.then(() => (drainDone = true));
      await flush();
      // Nothing was tracked: the drain is already done while the context factory still runs.
      expect(drainDone).toBe(true);
      context.resolve();
      const sent = await pending;
      expect(sent.status).toBe(503);
      expect(sent.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
      expect(executor).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(await mutationOf(request)?.started).toBe(false);
    });

    it("a drain during the context factory wins over an onExecute refusal (503, not 403)", async () => {
      const context = gate();
      const server = createServer({
        schema: basicSchema(),
        context: () => context.promise.then(() => ({})),
        plugins: [readOnly()],
      });
      const request = post({ query: "mutation { bump }" });
      const pending = send(server, request);
      await flush();
      await server.control.drain();
      context.resolve();
      const sent = await pending;
      expect(sent.status).toBe(503);
      expect(sent.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
      expect(await mutationOf(request)?.started).toBe(false);
    });

    it("a drain started by an onExecute hook wins over a later hook's refusal", async () => {
      const server = createServer({
        schema: basicSchema(),
        plugins: [
          {
            onExecute: () => {
              void server.control.drain();
              return undefined;
            },
          },
          readOnly(),
        ],
      });
      const request = post({ query: "mutation { bump }" });
      const sent = await send(server, request);
      expect(sent.status).toBe(503);
      expect(sent.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
      expect(await mutationOf(request)?.started).toBe(false);
    });

    it("a context refusal that completes during the drain is a 503", async () => {
      const context = gate();
      const server = createServer({
        schema: basicSchema(),
        context: () =>
          context.promise.then(() => {
            throw gqlError("Not allowed", 403);
          }),
      });
      const request = post({ query: "mutation { bump }" });
      const pending = send(server, request);
      await flush();
      await server.control.drain();
      context.resolve();
      const sent = await pending;
      expect(sent.status).toBe(503);
      expect(sent.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
    });

    it("an onExecute hook that fails with an ordinary Error during the drain is a 503", async () => {
      const log = vi.fn();
      const server = createServer({
        schema: basicSchema(),
        logger: silent,
        plugins: [
          reportErrors(log),
          {
            onExecute: () => {
              void server.control.drain();
              throw new Error("hook failed");
            },
          },
        ],
      });
      const request = post({ query: "mutation { bump }" });
      const sent = await send(server, request);
      expect(sent.status).toBe(503);
      expect(sent.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
      expect(log).not.toHaveBeenCalled();
      expect(await mutationOf(request)?.started).toBe(false);
    });

    it("a context factory that fails with an ordinary Error during the drain is a 503 (logged)", async () => {
      const context = gate();
      const error = vi.fn();
      const failure = new Error("session store down");
      const server = createServer({
        schema: basicSchema(),
        logger: { warn: () => {}, error },
        context: () =>
          context.promise.then(() => {
            throw failure;
          }),
      });
      const request = post({ query: "mutation { bump }" });
      const pending = send(server, request);
      await flush();
      await server.control.drain();
      context.resolve();
      const sent = await pending;
      expect(sent.status).toBe(503);
      expect(sent.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
      expect(error).toHaveBeenCalledExactlyOnceWith(
        "gratos-server: the context phase failed.",
        failure,
      );
      expect(await mutationOf(request)?.started).toBe(false);
    });

    it("without a drain, the same failure is a masked 500", async () => {
      const error = vi.fn();
      const server = createServer({
        schema: basicSchema(),
        logger: { warn: () => {}, error },
        context: () => {
          throw new Error("session store down");
        },
      });
      const sent = await gql(server, "mutation { bump }");
      expect(sent.status).toBe(500);
      expect(sent.body).toEqual({
        errors: [{ message: "Unexpected error.", extensions: { http: { status: 500 } } }],
      });
      expect(error).toHaveBeenCalledTimes(1);
    });

    it("drain after the gate: both fields commit before the drain resolves", async () => {
      const context = gate();
      const { server, executor, events, first, second, firstStarted } = twoFieldServer({
        slowContext: context.promise,
      });
      const request = post({ query: "mutation { bump bump2 }" });
      const pending = send(server, request);
      context.resolve();
      await firstStarted.promise;
      expect(await mutationOf(request)?.started).toBe(true);
      const drained = server.control.drain().then(() => events.push("services released"));
      first.resolve();
      second.resolve();
      await drained;
      expect(executor).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["first committed", "second committed", "services released"]);
      expect((await pending).status).toBe(200);
    });
  });
});
