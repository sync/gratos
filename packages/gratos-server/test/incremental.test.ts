// incremental() (docs/plan.html M4b): @defer and @stream added at startup, the default executor
// on such a schema, the multipart/mixed wire format, masking and reporting of deferred errors,
// aborts, the mutation rule, and which operations it claims.
import { AbortedGraphQLExecutionError, GraphQLError, parse } from "graphql";
import type { ExecutionArgs } from "graphql";
import { describe, expect, it } from "vitest";

import {
  CLIENT_CLOSED_REQUEST,
  createServer,
  incremental,
  jit,
  mapPayloadErrors,
  maskErrors,
  payloadErrors,
  reportErrors,
  serverTiming,
  signalOf,
  usesIncrementalDelivery,
  withIncrementalDirectives,
} from "../src/index.ts";
import type { ExecuteInput, Plugin } from "../src/index.ts";
import { flush, gate, gql, post } from "./support/http.ts";
import { makeSchema } from "./support/schema.ts";
import { readApolloMultipart, readMultipart, readUntil, wireErrors } from "./support/stream.ts";

const MULTIPART = 'multipart/mixed; boundary="-"; deferSpec=20220824';
const APOLLO_ACCEPT =
  "multipart/mixed;deferSpec=20220824,application/graphql-response+json,application/json;q=0.9";

const SDL = `
  type Item { id: ID! name: String fails: String }
  type Query {
    hello: String
    slow: String
    fails: String
    list: [Int]
    items: [Item]
  }
  type Created { id: ID! detail: String tags: [String] }
  type Mutation { create: Created! }
`;

/** A schema with a counter of resolver calls, and hooks to hold the slow ones. */
const fixture = () => {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const hold = gate();
  const schema = makeSchema(SDL, {
    Query: {
      hello: () => {
        count("hello");
        return "world";
      },
      slow: async () => {
        count("slow");
        await hold.promise;
        return "slow";
      },
      fails: async () => {
        count("fails");
        await Promise.resolve();
        throw new Error("secret deferred failure");
      },
      async *list() {
        count("list");
        yield 1;
        yield 2;
        yield 3;
      },
      items: () => [
        { id: "1", name: "one" },
        { id: "2", name: "two" },
      ],
    },
    Item: {
      fails: () => {
        throw new Error("secret item failure");
      },
    },
    Mutation: {
      create: () => {
        count("create");
        return { id: "c1", detail: "d", tags: ["a", "b"] };
      },
    },
  });
  return { schema, calls, hold };
};

describe("incremental() at startup", () => {
  it("adds @defer and @stream to the schema through replaceSchema", () => {
    const { schema } = fixture();
    expect(schema.getDirective("defer")).toBeUndefined();
    const server = createServer({ schema, plugins: [incremental()] });
    expect(server.control.generation()).toBe(1);
    expect(server.control.schema().getDirective("defer")).toBeDefined();
    expect(server.control.schema().getDirective("stream")).toBeDefined();
  });

  it("leaves a schema that already has both alone", () => {
    const { schema } = fixture();
    const withBoth = withIncrementalDirectives(schema);
    expect(withIncrementalDirectives(withBoth)).toBe(withBoth);
    const server = createServer({ schema: withBoth, plugins: [incremental()] });
    expect(server.control.generation()).toBe(0);
  });

  it("keeps the resolvers of the schema it extends", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const sent = await gql(server, "{ hello }");
    expect(sent.body).toEqual({ data: { hello: "world" } });
  });
});

describe("the default executor with incremental()", () => {
  it("a plain query returns data (execute() would throw on a schema with @defer)", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const sent = await gql(server, "{ hello list }", { accept: APOLLO_ACCEPT });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toBe(
      "application/graphql-response+json; charset=utf-8",
    );
    expect(sent.body).toEqual({ data: { hello: "world", list: [1, 2, 3] } });
  });

  it("a plain mutation returns data", async () => {
    const { schema, calls } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const sent = await gql(server, "mutation { create { id } }");
    expect(sent.body).toEqual({ data: { create: { id: "c1" } } });
    expect(calls["create"]).toBe(1);
  });
});

/** Runs a query with an Apollo Client Accept header and reads the whole body. */
const runDeferred = async (query: string, plugins: ReadonlyArray<Plugin> = [incremental()]) => {
  const { schema } = fixture();
  const server = createServer({ schema, plugins });
  const response = await server.handle(post({ query }, { accept: APOLLO_ACCEPT }));
  return { response, text: await response.text() };
};

describe("multipart/mixed; deferSpec=20220824", () => {
  it("a @defer response matches its recorded snapshot", async () => {
    const { response, text } = await runDeferred(
      '{ hello ... @defer(label: "later") { items { id name } } }',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(MULTIPART);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    // Split on CRLF, so the snapshot records the line endings of the framing too.
    expect(text.split("\r\n")).toMatchSnapshot();
    expect(readMultipart(text)).toEqual([
      { data: { hello: "world" }, hasNext: true },
      {
        incremental: [
          {
            data: {
              items: [
                { id: "1", name: "one" },
                { id: "2", name: "two" },
              ],
            },
            path: [],
            label: "later",
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it("a @stream response matches its recorded snapshot", async () => {
    const { response, text } = await runDeferred("{ list @stream(initialCount: 1) }");
    expect(response.headers.get("content-type")).toBe(MULTIPART);
    // Split on CRLF, so the snapshot records the line endings of the framing too.
    expect(text.split("\r\n")).toMatchSnapshot();
    expect(readMultipart(text).map((part) => part)).toEqual([
      { data: { list: [1] }, hasNext: true },
      { incremental: [{ items: [2], path: ["list", 1] }], hasNext: true },
      { incremental: [{ items: [3], path: ["list", 2] }], hasNext: false },
    ]);
  });

  it("Apollo Client reads the initial result while the deferred work is still blocked", async () => {
    const { schema, hold } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const response = await server.handle(
      post({ query: "{ hello ... @defer { slow } }" }, { accept: APOLLO_ACCEPT }),
    );
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("no body");
    }
    const decoder = new TextDecoder();
    // The first chunk alone, while the deferred resolver is held: nothing more can arrive yet.
    const first = await reader.read();
    const head = decoder.decode(first.value, { stream: true });
    expect(readApolloMultipart(head)).toEqual({
      parts: [{ data: { hello: "world" }, hasNext: true }],
      closed: false,
    });
    hold.resolve();
    let text = head;
    for (let read = await reader.read(); read.done !== true; read = await reader.read()) {
      text += decoder.decode(read.value, { stream: true });
    }
    expect(readApolloMultipart(text)).toEqual({
      parts: [
        { data: { hello: "world" }, hasNext: true },
        { incremental: [{ data: { slow: "slow" }, path: [] }], hasNext: false },
      ],
      closed: true,
    });
  });

  it("an operation that defers nothing at run time (if: false) is one JSON result", async () => {
    const { response, text } = await runDeferred("{ hello ... @defer(if: false) { list } }");
    expect(response.headers.get("content-type")).toBe(
      "application/graphql-response+json; charset=utf-8",
    );
    expect(JSON.parse(text)).toEqual({ data: { hello: "world", list: [1, 2, 3] } });
  });

  it("goes through serverTiming (onResponse once, headers changed, body kept)", async () => {
    const responses: Array<number> = [];
    const counter: Plugin = {
      onResponse: (response) => {
        responses.push(response.status);
      },
    };
    const { response, text } = await runDeferred("{ hello ... @defer { list } }", [
      incremental(),
      serverTiming(),
      counter,
    ]);
    expect(responses).toEqual([200]);
    expect(response.headers.get("server-timing")).toContain("total;dur=");
    expect(response.headers.get("content-type")).toBe(MULTIPART);
    expect(readMultipart(text)).toHaveLength(2);
  });

  it("a client that does not accept multipart gets a 406 and the execution is closed", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const sent = await gql(server, "{ hello ... @defer { list } }", { accept: "application/json" });
    expect(sent.status).toBe(406);
    expect(sent.error?.message).toBe(
      "This operation uses @defer or @stream, which needs Accept: multipart/mixed.",
    );
  });

  it("a range with another deferSpec does not accept the multipart response", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const sent = await gql(server, "{ hello ... @defer { list } }", {
      accept: "multipart/mixed;deferSpec=99999999, application/json",
    });
    expect(sent.status).toBe(406);
  });

  it.each([["multipart/mixed"], ["multipart/*"], ["*/*"], [null]])(
    "Accept %s accepts it",
    async (accept) => {
      const { schema } = fixture();
      const server = createServer({ schema, plugins: [incremental()] });
      const response = await server.handle(
        post({ query: "{ hello ... @defer { list } }" }, { accept }),
      );
      expect(response.headers.get("content-type")).toBe(MULTIPART);
      expect(readMultipart(await response.text())).toHaveLength(2);
    },
  );

  it("a multipart-only client gets a single result as one part", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const response = await server.handle(
      post({ query: "{ hello }" }, { accept: "multipart/mixed;deferSpec=20220824" }),
    );
    expect(response.headers.get("content-type")).toBe(MULTIPART);
    expect(readMultipart(await response.text())).toEqual([
      { data: { hello: "world" }, hasNext: false },
    ]);
  });
});

describe("errors in incremental payloads", () => {
  it("a deferred resolver error is masked, and reportErrors sees it unmasked", async () => {
    const { schema } = fixture();
    const reported: Array<string> = [];
    const server = createServer({
      schema,
      plugins: [
        incremental(),
        reportErrors((error) => {
          reported.push(error.message);
        }),
        maskErrors(),
      ],
    });
    const response = await server.handle(
      post(
        { query: "{ hello ... @defer { fails } items @stream(initialCount: 0) { id fails } }" },
        { accept: APOLLO_ACCEPT },
      ),
    );
    const text = await response.text();
    expect(text).not.toContain("secret");
    const parts = readMultipart(text);
    const messages = parts.flatMap(wireErrors);
    expect(messages.length).toBe(3);
    for (const message of messages) {
      expect(message).toMatchObject({ message: "Unexpected error." });
    }
    expect(reported.toSorted()).toEqual([
      "secret deferred failure",
      "secret item failure",
      "secret item failure",
    ]);
  });

  it("a result hook that throws on the initial payload fails the request and stops the deferred work", async () => {
    const { schema, hold } = fixture();
    const errors: Array<unknown> = [];
    const server = createServer({
      schema,
      logger: { warn: () => undefined, error: (_message, details) => errors.push(details) },
      plugins: [
        incremental(),
        {
          onResult: () => {
            throw new Error("hook failure");
          },
        },
      ],
    });
    const request = post({ query: "{ hello ... @defer { slow } }" }, { accept: APOLLO_ACCEPT });
    const response = await server.handle(request);
    hold.resolve();
    expect(response.status).toBe(500);
    expect(signalOf(request)?.aborted).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("an onResult replacement cannot drop hasNext", async () => {
    const { schema } = fixture();
    const server = createServer({
      schema,
      plugins: [incremental(), { onResult: (payload) => ({ data: payload.data ?? null }) }],
    });
    const response = await server.handle(
      post({ query: "{ hello ... @defer { list } }" }, { accept: APOLLO_ACCEPT }),
    );
    expect(readMultipart(await response.text()).map((part) => part.hasNext)).toEqual([true, false]);
  });
});

describe("payloadErrors and mapPayloadErrors", () => {
  const deferred = new GraphQLError("deferred");
  const own = new GraphQLError("own");
  const payload = {
    errors: [own],
    incremental: [
      { data: {}, path: [], errors: [deferred] },
      { items: [1], path: ["list", 0] },
    ],
    hasNext: true,
  };

  it("reads the payload's own errors, then each incremental entry's", () => {
    expect(payloadErrors(payload)).toEqual([own, deferred]);
    expect(payloadErrors({ data: {} })).toEqual([]);
  });

  it("returns the same payload when nothing changes, else a copy that keeps every field", () => {
    expect(mapPayloadErrors(payload, (error) => error)).toBe(payload);
    const renamed = mapPayloadErrors(payload, (error) =>
      error === deferred ? new GraphQLError("renamed") : error,
    );
    expect(renamed).not.toBe(payload);
    expect(renamed.hasNext).toBe(true);
    expect(renamed.errors?.[0]).toBe(own);
    expect(renamed.incremental[1]).toBe(payload.incremental[1]);
    expect(payloadErrors(renamed).map(({ message }) => message)).toEqual(["own", "renamed"]);
  });
});

describe("aborts", () => {
  it("an abort during an in-flight query is caught, not reported, and onResponse still runs", async () => {
    const { schema, hold } = fixture();
    const reported: Array<GraphQLError> = [];
    const responses: Array<number> = [];
    const rejections: Array<unknown> = [];
    const server = createServer({
      schema,
      plugins: [
        // Observes what the default executor (legacyExecuteIncrementally) rejects with.
        {
          onExecute: () => async (next) => {
            try {
              return await next();
            } catch (error) {
              rejections.push(error);
              throw error;
            }
          },
        },
        incremental(),
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
    const pending = server.handle(post({ query: "{ slow }" }, { signal: client.signal }));
    await flush();
    client.abort();
    const response = await pending;
    hold.resolve();
    expect(response.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(responses).toEqual([CLIENT_CLOSED_REQUEST]);
    expect(reported).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toBeInstanceOf(AbortedGraphQLExecutionError);
  });

  it("a client that leaves while onResponse runs gets nothing: no initial result, no closing delimiter", async () => {
    const { schema, hold } = fixture();
    const inResponse = gate();
    const leave = gate();
    const seen: Array<unknown> = [];
    const server = createServer({
      schema,
      plugins: [
        incremental(),
        {
          onResult: (payload) => {
            seen.push(payload);
          },
          onResponse: async () => {
            inResponse.resolve();
            await leave.promise;
          },
        },
      ],
    });
    const client = new AbortController();
    const request = post(
      { query: "{ hello ... @defer { slow } }" },
      { accept: APOLLO_ACCEPT, signal: client.signal },
    );
    const pending = server.handle(request);
    await inResponse.promise;
    client.abort();
    leave.resolve();
    const response = await pending;
    expect(response.headers.get("content-type")).toBe(MULTIPART);
    expect(await response.text()).toBe("");
    expect(signalOf(request)?.aborted).toBe(true);
    hold.resolve();
    await flush();
    // Only the initial result went through the hooks (before the client left).
    expect(seen).toHaveLength(1);
  });

  it("a client that cancels after the initial payload stops the deferred work quietly", async () => {
    const { schema, hold } = fixture();
    const reported: Array<GraphQLError> = [];
    const seen: Array<unknown> = [];
    const server = createServer({
      schema,
      plugins: [
        incremental(),
        reportErrors((error) => {
          reported.push(error);
        }),
        {
          onResult: (payload) => {
            seen.push(payload);
          },
        },
      ],
    });
    const request = post({ query: "{ hello ... @defer { slow } }" }, { accept: APOLLO_ACCEPT });
    const response = await server.handle(request);
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const { text, reader } = await readUntil(body, (sofar) => sofar.includes("hasNext"));
    expect(readMultipart(text)).toEqual([{ data: { hello: "world" }, hasNext: true }]);
    await reader.cancel();
    expect(signalOf(request)?.aborted).toBe(true);
    hold.resolve();
    await flush();
    expect(seen).toHaveLength(1);
    expect(reported).toEqual([]);
  });
});

describe("regression: no @defer or @stream on mutations", () => {
  const documents: ReadonlyArray<readonly [string, string]> = [
    ["a nested @defer", "mutation { create { id ... @defer { detail } } }"],
    ["a nested @stream", "mutation { create { id tags @stream(initialCount: 0) } }"],
    [
      "a nested @defer through two levels of named fragments",
      `mutation M { create { ...Outer } }
       fragment Outer on Created { id ...Inner }
       fragment Inner on Created { ... @defer { detail } }`,
    ],
    [
      "a nested @stream through two levels of named fragments",
      `mutation M { create { ...Outer } }
       fragment Outer on Created { id ...Inner }
       fragment Inner on Created { tags @stream(initialCount: 0) }`,
    ],
  ];

  it.each(documents)(
    "%s gets a 400 validation error and no resolver runs",
    async (_name, query) => {
      const { schema, calls } = fixture();
      const server = createServer({ schema, plugins: [incremental()] });
      const sent = await gql(server, query, { accept: "application/graphql-response+json" });
      expect(sent.status).toBe(400);
      expect(sent.body?.data).toBeUndefined();
      expect(sent.error?.message).toMatch(
        /^@(defer|stream) is not supported on mutations: remove it from mutation/,
      );
      expect(calls["create"]).toBeUndefined();
    },
  );

  it.each(documents)(
    "%s is rejected on a schema that already has the directives, without incremental()",
    async (_name, query) => {
      const { schema, calls } = fixture();
      const server = createServer({ schema: withIncrementalDirectives(schema) });
      const sent = await gql(server, query, { accept: APOLLO_ACCEPT });
      expect(sent.status).toBe(400);
      expect(sent.error?.message).toMatch(
        /^@(defer|stream) is not supported on mutations: remove it from mutation/,
      );
      expect(calls["create"]).toBeUndefined();
      // drain() has nothing to wait for: no deferred mutation work was left behind.
      await server.control.drain();
    },
  );

  it("a query using the same fragments is still served incrementally", async () => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: [incremental()] });
    const response = await server.handle(
      post(
        {
          query:
            "{ items { ...Outer } } fragment Outer on Item { id ...Inner } fragment Inner on Item { ... @defer { name } }",
        },
        { accept: APOLLO_ACCEPT },
      ),
    );
    expect(response.headers.get("content-type")).toBe(MULTIPART);
  });
});

/** Whether incremental() claims the selected operation of `query`. */
const claims = (query: string, operationName?: string) => {
  const { schema } = fixture();
  const document = parse(query);
  const plugin = incremental();
  const operation = document.definitions.find(
    (definition) =>
      definition.kind === "OperationDefinition" &&
      (operationName === undefined || definition.name?.value === operationName),
  );
  if (operation === undefined || operation.kind !== "OperationDefinition") {
    throw new Error("no operation");
  }
  const input: ExecuteInput = {
    operation,
    document,
    operationName,
    operationKey: {},
    request: post({ query }),
    phase: () => undefined,
  };
  const args: ExecutionArgs = {
    schema: withIncrementalDirectives(schema),
    document,
    operationName,
  };
  return plugin.onExecute?.(input, args) !== undefined;
};

describe("which operations incremental() claims", () => {
  it("a query that defers, directly or through a fragment", () => {
    expect(claims("{ hello ... @defer { list } }")).toBe(true);
    expect(
      claims("{ ...A } fragment A on Query { ...B } fragment B on Query { list @stream }"),
    ).toBe(true);
  });

  it("not a query that does not, even when another operation of the document does", () => {
    expect(claims("query Plain { hello } query Deferred { ... @defer { list } }", "Plain")).toBe(
      false,
    );
    expect(
      claims(
        "query Plain { ...A } query Deferred { ...B } fragment A on Query { hello } fragment B on Query { ... @defer { list } }",
        "Plain",
      ),
    ).toBe(false);
  });

  it("never a subscription", () => {
    const document = parse("subscription S { tick ... @defer(if: false) { tick } }");
    const operation = document.definitions[0];
    if (operation?.kind !== "OperationDefinition") {
      throw new Error("no operation");
    }
    expect(usesIncrementalDelivery(document, operation)).toBe(true);
    const plugin = incremental();
    const { schema } = fixture();
    expect(
      plugin.onExecute?.(
        {
          operation,
          document,
          operationName: "S",
          operationKey: {},
          request: post({}),
          phase: () => undefined,
        },
        { schema, document },
      ),
    ).toBeUndefined();
  });
});

describe("incremental() and jit()", () => {
  it.each([
    ["incremental() before jit()", (): ReadonlyArray<Plugin> => [incremental(), jit({ after: 1 })]],
    ["jit() before incremental()", (): ReadonlyArray<Plugin> => [jit({ after: 1 }), incremental()]],
  ])("%s: a deferred query stays incremental past the jit threshold", async (_name, plugins) => {
    const { schema } = fixture();
    const server = createServer({ schema, plugins: plugins() });
    for (let use = 0; use < 4; use += 1) {
      const response = await server.handle(
        post({ query: "{ hello ... @defer { list } }" }, { accept: APOLLO_ACCEPT }),
      );
      expect(response.headers.get("content-type")).toBe(MULTIPART);
      expect(readMultipart(await response.text())).toHaveLength(2);
    }
  });

  it("a plain query still warms up and runs on jit", async () => {
    const { schema } = fixture();
    const phases: Array<string> = [];
    const server = createServer({
      schema,
      plugins: [
        incremental(),
        jit({ after: 2 }),
        {
          onPhase: ({ name }) => {
            phases.push(name);
            return undefined;
          },
        },
      ],
    });
    for (let use = 0; use < 3; use += 1) {
      expect((await gql(server, "{ hello }")).body).toEqual({ data: { hello: "world" } });
    }
    expect(phases.filter((name) => name === "jit")).toHaveLength(1);
  });
});
