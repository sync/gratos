// The server core's page, packages/gratos/llm-docs/gratos/server.md (docs/plan.html F4): its hook
// table names every hook of `Plugin`, in the order the core calls them, and its option table
// names every option of `createServer`. The lists below are checked against types.ts by the type
// checker, and the hook order against a real request.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APPLICATION_JSON,
  CLIENT_CLOSED_REQUEST,
  TEXT_EVENT_STREAM,
  createServer,
  incremental,
  maskErrors,
} from "../src/index.ts";
import type { ContextServerOptions, Plugin, Server } from "../src/index.ts";
import { jit } from "../src/jit.ts";
import { gate, gql, post, send } from "./support/http.ts";
import { basicSchema, makeSchema } from "./support/schema.ts";

const page = readFileSync(
  join(import.meta.dirname, "..", "..", "gratos", "llm-docs", "gratos", "server.md"),
  "utf8",
);

/** The members of `Plugin` that are functions: its hooks. */
type HookName = {
  [K in keyof Plugin]-?: NonNullable<Plugin[K]> extends (...args: never) => void ? K : never;
}[keyof Plugin];

/** Every hook, in the order the core calls them. */
const HOOKS = [
  "onServer",
  "onRequest",
  "onParams",
  "onPhase",
  "onContext",
  "onExecute",
  "wrapExecution",
  "onResult",
  "onResponse",
] as const satisfies ReadonlyArray<HookName>;

/** Every option of `createServer` (with a context factory, the widest form). */
type OptionName = keyof ContextServerOptions<unknown>;

const OPTIONS = [
  "schema",
  "rootValue",
  "context",
  "plugins",
  "documentCacheSize",
  "maxTokens",
  "maxBodyBytes",
  "logger",
] as const satisfies ReadonlyArray<OptionName>;

// A hook or an option added to types.ts and missing from a list fails the type check here.
const everyHook: [Exclude<HookName, (typeof HOOKS)[number]>] extends [never] ? true : false = true;
const everyOption: [Exclude<OptionName, (typeof OPTIONS)[number]>] extends [never] ? true : false =
  true;

/** The first column of the table under `heading`, without its backticks. */
const firstColumn = (heading: string): Array<string> => {
  const start = page.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = page.indexOf("\n## ", start + 1);
  const section = page.slice(start, end === -1 ? undefined : end);
  const rows = section.split("\n").filter((line) => line.startsWith("|"));
  // The header row and the separator row come first.
  return rows.slice(2).map((row) => (row.split("|")[1] ?? "").trim().replaceAll("`", ""));
};

describe("server.md", () => {
  it("names every hook of Plugin, in call order", () => {
    expect(everyHook).toBe(true);
    expect(firstColumn("## Hooks, in call order")).toEqual([...HOOKS]);
  });

  it("names every option of createServer", () => {
    expect(everyOption).toBe(true);
    expect(firstColumn("## createServer").toSorted()).toEqual([...OPTIONS].toSorted());
  });

  it("lists the hooks in the order a request reaches them", async () => {
    const calls: Array<string> = [];
    const record = (hook: (typeof HOOKS)[number]): undefined => {
      if (!calls.includes(hook)) {
        calls.push(hook);
      }
      return undefined;
    };
    const plugin: Plugin = {
      onServer: () => record("onServer"),
      onRequest: () => record("onRequest"),
      onParams: () => record("onParams"),
      onPhase: () => record("onPhase"),
      onContext: () => record("onContext"),
      onExecute: () => record("onExecute"),
      wrapExecution: (_request, run) => {
        record("wrapExecution");
        return run();
      },
      onResult: () => record("onResult"),
      onResponse: () => record("onResponse"),
    };
    const server = createServer({ schema: basicSchema(), plugins: [plugin] });
    const sent = await send(server, post({ query: "{ count }" }));
    expect(sent.status).toBe(200);
    expect(calls).toEqual([...HOOKS]);
  });

  it("gives the order of the request jit() compiles, whose jit phase comes later", async () => {
    // The page's sentence: "…so that request reaches the hooks in this order: `onRequest`, …".
    // Paragraphs, with each one's line breaks read as spaces.
    const marker = "so that request reaches the hooks in this order:";
    const paragraph = page
      .split("\n\n")
      .map((text) => text.replaceAll(/\s+/g, " "))
      .find((text) => text.includes(marker));
    expect(paragraph, marker).toBeDefined();
    const sentence = (paragraph ?? "").slice((paragraph ?? "").indexOf(marker) + marker.length);
    const documented = [...sentence.matchAll(/`(\w+)`/g)].map((match) => match[1]);

    const calls: Array<string> = [];
    const plugin: Plugin = {
      onRequest: () => {
        calls.push("onRequest");
      },
      onParams: () => {
        calls.push("onParams");
      },
      onPhase: (phase) => {
        calls.push(`onPhase:${phase.name}`);
        return undefined;
      },
      onContext: () => {
        calls.push("onContext");
      },
      onExecute: () => {
        calls.push("onExecute");
        return undefined;
      },
      wrapExecution: (_request, run) => {
        calls.push("wrapExecution");
        return run();
      },
      onResult: () => {
        calls.push("onResult");
        return undefined;
      },
      onResponse: () => {
        calls.push("onResponse");
      },
    };
    // jit() compiles on the second use, which hits the document cache (no parse or validate).
    const server = createServer({ schema: basicSchema(), plugins: [plugin, jit({ after: 2 })] });
    expect((await send(server, post({ query: "{ count }" }))).status).toBe(200);
    calls.length = 0;
    const sent = await send(server, post({ query: "{ count }" }));
    expect(sent.body).toEqual({ data: { count: 1 } });
    expect(calls).toEqual([
      "onRequest",
      "onParams",
      "onContext",
      "onExecute",
      "wrapExecution",
      "onPhase:jit",
      "onResult",
      "onResponse",
    ]);
    expect(documented).toEqual(calls.map((call) => call.replace(/:.*/, "")));
  });
});

/** A client that accepts text/event-stream and no JSON type. */
const SSE_ONLY = { accept: TEXT_EVENT_STREAM } as const;

/** A logger for the failures these tests cause on purpose. */
const quiet = { warn: () => {}, error: () => {} };

/** The status, content type and text of a response. */
const read = async (server: Server, request: Request) => {
  const response = await server.handle(request);
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    text: await response.text(),
  };
};

// Each claim of server.md's HTTP section that no other test states as the page does.
describe("server.md's HTTP claims", () => {
  it("drains a mutation with a 503 for a JSON client, a 200 SSE error event for an SSE-only one", async () => {
    const server = createServer({ schema: basicSchema() });
    void server.control.drain();
    const json = await gql(server, "mutation { bump }");
    expect(json.status).toBe(503);
    expect(json.error?.extensions?.["code"]).toBe("SERVER_DRAINING");
    const sse = await read(server, post({ query: "mutation { bump }" }, SSE_ONLY));
    expect(sse.status).toBe(200);
    expect(sse.type).toContain(TEXT_EVENT_STREAM);
    expect(sse.text).toContain("SERVER_DRAINING");
    expect(sse.text).toContain("event: complete");
  });

  it("answers an onParams throw with a 400, or a 200 SSE error event for an SSE-only client", async () => {
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
    expect((await gql(server, "{ count }")).status).toBe(400);
    const sse = await read(server, post({ query: "{ count }" }, SSE_ONLY));
    expect(sse.status).toBe(200);
    expect(sse.text).toContain("bad params");
  });

  it("runs the query onParams returns, and checks for a query only after onParams", async () => {
    const replacing = createServer({
      schema: basicSchema(),
      plugins: [{ onParams: (params) => ({ ...params, query: "{ count }" }) }],
    });
    expect((await send(replacing, post({}))).body).toEqual({ data: { count: 1 } });
    const plain = createServer({ schema: basicSchema() });
    const missing = await read(plain, post({}, SSE_ONLY));
    // A transport error: JSON for every client.
    expect(missing.status).toBe(400);
    expect(missing.type).toContain("application/graphql-response+json");
  });

  it("answers any method but POST with a 405 and a null body, whatever the client accepts", async () => {
    const server = createServer({ schema: basicSchema() });
    const response = await server.handle(
      new Request("http://localhost/graphql", { headers: { accept: TEXT_EVENT_STREAM } }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.body).toBeNull();
  });

  it("answers a query whose client left with a 499, a started mutation with its result", async () => {
    const held = gate<number>();
    const started = gate();
    const server = createServer({
      schema: basicSchema({
        Query: {
          count: async () => {
            started.resolve();
            return held.promise;
          },
        },
      }),
    });
    const leave = new AbortController();
    const query = server.handle(post({ query: "{ count }" }, { signal: leave.signal }));
    await started.promise;
    leave.abort();
    held.resolve(1);
    const left = await query;
    expect(left.status).toBe(CLIENT_CLOSED_REQUEST);
    expect(left.body).toBeNull();

    const mutationHeld = gate<number>();
    const mutationStarted = gate();
    const writes = createServer({
      schema: basicSchema({
        Mutation: {
          bump: async () => {
            mutationStarted.resolve();
            return mutationHeld.promise;
          },
        },
      }),
    });
    const gone = new AbortController();
    const mutation = writes.handle(post({ query: "mutation { bump }" }, { signal: gone.signal }));
    await mutationStarted.promise;
    gone.abort();
    mutationHeld.resolve(2);
    const response = await mutation;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { bump: 2 } });
  });

  it("negotiates each operation kind's media types", async () => {
    const schema = makeSchema(`
      type Query { count: Int! later: Int! }
      type Mutation { bump: Int! }
      type Subscription { tick: Int }
    `);
    const tick = schema.getSubscriptionType()?.getFields()["tick"];
    Object.assign(tick ?? {}, {
      async *subscribe() {
        yield 1;
      },
      resolve: (payload: number) => payload,
    });
    const query = schema.getQueryType()?.getFields() ?? {};
    Object.assign(query["count"] ?? {}, { resolve: () => 1 });
    Object.assign(query["later"] ?? {}, { resolve: () => 2 });
    Object.assign(schema.getMutationType()?.getFields()["bump"] ?? {}, { resolve: () => 3 });
    const server = createServer({ schema, plugins: [incremental()] });

    // No Accept header allows every type: a subscription gets SSE.
    const subscription = await read(
      server,
      post({ query: "subscription { tick }" }, { accept: null }),
    );
    expect(subscription.status).toBe(200);
    expect(subscription.type).toContain(TEXT_EVENT_STREAM);
    // A subscription needs text/event-stream.
    expect((await gql(server, "subscription { tick }", { accept: APPLICATION_JSON })).status).toBe(
      406,
    );
    // A query that defers needs multipart/mixed.
    const deferred = "{ count ... @defer { later } }";
    expect((await gql(server, deferred, { accept: APPLICATION_JSON })).status).toBe(406);
    expect((await read(server, post({ query: deferred }))).type).toContain("multipart/mixed");
    // @defer on a mutation is a validation error, with the validation error's status.
    const deferredMutation = "mutation { ... @defer { bump } }";
    expect((await gql(server, deferredMutation)).status).toBe(400);
    expect((await gql(server, deferredMutation, { accept: APPLICATION_JSON })).status).toBe(200);
    // A single result for a client that accepts no JSON type goes out as its stream type.
    expect((await read(server, post({ query: "{ count }" }, SSE_ONLY))).type).toContain(
      TEXT_EVENT_STREAM,
    );
    expect(
      (await read(server, post({ query: "{ count }" }, { accept: "multipart/mixed" }))).type,
    ).toContain("multipart/mixed");
  });

  it("lets a synchronous onServer throw escape createServer, and answers a failed async startup with 500", async () => {
    expect(() =>
      createServer({
        schema: basicSchema(),
        plugins: [
          {
            onServer: () => {
              throw new Error("sync startup");
            },
          },
        ],
      }),
    ).toThrow("sync startup");
    const server = createServer({
      schema: basicSchema(),
      logger: quiet,
      plugins: [
        {
          onServer: async () => {
            await Promise.resolve();
            throw new Error("async startup");
          },
        },
      ],
    });
    expect((await gql(server, "{ count }")).status).toBe(500);
    // A failed startup and a throw from onRequest come before the Accept header is read: JSON
    // for every client.
    const failed = await read(server, post({ query: "{ count }" }, SSE_ONLY));
    expect(failed.status).toBe(500);
    expect(failed.type).toContain("application/graphql-response+json");
    const early = createServer({
      schema: basicSchema(),
      logger: quiet,
      plugins: [
        {
          onRequest: () => {
            throw new Error("onRequest");
          },
        },
      ],
    });
    const thrown = await read(early, post({ query: "{ count }" }, SSE_ONLY));
    expect(thrown.status).toBe(500);
    expect(thrown.type).toContain("application/graphql-response+json");
  });

  it("gives an Error thrown by onExecute a 500, and the default status behind maskErrors()", async () => {
    const throwing: Plugin = {
      onExecute: () => {
        throw new Error("executor failed");
      },
    };
    const bare = createServer({ schema: basicSchema(), logger: quiet, plugins: [throwing] });
    expect((await gql(bare, "{ count }")).status).toBe(500);
    const masked = createServer({
      schema: basicSchema(),
      logger: quiet,
      plugins: [throwing, maskErrors()],
    });
    expect((await gql(masked, "{ count }")).status).toBe(400);
    expect((await gql(masked, "{ count }", { accept: APPLICATION_JSON })).status).toBe(200);
  });
});
