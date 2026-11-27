// The document cache (docs/plan.html M4a): an LRU keyed by (schema generation, query text) of
// validated documents only, parsed with maxTokens, with per-operation plugin state; onPhase for
// parse/validate on a miss only and for jit when a compilation happens; replaceSchema starts a new
// generation while in-flight requests finish on the one they pinned.
import { GraphQLSchema } from "graphql";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/index.ts";
import type { Plugin } from "../src/index.ts";
import { jit } from "../src/jit.ts";
import { gate, gql, sleep } from "./support/http.ts";
import { basicSchema, makeSchema } from "./support/schema.ts";

const phaseRecorder = () => {
  const names: Array<string> = [];
  const plugin: Plugin = { onPhase: ({ name }) => void names.push(name) };
  return { names, plugin };
};

describe("document cache", () => {
  it("a cache hit fires no parse or validate phase", async () => {
    const phases = phaseRecorder();
    const server = createServer({ schema: basicSchema(), plugins: [phases.plugin] });
    await gql(server, "{ count }");
    expect(phases.names).toEqual(["parse", "validate"]);
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
    expect(phases.names).toEqual(["parse", "validate"]);
  });

  it("is keyed by the exact query text", async () => {
    const phases = phaseRecorder();
    const server = createServer({ schema: basicSchema(), plugins: [phases.plugin] });
    await gql(server, "{ count }");
    await gql(server, "{count}");
    expect(phases.names).toEqual(["parse", "validate", "parse", "validate"]);
  });

  it("does not cache invalid documents", async () => {
    const phases = phaseRecorder();
    const server = createServer({ schema: basicSchema(), plugins: [phases.plugin] });
    await gql(server, "{ nope }");
    await gql(server, "{ nope }");
    await gql(server, "{ count");
    await gql(server, "{ count");
    expect(phases.names).toEqual(["parse", "validate", "parse", "validate", "parse", "parse"]);
  });

  it("evicts the least recently used document (default size 1000, configurable)", async () => {
    const phases = phaseRecorder();
    const server = createServer({
      schema: basicSchema(),
      documentCacheSize: 2,
      plugins: [phases.plugin],
    });
    const parses = () => phases.names.filter((name) => name === "parse").length;
    await gql(server, "{ a: count }");
    await gql(server, "{ b: count }");
    await gql(server, "{ a: count }"); // a is now the most recent
    expect(parses()).toBe(2);
    await gql(server, "{ c: count }"); // evicts b
    await gql(server, "{ a: count }");
    expect(parses()).toBe(3);
    await gql(server, "{ b: count }");
    expect(parses()).toBe(4);
  });

  it("parses with maxTokens", async () => {
    const server = createServer({ schema: basicSchema(), maxTokens: 6 });
    expect((await gql(server, "{ a: count }")).status).toBe(200);
    const sent = await gql(server, "{ a: count b: count }");
    expect(sent.status).toBe(400);
    expect(sent.error?.message).toMatch(/Document contains more than 6 tokens/);
  });

  it("keys plugin state by the selected operation", async () => {
    const keys: Array<[string | undefined, object]> = [];
    const server = createServer({
      schema: basicSchema(),
      plugins: [
        {
          onExecute: ({ operation, operationKey }) =>
            void keys.push([operation.name?.value, operationKey]),
        },
      ],
    });
    const query = "query A { count } query B { count }";
    await gql(server, query, { operationName: "A" });
    await gql(server, query, { operationName: "B" });
    await gql(server, query, { operationName: "A" });
    const [a1, b, a2] = keys;
    expect(a1![0]).toBe("A");
    expect(b![0]).toBe("B");
    expect(a1![1]).toBe(a2![1]);
    expect(a1![1]).not.toBe(b![1]);
  });

  it("the third use fires the jit phase, even for a document already cached", async () => {
    const phases = phaseRecorder();
    const server = createServer({ schema: basicSchema(), plugins: [jit(), phases.plugin] });
    await gql(server, "{ count }");
    await gql(server, "{ count }");
    expect(phases.names).toEqual(["parse", "validate"]);
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
    expect(phases.names).toEqual(["parse", "validate", "jit"]);
    await gql(server, "{ count }");
    expect(phases.names).toEqual(["parse", "validate", "jit"]);
  });
});

const v1 = (hold?: Promise<void>) =>
  makeSchema("type Query { old: String version: String }", {
    Query: {
      old: async () => {
        await hold;
        return "old field";
      },
      version: () => "v1",
    },
  });

describe("control.replaceSchema", () => {
  const v2 = makeSchema("type Query { version: String }", { Query: { version: () => "v2" } });

  it("bumps the generation and new requests use the new schema", async () => {
    const phases = phaseRecorder();
    const server = createServer({ schema: v1(), plugins: [phases.plugin] });
    expect((await gql(server, "{ version }")).body).toEqual({ data: { version: "v1" } });
    expect(server.control.generation()).toBe(0);
    server.control.replaceSchema(v2);
    expect(server.control.generation()).toBe(1);
    expect(server.control.schema()).toBe(v2);
    expect((await gql(server, "{ version }")).body).toEqual({ data: { version: "v2" } });
    // The same query text is parsed and validated again for the new generation.
    expect(phases.names).toEqual(["parse", "validate", "parse", "validate"]);
    expect((await gql(server, "{ old }")).status).toBe(400);
  });

  it("an in-flight request finishes on the generation it pinned (held in execution)", async () => {
    const hold = gate();
    const server = createServer({ schema: v1(hold.promise) });
    const inFlight = gql(server, "{ old version }");
    await sleep(5);
    server.control.replaceSchema(v2);
    hold.resolve();
    expect((await inFlight).body).toEqual({ data: { old: "old field", version: "v1" } });
  });

  it("an in-flight request finishes on the generation it pinned (held in context)", async () => {
    const hold = gate();
    const server = createServer({
      schema: v1(),
      context: async () => {
        await hold.promise;
        return {};
      },
    });
    const inFlight = gql(server, "{ old version }");
    await sleep(5);
    server.control.replaceSchema(v2);
    const fresh = gql(server, "{ version }");
    hold.resolve();
    expect((await inFlight).body).toEqual({ data: { old: "old field", version: "v1" } });
    expect((await fresh).body).toEqual({ data: { version: "v2" } });
  });

  it("rejects an invalid schema and keeps the current one", () => {
    const server = createServer({ schema: v2 });
    expect(() => server.control.replaceSchema(new GraphQLSchema({}))).toThrow(/Query root type/);
    expect(server.control.schema()).toBe(v2);
    expect(server.control.generation()).toBe(0);
  });
});
