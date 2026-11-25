// Subscriptions (docs/plan.html M4b): always graphql-js subscribe(), encoded as GraphQL-over-SSE
// "distinct connections"; errors from a failing source; disconnects over a standalone
// handle(Request) and over real HTTP (node:http); and the plan's regression tests.
import { on } from "node:events";
import { EventEmitter } from "node:events";

import { GraphQLError } from "graphql";
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
import { flush, gate, gql, post, sleep } from "./support/http.ts";
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

/** A subscription schema with probes: source arguments, cleanups and an emitter for idle sources. */
const fixture = () => {
  const sourceArgs: Array<unknown> = [];
  const cleanups: Array<string> = [];
  const started: Array<string> = [];
  const emitter = new EventEmitter();
  const idleStarted = gate();
  const schema = makeSchema(
    `
      type Query { hello: String later: String }
      type Subscription {
        tick(n: Int!): Int
        changed(id: ID!): String
        forever: Int
        idle: Int
        waits: Int
        failing(kind: String!): Int
        refused: Int
        slowSetup: Int
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
          return: () => Promise.resolve({ done: true, value: undefined }),
        }),
      };
    },
    resolve: (payload: number) => payload,
  });
  return {
    schema,
    sourceArgs,
    cleanups,
    started,
    emitter,
    idleStarted,
    setup,
    setupStarted,
    setupPulls: () => setupPulls,
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

  it("an SSE-only client gets request errors as JSON", async () => {
    const { schema } = fixture();
    const server = createServer({ schema });
    const sent = await gql(server, "subscription { nope }", { accept: "text/event-stream" });
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

  it("a client that leaves while the source is set up gets a 499, unreported; the source is never pulled", async () => {
    const { schema, setup, setupStarted, setupPulls } = fixture();
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
        { query: "subscription { slowSetup }" },
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
    // graphql 17.1 drops a source iterable that resolves after the abort (it never calls its
    // return()), so a source with setup work watches info.getAbortSignal() itself.
    await flush();
    expect(setupPulls()).toBe(0);
  });

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

describe("the default executor", () => {
  it("runs a subscription through subscribe() even on a schema with @defer", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const response = await subscribe(server, "subscription { tick(n: 2) }");
    expect(readSse(await response.text()).names).toEqual(["next", "next", "complete"]);
    await flush();
  });
});
