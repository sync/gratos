// The hook contract (docs/plan.html M4a, "Contract types"): a test for each hook.
import { GraphQLError } from "graphql";
import type { ExecutionResult, OperationDefinitionNode } from "graphql";
import { describe, expect, it, vi } from "vitest";

import { createServer, gqlError } from "../src/index.ts";
import type { Executor, Phase, Plugin, Server } from "../src/index.ts";
import { gate, gql, post, send, URL_ } from "./support/http.ts";
import type { Sent } from "./support/http.ts";
import { basicSchema } from "./support/schema.ts";

const silent = { warn: () => {}, error: () => {} };
const answer42: Executor = () => ({ data: { count: 42 } });

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
});

describe("onPhase", () => {
  it("gets parse and validate with times on a cache miss, in order", async () => {
    const phases: Array<Phase> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onPhase: (phase) => phases.push(phase) }],
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
      plugins: [{ onPhase: ({ name }) => names.push(name) }],
    });
    await gql(server, "{ count");
    expect(names).toEqual(["parse"]);
    await gql(server, "{ nope }");
    expect(names).toEqual(["parse", "parse", "validate"]);
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

  it("runs in list order until one returns an executor; later hooks never run", async () => {
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
        { onExecute: () => void calls.push("third") },
      ],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 42 } });
    expect(calls).toEqual(["first", "second"]);
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
