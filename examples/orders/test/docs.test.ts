// The docs are the example's code (docs/plan.html M7 "Done when": the docs take a new resolver
// through write, generate, nothing, guard, test). Every fenced code block whose info string names
// a `file=<path from the repo root>` must appear in that file, line for line, at any one
// indentation (the formatter re-indents a README's code blocks), so the README's resolver is the
// one that typechecks, is generated, and is tested here and over HTTP.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const DOCS = ["examples/orders/README.md", "packages/gratos/llm-docs/gratos/effect.md"] as const;

interface Snippet {
  readonly file: string;
  readonly code: string;
  /** The line of the opening fence, for the failure message. */
  readonly line: number;
}

const FENCE = /^```\w+ file=(\S+)\n([\s\S]*?)\n```$/gm;

const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * True when `text` holds the lines of `snippet` in a row, each shifted by the same indentation
 * (blank lines match blank lines).
 */
const quotes = (text: string, snippet: string): boolean => {
  const wanted = snippet.split("\n");
  const margin = Math.min(
    ...wanted.filter((line) => line.trim() !== "").map((line) => indentOf(line)),
  );
  const body = wanted.map((line) => (line.trim() === "" ? "" : line.slice(margin)));
  const lines = text.split("\n");
  return lines.some((first, start) => {
    if (body[0] === undefined || !first.endsWith(body[0])) {
      return false;
    }
    const prefix = first.slice(0, first.length - body[0].length);
    if (prefix.trim() !== "") {
      return false;
    }
    return body.every((line, offset) => {
      const actual = lines[start + offset];
      return line === "" ? actual?.trim() === "" : actual === prefix + line;
    });
  });
};

const snippetsOf = (doc: string): Array<Snippet> =>
  [...read(doc).matchAll(FENCE)].map((match) => ({
    file: match[1] ?? "",
    code: match[2] ?? "",
    line: read(doc).slice(0, match.index).split("\n").length,
  }));

describe.each(DOCS)("%s", (doc) => {
  const snippets = snippetsOf(doc);

  it("has code blocks tied to files", () => {
    expect(snippets.length).toBeGreaterThanOrEqual(5);
  });

  it.each(snippets.map((snippet) => [`${snippet.file} (line ${snippet.line})`, snippet] as const))(
    "quotes %s verbatim",
    (_name, snippet) => {
      expect(quotes(read(snippet.file), snippet.code), snippet.code).toBe(true);
    },
  );
});

describe("the README's new resolver", () => {
  const readme = read("examples/orders/README.md");

  it("walks through the spec's five steps, in order", () => {
    const steps = [...readme.matchAll(/^### (\d)\. (\w+)$/gm)].map((match) => match[2]);
    expect(steps).toEqual(["Write", "Generate", "Nothing", "Guard", "Test"]);
  });

  it("writes, generates and tests the same field", () => {
    const files = snippetsOf("examples/orders/README.md").map((snippet) => snippet.file);
    // Write: the model; generate: the SDL and the resolver map; test: a resolver test.
    expect(files).toEqual(
      expect.arrayContaining([
        "examples/orders/src/models/User.ts",
        "examples/orders/src/generated/schema.graphql",
        "examples/orders/src/generated/schema.ts",
        "examples/orders/test/resolvers.test.ts",
      ]),
    );
  });

  it("states the four rules for a new resolver", () => {
    const rules = readme.slice(readme.indexOf("## Rules for a new resolver"));
    expect([...rules.matchAll(/^- \*\*(.+?)\*\*/gm)].map((match) => match[1])).toEqual([
      "Return an Effect.",
      "Fail with a tag.",
      "Guard once.",
      "Stream for live data.",
    ]);
  });
});
