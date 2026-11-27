// The server core's page, packages/gratos/llm-docs/gratos/server.md (docs/plan.html F4): its hook
// table names every hook of `Plugin`, in the order the core calls them, and its option table
// names every option of `createServer`. The lists below are checked against types.ts by the type
// checker, and the hook order against a real request.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createServer } from "../src/index.ts";
import type { ContextServerOptions, Plugin } from "../src/index.ts";
import { post, send } from "./support/http.ts";
import { basicSchema } from "./support/schema.ts";

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
});
