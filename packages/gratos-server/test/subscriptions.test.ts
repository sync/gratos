// Subscriptions (docs/plan.html M4b): always graphql-js subscribe(), encoded as GraphQL-over-SSE
// "distinct connections"; errors from a failing source; disconnects over a standalone
// handle(Request) and over real HTTP (node:http); and the plan's regression tests.
import { on } from "node:events";
import { EventEmitter } from "node:events";

import { GraphQLError, parse } from "graphql";
import type { GraphQLResolveInfo } from "graphql";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLIENT_CLOSED_REQUEST,
  createServer,
  incremental,
  jit,
  maskErrors,
  reportErrors,
  serverTiming,
  signalOf,
} from "../src/index.ts";
import type { JsonObject, Plugin, Server } from "../src/index.ts";
import { subscribeOnce } from "../src/core/subscribe.ts";
import { flush, gate, gql, post, send, sleep } from "./support/http.ts";
import { makeSchema } from "./support/schema.ts";
import { fetchGraphQL, listen, readSse, readUntil } from "./support/stream.ts";
import type { Listening } from "./support/stream.ts";

const SSE = "text/event-stream; charset=utf-8";

/** Resolves once `signal` aborts. */
const aborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      resolve();
    }
    signal.addEventListener("abort", () => {
      resolve();
    });
  });

/** An executor whose incremental result closes with `close` (given the core's signal). */
const closingWith = (
  close: (signal: AbortSignal | undefined) => Promise<IteratorResult<never, undefined>>,
): Plugin => ({
  onExecute: (_input, args) => () => ({
    initialResult: { data: { hello: "world" }, hasNext: true },
    subsequentResults: {
      // A pull that never settles: only return() ends this result.
      next: () => gate<never>().promise,
      return: () => close(args.abortSignal ?? undefined),
      throw: (error: unknown) => Promise.reject(error),
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: () => Promise.resolve(),
    },
  }),
});

/**
 * A subscription schema with probes: source arguments, cleanups and an emitter for idle sources.
 * With `referenced`, another type refers to the Subscription type (`Query.root: Subscription`).
 */
const fixture = ({ referenced = false }: { readonly referenced?: boolean } = {}) => {
  const sourceArgs: Array<unknown> = [];
  const cleanups: Array<string> = [];
  const started: Array<string> = [];
  const emitter = new EventEmitter();
  const idleStarted = gate();
  const schema = makeSchema(
    `
      type Query { hello: String later: String${referenced ? " root: Subscription" : ""} }
      type Subscription {
        tick(n: Int!): Int
        changed(id: ID!): String
        forever: Int
        idle: Int
        waits: Int
        failing(kind: String!): Int
        refused: Int
        slowSetup: Int
        selfCleaningSetup: Int
        fresh: Int
      }
    `,
    {
      Query: { hello: () => "world", later: () => "later" },
      Subscription: {
        tick: (payload: number) => payload,
        changed: (payload: string) => payload,
        forever: (payload: number) => payload,
        idle: (payload: number) => payload,
        waits: (payload: number) => payload,
        failing: (payload: number) => payload,
      },
    },
  );
  const field = (name: string) => {
    const found = schema.getSubscriptionType()?.getFields()[name];
    if (found === undefined) {
      throw new Error(`no Subscription.${name}`);
    }
    return found;
  };
  Object.assign(field("tick"), {
    async *subscribe(_source: unknown, args: { n: number }) {
      for (let index = 1; index <= args.n; index += 1) {
        yield index;
      }
    },
  });
  Object.assign(field("changed"), {
    async *subscribe(_source: unknown, args: unknown) {
      sourceArgs.push(args);
      yield "changed";
    },
  });
  // Ticks every few milliseconds, forever: a source that is mid-stream when the client leaves.
  Object.assign(field("forever"), {
    async *subscribe() {
      started.push("forever");
      try {
        for (let index = 1; ; index += 1) {
          yield index;
          await sleep(5);
        }
      } finally {
        cleanups.push("forever");
      }
    },
  });
  // Waits on an event that never comes (node:events `on`, with the request's abort signal).
  Object.assign(field("idle"), {
    async *subscribe(_source: unknown, _args: unknown, _ctx: unknown, info: GraphQLResolveInfo) {
      started.push("idle");
      idleStarted.resolve();
      try {
        for await (const [value] of on(emitter, "idle", { signal: info.getAbortSignal() })) {
          yield value;
        }
      } finally {
        cleanups.push("idle");
      }
    },
  });
  // Waits directly on info.getAbortSignal(), with nothing to yield.
  Object.assign(field("waits"), {
    async *subscribe(_source: unknown, _args: unknown, _ctx: unknown, info: GraphQLResolveInfo) {
      started.push("waits");
      try {
        await aborted(info.getAbortSignal());
        yield 0;
      } finally {
        cleanups.push("waits");
      }
    },
  });
  // Yields one event, then throws a GraphQLError or a plain Error.
  Object.assign(field("failing"), {
    async *subscribe(_source: unknown, args: { kind: string }) {
      yield 1;
      await Promise.resolve();
      if (args.kind === "graphql") {
        throw new GraphQLError("a deliberate source error");
      }
      throw new Error("a secret source failure");
    },
  });
  // The source resolver throws before any event.
  Object.assign(field("refused"), {
    subscribe: () => {
      started.push("refused");
      throw new GraphQLError("not allowed", { extensions: { code: "FORBIDDEN" } });
    },
  });
  // The source resolver takes a while to set up (it resolves to the iterable once released).
  const setup = gate();
  const setupStarted = gate();
  let setupPulls = 0;
  let setupReturns = 0;
  Object.assign(field("slowSetup"), {
    subscribe: async () => {
      setupStarted.resolve();
      await setup.promise;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            setupPulls += 1;
            return Promise.resolve({ done: false, value: 1 });
          },
          return: () => {
            setupReturns += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
        }),
      };
    },
    resolve: (payload: number) => payload,
  });
  // The same slow setup, written the way docs/plan.html M4b asks of a source on graphql 17.1: it
  // watches info.getAbortSignal() and closes what it set up when the client has left meanwhile.
  Object.assign(field("selfCleaningSetup"), {
    subscribe: async (
      _source: unknown,
      _args: unknown,
      _context: unknown,
      info: GraphQLResolveInfo,
    ) => {
      setupStarted.resolve();
      await setup.promise;
      const iterable = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            setupPulls += 1;
            return Promise.resolve({ done: false, value: 1 });
          },
          return: () => {
            setupReturns += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
        }),
      };
      if (info.getAbortSignal()?.aborted === true) {
        await iterable[Symbol.asyncIterator]().return();
      }
      return iterable;
    },
    resolve: (payload: number) => payload,
  });
  // A plain AsyncIterable that makes a new iterator on every call. Each iterator's pull waits
  // until its return() releases it (an idle source that only return() can stop).
  const fresh = { iterators: 0, pulls: 0, returns: 0 };
  Object.assign(field("fresh"), {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => {
        fresh.iterators += 1;
        const release = Promise.withResolvers<IteratorResult<number>>();
        return {
          next: () => {
            fresh.pulls += 1;
            return release.promise;
          },
          return: () => {
            fresh.returns += 1;
            release.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    }),
    resolve: (payload: number) => payload,
  });
  return {
    schema,
    fresh,
    sourceArgs,
    cleanups,
    started,
    emitter,
    idleStarted,
    setup,
    setupStarted,
    setupPulls: () => setupPulls,
    setupReturns: () => setupReturns,
  };
};

/** Waits until `check` holds (polling), or fails after a while. */
const eventually = async (check: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await sleep(2);
  }
};

/** The schemas every source-lifecycle test runs on. */
const schemas = [
  ["a schema", false],
  ["a schema where Query.root is the Subscription type", true],
] as const;

const subscribe = (server: Server, query: string, extra: { variables?: JsonObject } = {}) =>
  server.handle(post({ query, ...extra }, { accept: "text/event-stream" }));

describe("GraphQL-over-SSE", () => {
  it("an SSE subscription delivers N events and then completes", async () => {
    const { schema } = fixture();
    const server = createServer({ schema });
    const response = await subscribe(server, "subscription { tick(n: 5) }");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(SSE);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const text = await response.text();
    expect(text).toBe(
      [1, 2, 3, 4, 5].map((n) => `event: next\ndata: {"data":{"tick":${n}}}\n\n`).join("") +
        "event: complete\ndata:\n\n",
    );
  });

  it("onResult sees every event; onResponse runs once and can change the headers", async () => {
    const { schema } = fixture();
    const seen: Array<unknown> = [];
    const responses: Array<number> = [];
    const plugins: ReadonlyArray<Plugin> = [
      serverTiming(),
      {
        onResult: (payload) => {
          seen.push(payload.data);
          return { ...payload, extensions: { seen: seen.length } };
        },
        onResponse: (response) => {
          responses.push(response.status);
        },
      },
    ];
    const server = createServer({ schema, plugins });
    const response = await subscribe(server, "subscription { tick(n: 3) }");
    expect(responses).toEqual([200]);
    expect(response.headers.get("server-timing")).toContain("total;dur=");
    const { names, payloads } = readSse(await response.text());
    expect(names).toEqual(["next", "next", "next", "complete"]);
    expect(seen).toEqual([{ tick: 1 }, { tick: 2 }, { tick: 3 }]);
    expect(payloads.map((payload) => payload.extensions)).toEqual([
      { seen: 1 },
      { seen: 2 },
      { seen: 3 },
    ]);
  });

  it("a source resolver that refuses gives one next event with its error, then complete", async () => {
    const { schema } = fixture();
    const server = createServer({ schema });
    const response = await server.handle(
      post(
        { query: "subscription { refused }" },
        { accept: "text/event-stream, application/json" },
      ),
    );
    expect(response.headers.get("content-type")).toBe(SSE);
    const { names, payloads } = readSse(await response.text());
    expect(names).toEqual(["next", "complete"]);
    expect(payloads[0]?.errors?.[0]).toMatchObject({
      message: "not allowed",
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("a client that does not accept text/event-stream gets a 406 before the source resolver runs", async () => {
    const { schema, started } = fixture();
    const server = createServer({ schema });
    const sent = await gql(server, "subscription { refused }", { accept: "application/json" });
    expect(sent.status).toBe(406);
    expect(sent.error?.message).toBe("A subscription needs Accept: text/event-stream.");
    expect(started).toEqual([]);
  });

  it.each([["text/event-stream"], ["text/*"], ["*/*"], [null]])(
    "Accept %s accepts it",
    async (accept) => {
      const { schema } = fixture();
      const server = createServer({ schema });
      const response = await server.handle(
        post({ query: "subscription { tick(n: 1) }" }, { accept }),
      );
      expect(response.headers.get("content-type")).toBe(SSE);
      expect(readSse(await response.text()).names).toEqual(["next", "complete"]);
    },
  );

  it("an SSE-only client gets a query's single result as one next event", async () => {
    const { schema } = fixture();
    const server = createServer({ schema });
    const response = await server.handle(
      post({ query: "{ hello }" }, { accept: "text/event-stream" }),
    );
    expect(response.headers.get("content-type")).toBe(SSE);
    const { names, payloads } = readSse(await response.text());
    expect(names).toEqual(["next", "complete"]);
    expect(payloads).toEqual([{ data: { hello: "world" } }]);
  });

  it("a client that left before its single result was framed gets an empty body", async () => {
    const { schema } = fixture();
    const client = new AbortController();
    // The client leaves while the result hooks run, so the stream starts on an aborted signal.
    const server = createServer({
      schema,
      plugins: [
        {
          onResult: () => {
            client.abort();
          },
        },
      ],
    });
    const response = await server.handle(
      post({ query: "{ hello }" }, { accept: "text/event-stream", signal: client.signal }),
    );
    expect(response.headers.get("content-type")).toBe(SSE);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["a validation error", { query: "subscription { nope }" }, /Cannot query field "nope"/, []],
    ["a syntax error", { query: "subscription {" }, /^Syntax Error/, []],
    [
      "a variable error",
      { query: "subscription S($n: Int!) { tick(n: $n) }", variables: { n: "x" } },
      /^Variable "\$n" has invalid value/,
      [],
    ],
    [
      "an unknown operation",
      { query: "subscription A { tick(n: 1) }", operationName: "B" },
      /^Unknown operation named "B"/,
      [],
    ],
    [
      "an onExecute refusal",
      { query: "subscription { tick(n: 1) }" },
      /^refused$/,
      [
        {
          onExecute: () => {
            throw new GraphQLError("refused");
          },
        },
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, unknown, RegExp, ReadonlyArray<Plugin>]>)(
    "an SSE-only client gets %s as a next event, then complete, with a 200",
    async (_name, body, message, plugins) => {
      const { schema } = fixture();
      const server = createServer({ schema, plugins });
      const response = await server.handle(post(body, { accept: "text/event-stream" }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(SSE);
      const { names, payloads } = readSse(await response.text());
      expect(names).toEqual(["next", "complete"]);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.data).toBeUndefined();
      expect(payloads[0]?.errors?.[0]?.message).toMatch(message);
    },
  );

  it.each([
    [
      "an unsupported Content-Type",
      post({ query: "{ hello }" }, { accept: "text/event-stream", contentType: "text/plain" }),
      415,
      "Content-Type must be application/json.",
    ],
    [
      "a body that is not JSON",
      post("{", { accept: "text/event-stream" }),
      400,
      "The request body is not valid JSON.",
    ],
    [
      "a body that is not a GraphQL-over-HTTP request",
      post({ query: "{ hello }", variables: [] }, { accept: "text/event-stream" }),
      400,
      "`variables` must be an object.",
    ],
    [
      "a body without a query",
      post({}, { accept: "text/event-stream" }),
      400,
      "Must provide a query string.",
    ],
  ])(
    "an SSE-only client gets %s as a transport failure: JSON with its status",
    async (_name, request, status, message) => {
      const { schema } = fixture();
      const server = createServer({ schema });
      const sent = await send(server, request);
      expect(sent.status).toBe(status);
      expect(sent.headers.get("content-type")).toBe(
        "application/graphql-response+json; charset=utf-8",
      );
      expect(sent.body).toEqual({ errors: [{ message }] });
    },
  );

  it("an SSE-only client gets a 406 for an incremental response it cannot accept", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const sent = await send(
      server,
      post({ query: "{ hello ... @defer { later } }" }, { accept: "text/event-stream" }),
    );
    expect(sent.status).toBe(406);
    expect(sent.headers.get("content-type")).toBe(
      "application/graphql-response+json; charset=utf-8",
    );
    expect(sent.error?.message).toBe(
      "This operation uses @defer or @stream, which needs Accept: multipart/mixed.",
    );
  });

  it.each([
    ["rejects", (): Promise<never> => Promise.reject(new Error("cleanup failed"))],
    [
      "waits on the core's signal",
      async (signal: AbortSignal | undefined) => {
        await aborted(signal);
        return { done: true, value: undefined } as const;
      },
    ],
  ] as const)(
    "an SSE-only client gets the JSON 406 for an incremental response whose cleanup %s",
    async (name, close) => {
      const { schema } = fixture();
      const logged: Array<string> = [];
      const server = createServer({
        schema,
        plugins: [incremental(), closingWith(close)],
        logger: { warn: () => undefined, error: (message) => logged.push(message) },
      });
      const sent = await Promise.race([
        send(server, post({ query: "{ hello }" }, { accept: "text/event-stream" })),
        sleep(1000).then(() => "hung" as const),
      ]);
      expect(sent).not.toBe("hung");
      if (sent === "hung") {
        return;
      }
      expect(sent.status).toBe(406);
      expect(sent.headers.get("content-type")).toBe(
        "application/graphql-response+json; charset=utf-8",
      );
      expect(sent.error?.message).toBe(
        "This operation uses @defer or @stream, which needs Accept: multipart/mixed.",
      );
      expect(logged).toEqual(
        name === "rejects" ? ["gratos-server: closing a streamed result failed."] : [],
      );
    },
  );

  it("a client that accepts JSON too still gets request errors as JSON", async () => {
    const { schema } = fixture();
    const server = createServer({ schema });
    const sent = await gql(server, "subscription { nope }", {
      accept: "text/event-stream, application/graphql-response+json",
    });
    expect(sent.status).toBe(400);
    expect(sent.headers.get("content-type")).toBe(
      "application/graphql-response+json; charset=utf-8",
    );
  });
});

describe("a standalone handle(Request): cancelling the body", () => {
  it("aborts the core signal while the source waits on info.getAbortSignal(), and its cleanup runs", async () => {
    const { schema, cleanups, started } = fixture();
    const server = createServer({ schema });
    const request = post({ query: "subscription { waits }" }, { accept: "text/event-stream" });
    const response = await server.handle(request);
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const reader = body.getReader();
    // The transport asks for the first event: the source starts and waits.
    const read = reader.read();
    await eventually(() => started.includes("waits"));
    expect(signalOf(request)?.aborted).toBe(false);
    await reader.cancel();
    expect(signalOf(request)?.aborted).toBe(true);
    expect(await read).toEqual({ done: true, value: undefined });
    await eventually(() => cleanups.includes("waits"));
  });

  it.each(schemas)(
    "closes the iterator it reads, for a source that makes a new iterator on every call (%s)",
    async (_name, referenced) => {
      const { schema, fresh } = fixture({ referenced });
      const server = createServer({ schema });
      const request = post({ query: "subscription { fresh }" }, { accept: "text/event-stream" });
      const response = await server.handle(request);
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("no body");
      }
      const read = reader.read();
      await eventually(() => fresh.pulls === 1);
      // subscribe() asked the source once: it reads and closes the same iterator.
      expect(fresh.iterators).toBe(1);
      // return() reaches the iterator whose pull is pending and releases it, so the cancel ends.
      const timedOut = sleep(1000).then(() => "the body cancel hangs");
      expect(await Promise.race([reader.cancel().then(() => "cancelled"), timedOut])).toBe(
        "cancelled",
      );
      expect(await read).toEqual({ done: true, value: undefined });
      expect(signalOf(request)?.aborted).toBe(true);
      expect(fresh).toEqual({ iterators: 1, pulls: 1, returns: 1 });
    },
  );

  it("stops a source that is mid-stream: its finally runs, nothing is reported", async () => {
    const { schema, cleanups } = fixture();
    const reported: Array<GraphQLError> = [];
    const server = createServer({
      schema,
      plugins: [
        reportErrors((error) => {
          reported.push(error);
        }),
      ],
    });
    const request = post({ query: "subscription { forever }" }, { accept: "text/event-stream" });
    const response = await server.handle(request);
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const { text, reader } = await readUntil(body, (sofar) => sofar.includes('"forever":3'));
    expect(readSse(text).names).toEqual(["next", "next", "next"]);
    await reader.cancel();
    await eventually(() => cleanups.includes("forever"));
    expect(reported).toEqual([]);
  });

  // graphql 17.1 drops a source whose setup (a Promise from the source resolver) finishes after
  // the client left, without calling its return(): the core never receives it. A source that
  // must release what it set up watches info.getAbortSignal() (selfCleaningSetup). An upstream
  // graphql-js fix is a follow-up; the core does not patch graphql.
  it.each(
    schemas.flatMap(
      ([name, referenced]) =>
        [
          [`${name}, a source that ignores the signal`, referenced, "slowSetup", 0],
          [`${name}, a source that watches the signal`, referenced, "selfCleaningSetup", 1],
        ] as const,
    ),
  )(
    "a client that leaves while the source is set up gets a 499, unreported, never pulled (%s)",
    async (_name, referenced, field, returns) => {
      const { schema, setup, setupStarted, setupPulls, setupReturns } = fixture({ referenced });
      const responses: Array<number> = [];
      const reported: Array<GraphQLError> = [];
      const server = createServer({
        schema,
        plugins: [
          reportErrors((error) => {
            reported.push(error);
          }),
          {
            onResponse: (response) => {
              responses.push(response.status);
            },
          },
        ],
      });
      const client = new AbortController();
      const pending = server.handle(
        post(
          { query: `subscription { ${field} }` },
          { accept: "text/event-stream", signal: client.signal },
        ),
      );
      await setupStarted.promise;
      client.abort();
      setup.resolve();
      const response = await pending;
      expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
      expect(responses).toEqual([CLIENT_CLOSED_REQUEST]);
      // graphql's subscribe() answered with an AbortError at the field, which is not reported.
      expect(reported).toEqual([]);
      await flush();
      expect(setupReturns()).toBe(returns);
      expect(setupPulls()).toBe(0);
    },
  );

  it("a result hook that throws on a later event fails the body and stops the source", async () => {
    const { schema, cleanups } = fixture();
    const errors: Array<unknown> = [];
    let events = 0;
    const server = createServer({
      schema,
      logger: { warn: () => undefined, error: (_message, details) => errors.push(details) },
      plugins: [
        {
          onResult: () => {
            events += 1;
            if (events === 2) {
              throw new Error("hook failure");
            }
            return undefined;
          },
        },
      ],
    });
    const request = post({ query: "subscription { forever }" }, { accept: "text/event-stream" });
    const response = await server.handle(request);
    await expect(response.text()).rejects.toThrow("hook failure");
    expect(signalOf(request)?.aborted).toBe(true);
    expect(errors).toHaveLength(1);
    await eventually(() => cleanups.includes("forever"));
  });

  it("an event that cannot be serialized fails the body and stops the source", async () => {
    const { schema, cleanups } = fixture();
    const errors: Array<unknown> = [];
    let events = 0;
    const server = createServer({
      schema,
      logger: { warn: () => undefined, error: (_message, details) => errors.push(details) },
      plugins: [
        {
          // A bigint in the extensions of the second event: JSON.stringify throws on it.
          onResult: (payload) => {
            events += 1;
            return events === 2 ? { ...payload, extensions: { big: 1n } } : undefined;
          },
        },
      ],
    });
    const request = post({ query: "subscription { forever }" }, { accept: "text/event-stream" });
    const response = await server.handle(request);
    await expect(response.text()).rejects.toThrow(/BigInt/);
    expect(signalOf(request)?.aborted).toBe(true);
    expect(errors).toHaveLength(1);
    await eventually(() => cleanups.includes("forever"));
  });

  it("a client that leaves while a result hook runs: the event is not serialized and nothing is logged", async () => {
    const { schema, cleanups } = fixture();
    const client = new AbortController();
    const logged: Array<unknown> = [];
    let serialized = 0;
    let events = 0;
    const server = createServer({
      schema,
      logger: { warn: () => undefined, error: (message) => logged.push(message) },
      plugins: [
        {
          // On the second event the client leaves, and the hook hands back a payload that
          // cannot be serialized (it counts each attempt).
          onResult: (payload) => {
            events += 1;
            if (events !== 2) {
              return undefined;
            }
            client.abort();
            const probe = {
              toJSON: () => {
                serialized += 1;
                throw new Error("serialized after the client left");
              },
            };
            return { ...payload, extensions: { probe } };
          },
        },
      ],
    });
    const response = await server.handle(
      post(
        { query: "subscription { forever }" },
        { accept: "text/event-stream", signal: client.signal },
      ),
    );
    expect(readSse(await response.text()).names).toEqual(["next"]);
    await eventually(() => cleanups.includes("forever"));
    await flush();
    expect(serialized).toBe(0);
    expect(logged).toEqual([]);
  });

  it("a client that leaves while an event is serialized: the event is not sent and nothing fails", async () => {
    const { schema, cleanups } = fixture();
    const client = new AbortController();
    const logged: Array<unknown> = [];
    let events = 0;
    const server = createServer({
      schema,
      logger: { warn: () => undefined, error: (message) => logged.push(message) },
      plugins: [
        {
          // The second event's extensions make the client leave while they are serialized.
          onResult: (payload) => {
            events += 1;
            if (events !== 2) {
              return undefined;
            }
            const probe = {
              toJSON: () => {
                client.abort();
                return "left";
              },
            };
            return { ...payload, extensions: { probe } };
          },
        },
      ],
    });
    const response = await server.handle(
      post(
        { query: "subscription { forever }" },
        { accept: "text/event-stream", signal: client.signal },
      ),
    );
    const text = await response.text();
    expect(text).not.toContain("left");
    expect(readSse(text).names).toEqual(["next"]);
    await eventually(() => cleanups.includes("forever"));
    await flush();
    expect(logged).toEqual([]);
  });

  it("a Request signal that aborts without a body cancel still stops the source", async () => {
    const { schema, cleanups, idleStarted } = fixture();
    const server = createServer({ schema });
    const client = new AbortController();
    const response = await server.handle(
      post(
        { query: "subscription { idle }" },
        { accept: "text/event-stream", signal: client.signal },
      ),
    );
    const reader = response.body?.getReader();
    const read = reader?.read();
    await idleStarted.promise;
    client.abort();
    await eventually(() => cleanups.includes("idle"));
    // Nothing is sent after the client left: the stream just ends.
    expect(await read).toEqual({ done: true, value: undefined });
  });
});

describe("over real HTTP (node:http)", () => {
  let listening: Listening | undefined;
  afterEach(async () => {
    await listening?.close();
    listening = undefined;
  });

  const serve = async (server: Server): Promise<string> => {
    listening = await listen(server);
    return listening.url;
  };

  it("an SSE subscription delivers N events and then completes", async () => {
    const { schema } = fixture();
    const url = await serve(createServer({ schema }));
    const response = await fetchGraphQL(
      url,
      { query: "subscription { tick(n: 4) }" },
      {
        accept: "text/event-stream",
      },
    );
    expect(response.headers.get("content-type")).toBe(SSE);
    const { names, payloads } = readSse(await response.text());
    expect(names).toEqual(["next", "next", "next", "next", "complete"]);
    expect(payloads.map((payload) => payload.data)).toEqual([
      { tick: 1 },
      { tick: 2 },
      { tick: 3 },
      { tick: 4 },
    ]);
  });

  it.each([
    ["graphql", "a deliberate source error", "a deliberate source error"],
    ["plain", "Unexpected error.", "a secret source failure"],
  ])(
    "a source that throws a %s error mid-subscription gives one error event, then complete",
    async (kind, sent, reportedMessage) => {
      const { schema } = fixture();
      const reported: Array<string> = [];
      const url = await serve(
        createServer({
          schema,
          plugins: [
            reportErrors((error) => {
              reported.push(error.message);
            }),
            maskErrors(),
          ],
        }),
      );
      const response = await fetchGraphQL(
        url,
        { query: `subscription { failing(kind: "${kind}") }` },
        { accept: "text/event-stream" },
      );
      const text = await response.text();
      expect(text).not.toContain("secret");
      const { names, payloads } = readSse(text);
      expect(names).toEqual(["next", "next", "complete"]);
      expect(payloads).toEqual([{ data: { failing: 1 } }, { errors: [{ message: sent }] }]);
      expect(reported).toEqual([reportedMessage]);
    },
  );

  it.each([
    ["mid-stream (a ticking source)", "forever", "forever"],
    ["idle (a source with nothing to yield)", "idle", "idle"],
  ])(
    "a client that disconnects %s triggers the source's finally",
    async (_name, field, cleanup) => {
      const { schema, cleanups, started } = fixture();
      const reported: Array<GraphQLError> = [];
      const url = await serve(
        createServer({
          schema,
          plugins: [
            reportErrors((error) => {
              reported.push(error);
            }),
          ],
        }),
      );
      const client = new AbortController();
      const response = await fetchGraphQL(
        url,
        { query: `subscription { ${field} }` },
        {
          accept: "text/event-stream",
          signal: client.signal,
        },
      );
      expect(response.status).toBe(200);
      await eventually(() => started.includes(field));
      if (field === "forever") {
        const body = response.body;
        if (body === null) {
          throw new Error("no body");
        }
        await readUntil(body, (sofar) => sofar.includes('"forever":2'));
      }
      expect(cleanups).toEqual([]);
      client.abort();
      await eventually(() => cleanups.includes(cleanup));
      expect(reported).toEqual([]);
    },
  );
});

describe("regression: a document holding a deferred query and a subscription", () => {
  it("with the subscription selected, streams events and is not answered once", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental(), jit({ after: 1 })] });
    const query = `
      query Deferred { hello ... @defer { later } }
      subscription Ticks { tick(n: 3) }
    `;
    for (let use = 0; use < 3; use += 1) {
      const response = await server.handle(
        post({ query, operationName: "Ticks" }, { accept: "text/event-stream, application/json" }),
      );
      expect(response.headers.get("content-type")).toBe(SSE);
      const { names, payloads } = readSse(await response.text());
      expect(names).toEqual(["next", "next", "next", "complete"]);
      expect(payloads.map((payload) => payload.data)).toEqual([
        { tick: 1 },
        { tick: 2 },
        { tick: 3 },
      ]);
    }
  });
});

describe("regression: subscription source arguments past the jit threshold", () => {
  it.each([
    ['changed(id: "o-1")', 'subscription { changed(id: "o-1") }', {}],
    [
      "changed(id: $order)",
      "subscription S($order: ID!) { changed(id: $order) }",
      { order: "o-1" },
    ],
  ])("the source resolver of %s receives { id }", async (_name, query, variables) => {
    const { schema, sourceArgs } = fixture();
    const server = createServer({ schema, plugins: [incremental(), jit({ after: 2 })] });
    for (let use = 0; use < 5; use += 1) {
      const response = await subscribe(server, query, { variables });
      expect(readSse(await response.text()).payloads).toEqual([{ data: { changed: "changed" } }]);
    }
    expect(sourceArgs).toEqual(Array.from({ length: 5 }, () => ({ id: "o-1" })));
  });
});

describe("onExecute and subscriptions", () => {
  it("a claim cannot answer a subscription: it still streams through subscribe()", async () => {
    const { schema } = fixture();
    const hooks: Array<string> = [];
    let claimed = 0;
    const oneShot: Plugin = {
      onExecute: ({ operation }) => {
        hooks.push(operation.operation);
        return () => {
          claimed += 1;
          return { data: { tick: null } };
        };
      },
    };
    const server = createServer({ schema, plugins: [oneShot] });
    const response = await subscribe(server, "subscription { tick(n: 2) }");
    const { names, payloads } = readSse(await response.text());
    expect(names).toEqual(["next", "next", "complete"]);
    expect(payloads.map((payload) => payload.data)).toEqual([{ tick: 1 }, { tick: 2 }]);
    expect(hooks).toEqual(["subscription"]);
    expect(claimed).toBe(0);
  });

  it("a refusal still refuses a subscription, after an earlier claim", async () => {
    const { schema, started } = fixture();
    const server = createServer({
      schema,
      plugins: [
        { onExecute: () => () => ({ data: null }) },
        {
          onExecute: () => {
            throw new GraphQLError("no subscriptions here", { extensions: { code: "REFUSED" } });
          },
        },
      ],
    });
    const response = await server.handle(
      post(
        { query: "subscription { tick(n: 2) }" },
        { accept: "text/event-stream, application/graphql-response+json" },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: [{ message: "no subscriptions here", extensions: { code: "REFUSED" } }],
    });
    expect(started).toEqual([]);
  });
});

describe("the default executor", () => {
  it("runs a subscription on a schema in which another type refers to the Subscription type", async () => {
    const schema = makeSchema(
      `
        type Query { root: Subscription }
        type Subscription { tick(n: Int!): Int }
      `,
      { Subscription: { tick: (payload: number) => payload } },
    );
    const tick = schema.getSubscriptionType()?.getFields()["tick"];
    Object.assign(tick ?? {}, {
      async *subscribe(_source: unknown, args: { n: number }) {
        for (let index = 1; index <= args.n; index += 1) {
          yield index;
        }
      },
    });
    const server = createServer({ schema });
    const response = await subscribe(server, "subscription { tick(n: 2) }");
    expect(readSse(await response.text()).payloads).toEqual([
      { data: { tick: 1 } },
      { data: { tick: 2 } },
    ]);
  });

  it("runs on the pinned schema itself: a resolver changed before replaceSchema(same schema) runs", async () => {
    const { schema } = fixture();
    const server = createServer({ schema });
    const first = await subscribe(server, "subscription { tick(n: 1) }");
    expect(readSse(await first.text()).payloads).toEqual([{ data: { tick: 1 } }]);
    const tick = schema.getSubscriptionType()?.getFields()["tick"];
    if (tick === undefined) {
      throw new Error("no Subscription.tick");
    }
    const seen: Array<GraphQLResolveInfo> = [];
    Object.assign(tick, {
      async *subscribe(_source: unknown, _args: unknown, _ctx: unknown, info: GraphQLResolveInfo) {
        seen.push(info);
        yield 42;
      },
      resolve: (payload: number, _args: unknown, _ctx: unknown, info: GraphQLResolveInfo) => {
        seen.push(info);
        return payload;
      },
    });
    server.control.replaceSchema(schema);
    const second = await subscribe(server, "subscription { tick(n: 1) }");
    expect(readSse(await second.text()).payloads).toEqual([{ data: { tick: 42 } }]);
    expect(seen).toHaveLength(2);
    for (const info of seen) {
      expect(info.schema).toBe(schema);
      expect(info.parentType).toBe(schema.getSubscriptionType());
    }
  });

  it("runs a subscription through subscribe() even on a schema with @defer", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const response = await subscribe(server, "subscription { tick(n: 2) }");
    expect(readSse(await response.text()).names).toEqual(["next", "next", "complete"]);
    await flush();
  });
});

/** A schema whose `counted` source yields `n` events from one counting iterator. */
const counted = (n: number) => {
  const probe = { iterators: 0, pulls: 0, returns: 0 };
  const schema = makeSchema(
    `
      type Query { hello: String }
      type Subscription { counted: Int }
    `,
    { Subscription: { counted: (payload: number) => payload } },
  );
  Object.assign(schema.getSubscriptionType()?.getFields()["counted"] ?? {}, {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => {
        probe.iterators += 1;
        let sent = 0;
        return {
          next: () => {
            probe.pulls += 1;
            sent += 1;
            return Promise.resolve(
              sent > n ? { done: true, value: undefined } : { done: false, value: sent },
            );
          },
          return: () => {
            probe.returns += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    }),
  });
  return { schema, probe };
};

const streamOf = async (n: number) => {
  const { schema, probe } = counted(n);
  const result = await subscribeOnce({ schema, document: parse("subscription { counted }") });
  if (!(Symbol.asyncIterator in result)) {
    throw new Error("no stream");
  }
  return { stream: result, probe };
};

describe("the response stream of a subscription", () => {
  it("return() before the first pull closes the source, once", async () => {
    const { stream, probe } = await streamOf(3);
    await stream.return();
    await stream.return();
    expect(probe).toEqual({ iterators: 1, pulls: 0, returns: 1 });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it("a source that ended is not closed again", async () => {
    const { stream, probe } = await streamOf(1);
    expect(await stream.next()).toEqual({ done: false, value: { data: { counted: 1 } } });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    await stream.return();
    expect(probe).toEqual({ iterators: 1, pulls: 2, returns: 0 });
  });
});

/**
 * A schema whose `probed` source is one hand-written iterator: it yields 1, 2, … unless `stuck`,
 * when every pull stays pending forever (return() still resolves); it has a throw() only when
 * `throws`, which ends the iterator unless `catches` (then it goes on). The probe records every
 * call.
 */
const probed = ({ stuck = false, throws = false, catches = false } = {}) => {
  const probe = { pulls: 0, returns: 0, throws: [] as Array<unknown> };
  const schema = makeSchema(
    `
      type Query { hello: String }
      type Subscription { probed: Int }
    `,
    { Subscription: { probed: (payload: number) => payload } },
  );
  const done = { done: true, value: undefined } as const;
  const iterator: AsyncIterator<number> = {
    next: () => {
      probe.pulls += 1;
      return stuck ? gate<never>().promise : Promise.resolve({ done: false, value: probe.pulls });
    },
    return: () => {
      probe.returns += 1;
      return Promise.resolve(done);
    },
  };
  if (throws) {
    iterator.throw = (error: unknown) => {
      probe.throws.push(error);
      return Promise.resolve(catches ? { done: false, value: 0 } : done);
    };
  }
  Object.assign(schema.getSubscriptionType()?.getFields()["probed"] ?? {}, {
    subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }),
  });
  return { schema, probe };
};

const probedStream = async (
  options: { stuck?: boolean; throws?: boolean; catches?: boolean } = {},
) => {
  const { schema, probe } = probed(options);
  const result = await subscribeOnce({ schema, document: parse("subscription { probed }") });
  if (!(Symbol.asyncIterator in result)) {
    throw new Error("no stream");
  }
  return { stream: result, probe };
};

describe("closing the response stream while a source pull never settles", () => {
  it("return() settles the pending pull and closes the source once", async () => {
    const { stream, probe } = await probedStream({ stuck: true });
    const pending = stream.next();
    await flush();
    expect(probe.pulls).toBe(1);
    const timedOut = sleep(1000).then(() => "return() hangs");
    expect(await Promise.race([stream.return().then(() => "returned"), timedOut])).toBe("returned");
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    expect(probe).toEqual({ pulls: 1, returns: 1, throws: [] });
  });

  it("a body cancel ends while the source's pull is pending, and return() is called once", async () => {
    const { schema, probe } = probed({ stuck: true });
    const server = createServer({ schema });
    const request = post({ query: "subscription { probed }" }, { accept: "text/event-stream" });
    const response = await server.handle(request);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("no body");
    }
    const read = reader.read();
    await eventually(() => probe.pulls === 1);
    const timedOut = sleep(1000).then(() => "the body cancel hangs");
    expect(await Promise.race([reader.cancel().then(() => "cancelled"), timedOut])).toBe(
      "cancelled",
    );
    expect(await read).toEqual({ done: true, value: undefined });
    expect(probe).toEqual({ pulls: 1, returns: 1, throws: [] });
  });
});

describe("throw() on the response stream", () => {
  const error = new Error("thrown by the consumer");

  it.each([
    ["before the first pull", 0],
    ["between events", 1],
  ])("%s, forwards to the source's throw(), once, and rejects", async (_name, events) => {
    const { stream, probe } = await probedStream({ throws: true });
    for (let index = 0; index < events; index += 1) {
      expect((await stream.next()).done).toBe(false);
    }
    await expect(stream.throw(error)).rejects.toBe(error);
    expect(probe).toEqual({ pulls: events, returns: 0, throws: [error] });
    await expect(stream.throw(error)).rejects.toBe(error);
    await stream.return();
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    expect(probe).toEqual({ pulls: events, returns: 0, throws: [error] });
  });

  it("closes a source whose throw() catches the error and goes on through return(), once", async () => {
    const { stream, probe } = await probedStream({ throws: true, catches: true });
    await expect(stream.throw(error)).rejects.toBe(error);
    await stream.return();
    expect(probe).toEqual({ pulls: 0, returns: 1, throws: [error] });
  });

  it.each([
    ["before the first pull", 0],
    ["between events", 1],
  ])("%s, closes a source without throw() through return(), once", async (_name, events) => {
    const { stream, probe } = await probedStream();
    for (let index = 0; index < events; index += 1) {
      expect((await stream.next()).done).toBe(false);
    }
    await expect(stream.throw(error)).rejects.toBe(error);
    expect(probe).toEqual({ pulls: events, returns: 1, throws: [] });
    await stream.return();
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    expect(probe).toEqual({ pulls: events, returns: 1, throws: [] });
  });
});
