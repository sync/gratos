// The core plugins (docs/plan.html M4a, "Plugins"): apq(), reportErrors(log), maskErrors(), and
// the tested references serverTiming(), maxDepth() and readOnly(). Also the body rule: a plugin
// that replaces the Response keeps its body, so a body wrapper ends whatever the plugin order.
import { getOperationAST, GraphQLError, Kind, parse } from "graphql";
import type { GraphQLResolveInfo } from "graphql";
import { describe, expect, it, vi } from "vitest";

import {
  apq,
  CLIENT_CLOSED_REQUEST,
  createServer,
  gqlError,
  jit,
  maskErrors,
  maxDepth,
  mutationOf,
  readOnly,
  reportErrors,
  selectionDepth,
  serverTiming,
  sha256Hex,
  signalOf,
} from "../src/index.ts";
import type { Plugin } from "../src/index.ts";
import { gate, gql, post, send } from "./support/http.ts";
import { basicSchema } from "./support/schema.ts";

const persisted = (sha256Hash: string, version = 1) => ({
  persistedQuery: { version, sha256Hash },
});

describe("apq()", () => {
  const query = "{ count }";

  it("a hash-only request for an unknown hash gets PERSISTED_QUERY_NOT_FOUND", async () => {
    const server = createServer({ schema: basicSchema(), plugins: [apq()] });
    const sent = await send(server, post({ extensions: persisted(await sha256Hex(query)) }));
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      errors: [
        { message: "PersistedQueryNotFound", extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } },
      ],
    });
  });

  it("stores a query sent with its hash, then answers hash-only requests", async () => {
    const server = createServer({ schema: basicSchema(), plugins: [apq()] });
    const hash = await sha256Hex(query);
    expect((await send(server, post({ query, extensions: persisted(hash) }))).body).toEqual({
      data: { count: 1 },
    });
    expect((await send(server, post({ extensions: persisted(hash) }))).body).toEqual({
      data: { count: 1 },
    });
    expect((await send(server, post({ extensions: persisted(hash.toUpperCase()) }))).status).toBe(
      200,
    );
  });

  it("refuses a hash that does not match the query", async () => {
    const server = createServer({ schema: basicSchema(), plugins: [apq()] });
    const sent = await send(
      server,
      post({ query, extensions: persisted(await sha256Hex("{ hello }")) }),
    );
    expect(sent.status).toBe(400);
    expect(sent.error).toEqual({
      message: "provided sha does not match query",
      extensions: { code: "PERSISTED_QUERY_HASH_MISMATCH" },
    });
  });

  it("refuses an unsupported version", async () => {
    const server = createServer({ schema: basicSchema(), plugins: [apq()] });
    const sent = await send(
      server,
      post({ query, extensions: persisted(await sha256Hex(query), 2) }),
    );
    expect(sent.status).toBe(400);
    expect(sent.error?.extensions?.["code"]).toBe("PERSISTED_QUERY_NOT_SUPPORTED");
  });

  it("stores only after validation passes", async () => {
    const server = createServer({ schema: basicSchema(), plugins: [apq()] });
    const invalid = "{ nope }";
    const hash = await sha256Hex(invalid);
    expect((await send(server, post({ query: invalid, extensions: persisted(hash) }))).status).toBe(
      400,
    );
    const sent = await send(server, post({ extensions: persisted(hash) }));
    expect(sent.error?.extensions?.["code"]).toBe("PERSISTED_QUERY_NOT_FOUND");
  });

  it("never stores a query that a later onParams hook replaced before validation", async () => {
    const store = new Map<string, string>();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        apq({ store: { get: (hash) => store.get(hash), set: (hash, q) => store.set(hash, q) } }),
        { onParams: (params) => ({ ...params, query: "{ count }" }) },
      ],
    });
    const invalid = "{ nope }";
    const hash = await sha256Hex(invalid);
    // The core validated (and ran) "{ count }", not the text sent under the hash.
    const sent = await send(server, post({ query: invalid, extensions: persisted(hash) }));
    expect(sent.body).toEqual({ data: { count: 1 } });
    expect(store.has(hash)).toBe(false);
  });

  it("leaves requests without persistedQuery alone, and uses a custom store", async () => {
    const store = new Map<string, string>();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        apq({ store: { get: (hash) => store.get(hash), set: (hash, q) => store.set(hash, q) } }),
      ],
    });
    expect((await gql(server, query)).body).toEqual({ data: { count: 1 } });
    expect(store.size).toBe(0);
    const hash = await sha256Hex(query);
    await send(server, post({ query, extensions: persisted(hash) }));
    expect(store.get(hash)).toBe(query);
  });
});

describe("reportErrors(log)", () => {
  it("sees every error of an execution result, with the context and the request", async () => {
    const log = vi.fn();
    const ctx = { user: "ada" };
    const server = createServer({
      schema: basicSchema(),
      context: () => ctx,
      plugins: [reportErrors(log)],
    });
    const request = post({ query: "{ a: fails b: fails count }" });
    await server.handle(request);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toBeInstanceOf(GraphQLError);
    expect(log.mock.calls[0]?.[0].message).toBe("boom");
    expect(log.mock.calls[0]?.[1]).toBe(ctx);
    expect(log.mock.calls[0]?.[2]).toBe(request);
  });

  it("listed before maskErrors(), it sees the unmasked errors", async () => {
    const log = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      plugins: [reportErrors(log), maskErrors()],
    });
    const sent = await gql(server, "{ fails }");
    expect(sent.error?.message).toBe("Unexpected error.");
    expect(log.mock.calls[0]?.[0].message).toBe("boom");
  });

  it("is not called when the client left and execution was aborted", async () => {
    const log = vi.fn();
    const started = gate();
    const server = createServer({
      schema: basicSchema({
        Query: {
          hello: (_s, _a, _c, info: GraphQLResolveInfo) =>
            new Promise((_resolve, reject) => {
              started.resolve();
              info.getAbortSignal()?.addEventListener("abort", () => {
                reject(new Error("aborted"));
              });
            }),
        },
      }),
      plugins: [reportErrors(log)],
    });
    const client = new AbortController();
    const pending = server.handle(post({ query: "{ hello }" }, { signal: client.signal }));
    await started.promise;
    client.abort();
    expect((await pending).status).toBe(CLIENT_CLOSED_REQUEST);
    expect(log).not.toHaveBeenCalled();
  });
});

const maskSchema = () =>
  basicSchema({
    Query: {
      hello: () => {
        throw new GraphQLError("Deliberate", { extensions: { code: "NOPE" } });
      },
      failsNonNull: () => {
        throw gqlError("Not signed in", 401);
      },
    },
  });

describe("maskErrors()", () => {
  it.each([
    ["graphql-js", 99],
    ["graphql-jit", 1],
  ])("masks unexpected errors and keeps deliberate ones (%s)", async (_name, after) => {
    const server = createServer({ schema: maskSchema(), plugins: [jit({ after }), maskErrors()] });
    await gql(server, "{ count fails hello }");
    const sent = await gql(server, "{ count fails hello }");
    expect(sent.body?.data).toEqual({ count: 1, fails: null, hello: null });
    const byPath = Object.fromEntries(
      (sent.body?.errors ?? []).map((error) => [String(error.path), error]),
    );
    expect(byPath["fails"]).toEqual({
      message: "Unexpected error.",
      path: ["fails"],
      locations: [{ line: 1, column: 9 }],
    });
    expect(byPath["hello"]).toMatchObject({ message: "Deliberate", extensions: { code: "NOPE" } });
  });

  it("keeps gqlError and its status", async () => {
    const server = createServer({ schema: maskSchema(), plugins: [maskErrors()] });
    const sent = await gql(server, "{ failsNonNull }");
    expect(sent.status).toBe(401);
    expect(sent.error?.message).toBe("Not signed in");
  });

  it("takes a custom message", async () => {
    const server = createServer({
      schema: maskSchema(),
      plugins: [maskErrors({ message: "Oops" })],
    });
    expect((await gql(server, "{ fails }")).error?.message).toBe("Oops");
  });

  it("turns on hideSuggestions for validation and execution", async () => {
    const server = createServer({ schema: basicSchema(), plugins: [maskErrors()] });
    const validation = await gql(server, "{ hell }");
    expect(validation.error?.message).toBe('Cannot query field "hell" on type "Query".');
    const plain = createServer({ schema: basicSchema() });
    expect((await gql(plain, "{ hell }")).error?.message).toMatch(/Did you mean "hello"\?/);
  });
});

/** A body wrapper like the Effect layer's span end: reports when the body completes or is cancelled. */
const bodyWrapper = (events: Array<string>): Plugin => ({
  onResponse: (response) => {
    const original = response.body;
    if (original === null) {
      events.push("ended: no body");
      return undefined;
    }
    const reader = original.getReader();
    let ended = false;
    const end = (how: string) => {
      if (!ended) {
        ended = true;
        events.push(`ended: ${how}`);
      }
    };
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const chunk = await reader.read();
          if (ended) {
            return;
          }
          if (chunk.done) {
            end("complete");
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        },
        cancel: async (reason) => {
          end("cancel");
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  },
});

describe("serverTiming()", () => {
  it("reports parse, validate and total on a miss, total alone on a hit", async () => {
    const server = createServer({ schema: basicSchema(), plugins: [serverTiming()] });
    const miss = await server.handle(post({ query: "{ count }" }));
    expect(miss.headers.get("server-timing")).toMatch(
      /^parse;dur=[\d.]+, validate;dur=[\d.]+, total;dur=[\d.]+$/,
    );
    expect(await miss.json()).toEqual({ data: { count: 1 } });
    const hit = await server.handle(post({ query: "{ count }" }));
    expect(hit.headers.get("server-timing")).toMatch(/^total;dur=[\d.]+$/);
  });

  it("reports the jit compilation", async () => {
    const server = createServer({
      schema: basicSchema(),
      plugins: [jit({ after: 1 }), serverTiming()],
    });
    const response = await server.handle(post({ query: "{ count }" }));
    expect(response.headers.get("server-timing")).toMatch(/jit;dur=/);
  });

  it.each([
    ["serverTiming() then a body wrapper", true],
    ["a body wrapper then serverTiming()", false],
  ])("keeps the body: %s still ends the wrapper", async (_name, timingFirst) => {
    const events: Array<string> = [];
    const plugins = timingFirst
      ? [serverTiming(), bodyWrapper(events)]
      : [bodyWrapper(events), serverTiming()];
    const server = createServer({ schema: basicSchema(), plugins });
    const response = await server.handle(post({ query: "{ count }" }));
    expect(response.headers.get("server-timing")).toMatch(/total;dur=/);
    expect(events).toEqual([]);
    expect(await response.json()).toEqual({ data: { count: 1 } });
    expect(events).toEqual(["ended: complete"]);
  });

  it.each([
    ["serverTiming() then a body wrapper", true],
    ["a body wrapper then serverTiming()", false],
  ])("a cancel reaches the wrapper and the core signal: %s", async (_name, timingFirst) => {
    const events: Array<string> = [];
    const plugins = timingFirst
      ? [serverTiming(), bodyWrapper(events)]
      : [bodyWrapper(events), serverTiming()];
    const server = createServer({ schema: basicSchema(), plugins });
    const request = post({ query: "{ count }" });
    const response = await server.handle(request);
    await response.body?.cancel();
    expect(events).toEqual(["ended: cancel"]);
    expect(signalOf(request)?.aborted).toBe(true);
  });

  it("leaves a network-error Response (status 0) alone instead of failing", async () => {
    const error = vi.fn();
    const server = createServer({
      schema: basicSchema(),
      logger: { warn: () => {}, error },
      plugins: [{ onRequest: () => Response.error() }, serverTiming()],
    });
    const response = await server.handle(post({ query: "{ count }" }));
    expect(response.type).toBe("error");
    expect(response.status).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it("a null body (405) stays null", async () => {
    const events: Array<string> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [serverTiming(), bodyWrapper(events)],
    });
    const response = await server.handle(new Request("http://localhost/graphql"));
    expect(response.status).toBe(405);
    expect(response.body).toBeNull();
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("server-timing")).toMatch(/^total;dur=[\d.]+$/);
    expect(events).toEqual(["ended: no body"]);
  });
});

const depthSchema = () =>
  basicSchema(
    { Query: { me: () => ({}) }, Person: { friend: () => ({}), name: () => "x" } },
    "type Person { name: String friend: Person } extend type Query { me: Person }",
  );

describe("maxDepth(limit)", () => {
  it("allows operations up to the limit", async () => {
    const server = createServer({ schema: depthSchema(), plugins: [maxDepth(3)] });
    expect((await gql(server, "{ me { friend { name } } }")).status).toBe(200);
  });

  it("refuses deeper operations with a 400 before anything runs, following fragments", async () => {
    const resolve = vi.fn(() => ({}));
    const server = createServer({
      schema: basicSchema(
        { Query: { me: resolve }, Person: { friend: () => ({}), name: () => "x" } },
        "type Person { name: String friend: Person } extend type Query { me: Person }",
      ),
      plugins: [maxDepth(3)],
    });
    for (const query of [
      "{ me { friend { friend { name } } } }",
      "{ me { ...F } } fragment F on Person { friend { friend { name } } }",
      "{ me { ... on Person { friend { friend { name } } } } }",
    ]) {
      const sent = await gql(server, query, { accept: "application/json" });
      expect(sent.status).toBe(400);
      expect(sent.error?.message).toBe("The operation is nested 4 levels deep; the limit is 3.");
      expect(sent.error?.extensions?.["code"]).toBe("MAX_DEPTH_EXCEEDED");
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

/** F0 is one field deep; each F(n) reads `friend { ...F(n-1) }` and spreads F(n-1) again. */
const doublingFragments = (count: number) => {
  const fragments = ["fragment F0 on Person { name }"];
  for (let n = 1; n < count; n += 1) {
    fragments.push(`fragment F${n} on Person { friend { ...F${n - 1} } ...F${n - 1} }`);
  }
  return `{ me { ...F${count - 1} } } ${fragments.join(" ")}`;
};

const depthOf = (query: string, onFragmentRead = () => {}): number => {
  const document = parse(query);
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      const { selectionSet } = definition;
      Object.defineProperty(definition, "selectionSet", {
        get: () => {
          onFragmentRead();
          return selectionSet;
        },
      });
    }
  }
  const operation = getOperationAST(document);
  if (operation === null || operation === undefined) {
    throw new Error("no operation");
  }
  return selectionDepth(document, operation.selectionSet);
};

describe("selectionDepth over repeated fragment spreads", () => {
  it("measures each fragment once, not once per spread", () => {
    let reads = 0;
    expect(
      depthOf(doublingFragments(12), () => {
        reads += 1;
      }),
    ).toBe(13);
    // Without memoization F0 is read 2^11 times.
    expect(reads).toBe(12);
  });

  it("finishes 25 doubling fragments at once with the right depth", () => {
    const start = performance.now();
    expect(depthOf(doublingFragments(25))).toBe(26);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("still stops at a fragment cycle", () => {
    expect(
      depthOf(
        "{ me { ...A } } fragment A on Person { friend { ...B } } fragment B on Person { friend { ...A name } }",
      ),
    ).toBe(4);
  });
});

describe("readOnly()", () => {
  it("refuses mutations with a 403 and never starts them; queries run", async () => {
    const bump = vi.fn(() => 1);
    const server = createServer({
      schema: basicSchema({ Mutation: { bump } }),
      plugins: [readOnly()],
    });
    const request = post({ query: "mutation { bump }" });
    const sent = await send(server, request);
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({
      errors: [
        {
          message: "This server is read-only.",
          extensions: { code: "READ_ONLY", http: { status: 403 } },
        },
      ],
    });
    expect(bump).not.toHaveBeenCalled();
    expect(await mutationOf(request)?.started).toBe(false);
    expect((await gql(server, "{ count }")).status).toBe(200);
  });
});
