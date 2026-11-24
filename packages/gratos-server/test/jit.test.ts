// jit({ after: 3, isSafe? }) (docs/plan.html M4a): the executor order, the declines (@oneOf
// variables, `gratos: { jit: false }` fields through fragments and abstract types, subscriptions)
// and the plan's regression tests, plus jit vs default on a shared suite.
import { getOperationAST, GraphQLError, parse } from "graphql";
import type { GraphQLResolveInfo } from "graphql";
import { describe, expect, it, vi } from "vitest";

import {
  apq,
  CLIENT_CLOSED_REQUEST,
  createServer,
  gqlError,
  isSelectionSafe,
  jit,
  maxDepth,
  readOnly,
  sha256Hex,
} from "../src/index.ts";
import type { Executor, JitOptions, JsonObject, Plugin, Server } from "../src/index.ts";
import { gql, post, send } from "./support/http.ts";
import type { Sent } from "./support/http.ts";
import { basicSchema, makeSchema } from "./support/schema.ts";

const NO_JIT = { gratos: { jit: false } };
const seven: Executor = () => ({ data: { count: 7 } });

/** A schema shaped like Grats output: fields whose resolver takes GqlInfo carry the jit marker. */
const markedSchema = (calls: Record<string, number>, cleanups: Array<string>) => {
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  /** Calls info.getAbortSignal() (graphql-jit's info has none) and, with wait, waits for it. */
  const slow =
    (where: string) =>
    async (_source: unknown, args: { wait?: boolean }, _ctx: unknown, info: GraphQLResolveInfo) => {
      count(`slow:${where}`);
      const signal = info.getAbortSignal();
      if (args.wait !== true) {
        return `fast ${where}`;
      }
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve();
        });
      });
      cleanups.push(where);
      throw new Error("aborted");
    };
  return makeSchema(
    `
      input Pick @oneOf { a: Int, b: String }
      input Wrapper { pick: Pick, label: String }
      input Tree { child: Tree, label: String, pick: Pick }
      input Plain { child: Plain, label: String }
      interface Node { id: ID! slow(wait: Boolean): String }
      type A implements Node { id: ID! slow(wait: Boolean): String x: String }
      type B implements Node { id: ID! slow(wait: Boolean): String y: String }
      union U = A | B
      type Query {
        pick(p: Pick!): String
        wrapped(w: Wrapper!): String
        tree(t: Tree!): String
        plain(p: Plain!): String
        slow(wait: Boolean): String
        node: Node
        u: U
        count: Int!
      }
      type Mutation { bump: Int! }
    `,
    {
      Query: {
        pick: (_s, args) => {
          count("pick");
          return JSON.stringify(args);
        },
        wrapped: (_s, args) => {
          count("wrapped");
          return JSON.stringify(args);
        },
        tree: (_s, args) => {
          count("tree");
          return JSON.stringify(args);
        },
        plain: (_s, args) => {
          count("plain");
          return JSON.stringify(args);
        },
        slow: slow("Query.slow"),
        node: () => ({ __typename: "A", id: "a1", x: "x" }),
        u: () => ({ __typename: "B", id: "b1", y: "y" }),
        count: () => {
          count("count");
          return 1;
        },
      },
      Mutation: {
        bump: () => {
          count("bump");
          return 1;
        },
      },
      A: { slow: slow("A.slow") },
      B: { slow: slow("B.slow") },
    },
    { Query: { slow: NO_JIT }, A: { slow: NO_JIT }, B: { slow: NO_JIT } },
  );
};

/** Records which jit compilations happened (the jit phase). */
const jitPhases = () => {
  const compiled: Array<string> = [];
  const plugin: Plugin = {
    onPhase: ({ name }, request) => {
      if (name === "jit") {
        compiled.push(request.url);
      }
    },
  };
  return { compiled, plugin };
};

const watchedJit = (options: JitOptions) => {
  const ran: Array<"jit" | "next" | "declined"> = [];
  const inner = jit(options);
  const plugin: Plugin = {
    ...inner,
    onExecute: (input, args) => {
      const executor = inner.onExecute?.(input, args);
      if (executor === undefined) {
        ran.push("declined");
        return undefined;
      }
      return (next) => {
        let delegated = false;
        const result = executor(() => {
          delegated = true;
          return next();
        });
        ran.push(delegated ? "next" : "jit");
        return result;
      };
    },
  };
  return { plugin, ran };
};

const repeat = async (times: number, run: () => Promise<Sent>): Promise<Array<Sent>> => {
  const results: Array<Sent> = [];
  for (let index = 0; index < times; index += 1) {
    results.push(await run());
  }
  return results;
};

describe("executor order", () => {
  it("apq passes through, jit wins on the third use, the default executor otherwise", async () => {
    const claims: Array<string> = [];
    const ran: Array<string> = [];
    const record = (name: string, plugin: Plugin): Plugin => ({
      ...plugin,
      onExecute: (input, args) => {
        const executor = plugin.onExecute?.(input, args);
        claims.push(`${name}:${executor === undefined ? "pass" : "claim"}`);
        if (executor === undefined) {
          return undefined;
        }
        // Records whether the claim ran the operation itself or handed it on (`next`).
        return (next) => {
          let delegated = false;
          const result = executor(() => {
            delegated = true;
            return next();
          });
          ran.push(delegated ? "default" : name);
          return result;
        };
      },
    });
    const tail: Plugin = {
      onExecute: () => {
        claims.push("tail:reached");
        return undefined;
      },
    };
    const server = createServer({
      schema: basicSchema(),
      plugins: [record("apq", apq()), record("jit", jit({ after: 3 })), tail],
    });
    const query = "{ count }";
    const hash = await sha256Hex(query);
    const body = { query, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } };
    for (let use = 1; use <= 4; use += 1) {
      expect((await send(server, post(body))).body).toEqual({ data: { count: 1 } });
    }
    // Every hook runs (a later refusal would still refuse); apq never claims.
    expect(claims).toEqual(
      Array.from({ length: 4 }, () => ["apq:pass", "jit:claim", "tail:reached"]).flat(),
    );
    expect(ran).toEqual(["default", "default", "jit", "jit"]);
  });

  it("an executor returned before jit wins, and jit never counts that use", async () => {
    const phases = jitPhases();
    const server = createServer({
      schema: basicSchema(),
      plugins: [{ onExecute: () => seven }, jit({ after: 1 }), phases.plugin],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 7 } });
    expect(phases.compiled).toEqual([]);
  });
});

describe("refusals do not depend on plugin order", () => {
  it("readOnly() listed after a warm jit() still refuses a mutation, which never runs", async () => {
    const calls: Record<string, number> = {};
    const phases = jitPhases();
    const server = createServer({
      schema: markedSchema(calls, []),
      plugins: [jit({ after: 1 }), readOnly(), phases.plugin],
    });
    const sent = await repeat(3, () => gql(server, "mutation { bump }"));
    expect(sent.map(({ status }) => status)).toEqual([403, 403, 403]);
    expect(calls["bump"]).toBeUndefined();
    expect(phases.compiled).toEqual([]);
  });

  it("maxDepth() listed after a warm jit() still refuses an over-depth query", async () => {
    const phases = jitPhases();
    const server = createServer({
      schema: markedSchema({}, []),
      plugins: [jit({ after: 1 }), maxDepth(1), phases.plugin],
    });
    const sent = await repeat(3, () => gql(server, "{ node { id } }"));
    expect(sent.map(({ error }) => error?.extensions?.["code"])).toEqual([
      "MAX_DEPTH_EXCEEDED",
      "MAX_DEPTH_EXCEEDED",
      "MAX_DEPTH_EXCEEDED",
    ]);
    expect(phases.compiled).toEqual([]);
  });

  it("jit counts and compiles only uses that ran, never refused ones", async () => {
    let refuse = true;
    const phases = jitPhases();
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        jit({ after: 2 }),
        {
          onExecute: () => {
            if (refuse) {
              throw gqlError("not now", 429);
            }
            return undefined;
          },
        },
        phases.plugin,
      ],
    });
    expect((await repeat(3, () => gql(server, "{ count }"))).map(({ status }) => status)).toEqual([
      429, 429, 429,
    ]);
    refuse = false;
    await gql(server, "{ count }");
    expect(phases.compiled).toEqual([]);
    await gql(server, "{ count }");
    expect(phases.compiled).toHaveLength(1);
  });
});

describe("jit({ after })", () => {
  it("compiles once, on the use given by `after`, and keeps serving the same data", async () => {
    const phases = jitPhases();
    const server = createServer({
      schema: basicSchema(),
      plugins: [jit({ after: 2 }), phases.plugin],
    });
    const results = await repeat(4, () => gql(server, '{ count hello(name: "jit") }'));
    expect(results.map(({ body }) => body)).toEqual(
      Array.from({ length: 4 }, () => ({ data: { count: 1, hello: "hello jit" } })),
    );
    expect(phases.compiled).toHaveLength(1);
  });

  it("declines subscriptions", () => {
    const plugin = jit({ after: 1 });
    const schema = makeSchema("type Query { a: Int } type Subscription { tick: Int }");
    const document = parse("subscription { tick }");
    const operation = getOperationAST(document);
    // The JSON path never executes subscriptions, so the hook is called directly.
    const claimed = [1, 2, 3].map(() =>
      plugin.onExecute?.(
        {
          operation: operation!,
          document,
          operationName: undefined,
          operationKey: document,
          request: post({}),
          phase: () => {},
        },
        { schema, document },
      ),
    );
    expect(claimed).toEqual([undefined, undefined, undefined]);
  });

  it("honours isSafe for hand-written schemas", async () => {
    const phases = jitPhases();
    const isSafe = vi.fn((field: { name: string }) => field.name !== "hello");
    const server = createServer({
      schema: basicSchema(),
      plugins: [jit({ after: 1, isSafe }), phases.plugin],
    });
    await gql(server, "{ hello }");
    await gql(server, "{ count }");
    expect(phases.compiled).toHaveLength(1);
    expect(isSafe).toHaveBeenCalled();
  });
});

describe("default resolvers under jit", () => {
  // jit keeps graphql-jit's inlined property reads (src/plugins/jit.ts): a function-valued field
  // without a resolver is read as a value. Grats schemas never rely on that (spec §8 gives every
  // method field a resolve); a hand-written schema keeps such fields on graphql-js with isSafe.
  it("keeps a function-valued root field correct when isSafe sends it to graphql-js", async () => {
    const phases = jitPhases();
    const server = createServer({
      schema: makeSchema("type Query { greeting: String count: Int }"),
      rootValue: { greeting: () => "hi", count: 2 },
      plugins: [jit({ after: 1, isSafe: (field) => field.name !== "greeting" }), phases.plugin],
    });
    const sent = await repeat(3, () => gql(server, "{ greeting count }"));
    expect(sent.map((one) => one.body)).toEqual(
      Array.from({ length: 3 }, () => ({ data: { greeting: "hi", count: 2 } })),
    );
    expect(phases.compiled).toHaveLength(0);
    // The plain field alone is compiled and read as a value.
    await repeat(2, () => gql(server, "{ count }"));
    expect(phases.compiled).toHaveLength(1);
  });
});

describe("regression: a jit-warmed mutation, then a query from the same document", () => {
  it("runs no mutation resolver", async () => {
    const calls: Record<string, number> = {};
    const phases = jitPhases();
    const server = createServer({
      schema: markedSchema(calls, []),
      plugins: [jit({ after: 3 }), phases.plugin],
    });
    const document = "mutation M { bump } query Q { count }";
    await repeat(4, () => gql(server, document, { operationName: "M" }));
    expect(phases.compiled).toHaveLength(1);
    expect(calls["bump"]).toBe(4);
    const queries = await repeat(4, () => gql(server, document, { operationName: "Q" }));
    expect(queries.map(({ body }) => body)).toEqual(
      Array.from({ length: 4 }, () => ({ data: { count: 1 } })),
    );
    expect(calls["bump"]).toBe(4);
    expect(calls["count"]).toBe(4);
    // The query got its own compilation on its own third use.
    expect(phases.compiled).toHaveLength(2);
  });
});

describe("regression: a resolver that calls info.getAbortSignal() stays on graphql-js", () => {
  it.each([
    ["a direct field", "query ($wait: Boolean) { slow(wait: $wait) }", "Query.slow"],
    ["an interface field", "query ($wait: Boolean) { node { id slow(wait: $wait) } }", "A.slow"],
    [
      "a field reached through ... on Interface in a union",
      "query ($wait: Boolean) { u { ... on Node { slow(wait: $wait) } } }",
      "B.slow",
    ],
    [
      "a field reached through a named fragment on the interface",
      "query ($wait: Boolean) { node { ...N } } fragment N on Node { slow(wait: $wait) }",
      "A.slow",
    ],
  ])("%s: warmed past the threshold, and its abort cleanup runs", async (_name, query, where) => {
    const calls: Record<string, number> = {};
    const cleanups: Array<string> = [];
    const phases = jitPhases();
    const server = createServer({
      schema: markedSchema(calls, cleanups),
      plugins: [jit({ after: 3 }), phases.plugin],
    });
    const warm = await repeat(5, () => gql(server, query, { variables: { wait: false } }));
    for (const { status, body } of warm) {
      expect(status).toBe(200);
      expect(body?.errors).toBeUndefined();
      expect(JSON.stringify(body?.data)).toContain(`fast ${where}`);
    }
    expect(phases.compiled).toEqual([]);

    const client = new AbortController();
    const pending = server.handle(
      post({ query, variables: { wait: true } }, { signal: client.signal }),
    );
    await vi.waitFor(() => {
      expect(calls[`slow:${where}`]).toBe(6);
    });
    client.abort();
    expect((await pending).status).toBe(CLIENT_CLOSED_REQUEST);
    expect(cleanups).toEqual([where]);
  });

  it("an unmarked sibling selection is still compiled", async () => {
    const phases = jitPhases();
    const server = createServer({
      schema: markedSchema({}, []),
      plugins: [jit({ after: 1 }), phases.plugin],
    });
    await gql(server, "{ node { id ... on A { x } } u { ... on B { y } } }");
    expect(phases.compiled).toHaveLength(1);
  });
});

describe("regression: a @oneOf variable past the jit threshold", () => {
  const cases: ReadonlyArray<[string, string, (bad: JsonObject) => JsonObject, string]> = [
    [
      "a direct @oneOf variable",
      "query ($p: Pick!) { pick(p: $p) }",
      (pick) => ({ p: pick }),
      "pick",
    ],
    [
      "a @oneOf input nested in another input",
      "query ($w: Wrapper!) { wrapped(w: $w) }",
      (pick) => ({ w: { label: "x", pick } }),
      "wrapped",
    ],
    [
      "a @oneOf input inside a recursive input type",
      "query ($t: Tree!) { tree(t: $t) }",
      (pick) => ({ t: { label: "x", child: { child: { pick } } } }),
      "tree",
    ],
  ];

  it.each(cases)(
    "%s: empty, null-valued and multi-field inputs are rejected, resolver never called",
    async (_name, query, variables, resolver) => {
      const calls: Record<string, number> = {};
      const phases = jitPhases();
      const server = createServer({
        schema: markedSchema(calls, []),
        plugins: [jit({ after: 3 }), phases.plugin],
      });
      const warm = await repeat(4, () => gql(server, query, { variables: variables({ a: 1 }) }));
      expect(warm.every(({ status }) => status === 200)).toBe(true);
      expect(calls[resolver]).toBe(4);
      expect(phases.compiled).toEqual([]);
      for (const bad of [{}, { a: null }, { a: 1, b: "x" }]) {
        const sent = await gql(server, query, { variables: variables(bad) });
        expect(sent.status).toBe(400);
        expect(sent.body?.data).toBeUndefined();
        expect(sent.error?.message).toMatch(/OneOf Input Object type "Pick"/);
      }
      expect(calls[resolver]).toBe(4);
    },
  );

  it("a recursive input type without @oneOf terminates and is compiled", async () => {
    const phases = jitPhases();
    const server = createServer({
      schema: markedSchema({}, []),
      plugins: [jit({ after: 1 }), phases.plugin],
    });
    const sent = await gql(server, "query ($p: Plain!) { plain(p: $p) }", {
      variables: { p: { label: "a", child: { label: "b" } } },
    });
    expect(sent.status).toBe(200);
    expect(phases.compiled).toHaveLength(1);
  });
});

/** A recursive interface with three implementations; `C.secret` is marked jit: false. */
const chainSchema = () =>
  makeSchema(
    `
      interface Node { id: ID next: Node }
      type A implements Node { id: ID next: Node }
      type B implements Node { id: ID next: Node }
      type C implements Node { id: ID next: Node secret: String }
      type Query { node: Node }
    `,
    {},
    { C: { secret: NO_JIT } },
  );

/** `{ node { next { … { id <leaf> } … } } }`, `depth` fields deep. */
const chainQuery = (depth: number, leaf = "") =>
  `{ node ${"{ next ".repeat(depth - 1)}{ id ${leaf} }${" }".repeat(depth - 1)} }`;

const isChainSafe = (schema: ReturnType<typeof chainSchema>, query: string): boolean => {
  const document = parse(query);
  const operation = getOperationAST(document);
  if (operation === null || operation === undefined) {
    throw new Error("no operation");
  }
  return isSelectionSafe(schema, document, operation, () => true);
};

describe("the selection walk over a recursive interface", () => {
  it("walks each (selection set, parent type) once, not once per implementation", () => {
    const schema = chainSchema();
    let lookups = 0;
    for (const name of ["Node", "A", "B", "C"]) {
      const type = schema.getType(name);
      if (type === undefined || !("getFields" in type)) {
        throw new Error(`${name} has no fields`);
      }
      const getFields = type.getFields.bind(type);
      Object.assign(type, {
        getFields: () => {
          lookups += 1;
          return getFields();
        },
      });
    }
    expect(isChainSafe(schema, chainQuery(8))).toBe(true);
    // Four types per field selection, a handful of selections per level: linear in the depth.
    // Without memoization it is 4^8 walks.
    expect(lookups).toBeLessThan(100);
  });

  it("finishes a 30-level selection at once, and still declines a jit: false field deep inside", () => {
    const schema = chainSchema();
    const start = performance.now();
    expect(isChainSafe(schema, chainQuery(30))).toBe(true);
    expect(isChainSafe(schema, chainQuery(30, "... on C { secret }"))).toBe(false);
    expect(isChainSafe(schema, chainQuery(30, "...F") + " fragment F on C { secret }")).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

/** A schema for comparing graphql-jit with graphql-js on successes and resolver errors. */
const shopSchema = () =>
  makeSchema(
    `
      enum Status { OPEN CLOSED }
      interface Owner { name: String! }
      type Person implements Owner { name: String! age: Int }
      type Company implements Owner { name: String! employees: Int }
      type Item {
        id: ID!
        name: String!
        price: Float
        tags: [String!]!
        status: Status!
        broken: String
        brokenAsync: String
        brokenNonNull: String!
        refused: String
      }
      type Order { id: ID! items: [Item!]! nullableItems: [Item] total: Float! owner: Owner }
      union Search = Item | Person
      type Query {
        orders(first: Int = 2): [Order!]!
        order(id: ID!): Order
        search(q: String!): [Search!]!
        later: String
      }
    `,
    {
      Query: {
        orders: (_s, args: { first: number }) =>
          Array.from({ length: args.first }, (_, index) => ({ id: `o${index}` })),
        order: (_s, args: { id: string }) => (args.id === "missing" ? null : { id: args.id }),
        search: () => [
          { __typename: "Item", id: "i9" },
          { __typename: "Person", name: "Ada", age: 36 },
        ],
        later: () => Promise.resolve("later"),
      },
      Order: {
        items: (order: { id: string }) => [
          { __typename: "Item", id: `${order.id}-1` },
          { __typename: "Item", id: `${order.id}-2` },
        ],
        nullableItems: (order: { id: string }) => [{ __typename: "Item", id: `${order.id}-n` }],
        total: () => 12.5,
        owner: (order: { id: string }) =>
          order.id === "o0"
            ? { __typename: "Person", name: "Ada", age: 36 }
            : { __typename: "Company", name: "Acme", employees: 3 },
      },
      Item: {
        name: (item: { id: string }) => `item ${item.id}`,
        price: (item: { id: string }) => (item.id.endsWith("1") ? 9.99 : null),
        tags: () => ["a", "b"],
        status: (item: { id: string }) => (item.id.endsWith("1") ? "OPEN" : "CLOSED"),
        broken: () => {
          throw new Error("broken field");
        },
        brokenAsync: () => Promise.reject(new Error("broken async")),
        brokenNonNull: () => Promise.reject(new Error("broken non-null")),
        refused: () => {
          throw new GraphQLError("refused", { extensions: { code: "FORBIDDEN" } });
        },
      },
    },
  );

const sortErrors = (body: Sent["body"]) => ({
  ...body,
  errors:
    body?.errors === undefined
      ? undefined
      : [...body.errors].toSorted((a, b) =>
          JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)),
        ),
});

/**
 * A graphql-js server and a jit({ after: 1 }) server, plus what jit did for each request (the
 * jit phase alone would also fire for a compilation that failed and fell back to graphql-js).
 */
const servers = (): [Server, Server, ReadonlyArray<string>] => {
  const watched = watchedJit({ after: 1 });
  return [
    createServer({ schema: shopSchema() }),
    createServer({ schema: shopSchema(), plugins: [watched.plugin] }),
    watched.ran,
  ];
};

const errorPaths = (sent: Sent) => sent.body?.errors?.map(({ path }) => path);

describe("jit and default return deep-equal results", () => {
  const suite: ReadonlyArray<[string, string, JsonObject?]> = [
    ["scalars, lists, enums, nulls", "{ orders { id total items { id name price tags status } } }"],
    ["arguments and defaults", "query ($n: Int) { orders(first: $n) { id } }", { n: 3 }],
    [
      "aliases and fragments",
      '{ a: order(id: "x") { ...O } b: order(id: "missing") { ...O } } fragment O on Order { id total }',
    ],
    [
      "interfaces",
      "{ orders { owner { name ... on Person { age } ... on Company { employees } } } }",
    ],
    [
      "unions",
      '{ search(q: "a") { __typename ... on Item { id name } ... on Person { name age } } }',
    ],
    [
      "@skip and @include",
      "query ($yes: Boolean!) { orders { id @include(if: $yes) total @skip(if: $yes) } }",
      { yes: true },
    ],
    ["async resolvers", "{ later }"],
    ["a sync resolver error", "{ orders { items { id broken } } }"],
    ["an async resolver error", "{ orders { items { id brokenAsync } } }"],
    ["a GraphQLError with extensions", '{ order(id: "x") { items { refused } } }'],
    [
      "a non-null error propagating to a nullable list item",
      "{ orders { id nullableItems { id brokenNonNull } } }",
    ],
    ["a non-null error propagating to the root", "{ orders { items { brokenNonNull } } }"],
  ];

  it.each(suite)("%s", async (_name, query, variables) => {
    const [plain, jitted, ran] = servers();
    const expected = await gql(plain, query, { variables });
    const actual = await gql(jitted, query, { variables });
    // The compiled query answered (not graphql-js after a failed compilation).
    expect(ran).toEqual(["jit"]);
    expect(actual.status).toBe(expected.status);
    expect(sortErrors(actual.body)).toEqual(sortErrors(expected.body));
  });

  it.each([
    ["a missing required variable", "query ($id: ID!) { order(id: $id) { id } }", {}],
    ["a variable of the wrong type", "query ($n: Int) { orders(first: $n) { id } }", { n: "many" }],
    [
      "two bad variables",
      "query ($n: Int, $id: ID!) { orders(first: $n) { id } order(id: $id) { id } }",
      { n: "x" },
    ],
  ])("variable-coercion errors match by count and path: %s", async (_name, query, variables) => {
    const [plain, jitted, ran] = servers();
    const expected = await gql(plain, query, { variables });
    const actual = await gql(jitted, query, { variables });
    // The compiled query answered (not graphql-js after a failed compilation).
    expect(ran).toEqual(["jit"]);
    expect(actual.status).toBe(expected.status);
    expect(actual.body?.data).toEqual(expected.body?.data);
    expect(errorPaths(actual)).toEqual(errorPaths(expected));
  });
});

describe("the premise", () => {
  it("graphql-jit's info has no getAbortSignal()", async () => {
    let seen: string | undefined;
    const server = createServer({
      schema: basicSchema({
        Query: {
          hello: (_s, _a, _c, info: GraphQLResolveInfo) => {
            seen = typeof info.getAbortSignal;
            return "x";
          },
        },
      }),
      plugins: [jit({ after: 1 })],
    });
    await gql(server, "{ hello }");
    expect(seen).toBe("undefined");
  });
});
