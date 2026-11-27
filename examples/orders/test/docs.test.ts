// The docs are the example's code (docs/plan.html M7 "Done when": the docs take a new resolver
// through write, generate, nothing, guard, test). Every fenced code block whose info string names
// a `file=<path from the repo root>` must appear in that file, line for line, at any one
// indentation (the formatter re-indents a README's code blocks), so the README's resolver is the
// one that typechecks, is generated, and is tested here and over HTTP.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/**
 * Every document with tagged code blocks, and how many it has at least: a block that is dropped,
 * or that the matcher stops seeing, fails its document's count.
 */
const DOCS = {
  "examples/orders/README.md": 11,
  "packages/gratos/llm-docs/gratos/effect.md": 8,
  "packages/gratos/llm-docs/gratos/differences.md": 5,
  "packages/gratos/llm-docs/gratos/server.md": 6,
  "packages/gratos/README.md": 2,
  "packages/gratos-server/README.md": 1,
} as const;

interface Snippet {
  readonly file: string;
  readonly code: string;
  /** The line of the opening fence, for the failure message. */
  readonly line: number;
}

/**
 * A tagged block, also inside a list item: its fences share an indentation, and its lines carry
 * it too (`quotes` takes the lines at any one indentation).
 */
const FENCE = /^( *)```\w+ file=(\S+)\n([\s\S]*?)\n\1```$/gm;

/** Every opening fence that names a file, matched by FENCE or not. */
const TAGGED_FENCE = /^\s*```\S* +file=/gm;

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

/** The tagged code blocks of `text` (the text of `doc`, or a part of it starting at its `line`). */
const snippetsIn = (text: string, firstLine = 1): Array<Snippet> =>
  [...text.matchAll(FENCE)].map((match) => ({
    file: match[2] ?? "",
    code: match[3] ?? "",
    line: firstLine + text.slice(0, match.index).split("\n").length - 1,
  }));

const snippetsOf = (doc: string): Array<Snippet> => snippetsIn(read(doc));

/** The README's `### n. Name` sections: each step's name, its prose, and its tagged code blocks. */
const stepsOf = (readme: string) => {
  const headings = [...readme.matchAll(/^### (\d)\. (\w+)$/gm)];
  return headings.map((heading, index) => {
    const start = heading.index;
    const next = headings[index + 1]?.index ?? readme.indexOf("\n## ", start);
    const text = readme.slice(start, next === -1 ? undefined : next);
    return {
      name: heading[2] ?? "",
      /** The step's text, with its line breaks as spaces. */
      prose: text.replaceAll(/\s+/g, " "),
      snippets: snippetsIn(text, readme.slice(0, start).split("\n").length),
    };
  });
};

describe.each(Object.entries(DOCS))("%s", (doc, minimum) => {
  const snippets = snippetsOf(doc);

  it(`has at least ${minimum} code blocks tied to files`, () => {
    expect(snippets.length).toBeGreaterThanOrEqual(minimum);
  });

  it("checks every block that names a file", () => {
    expect(snippets.length).toBe([...read(doc).matchAll(TAGGED_FENCE)].length);
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

  // Each step shows its own code, quoted from the file it lives in (so it compiles and runs), and
  // the steps that touch the field (write, generate, test) all name the same one.
  const sections = stepsOf(readme);
  const steps = new Map(sections.map((step) => [step.name, step.snippets]));
  const files = (step: string) => (steps.get(step) ?? []).map((snippet) => snippet.file);
  const code = (step: string) => (steps.get(step) ?? []).map((snippet) => snippet.code).join("\n");
  const prose = (step: string) => sections.find((section) => section.name === step)?.prose ?? "";

  it("shows each step's own code, quoted from its file", () => {
    expect(files("Write")).toEqual(["examples/orders/src/models/User.ts"]);
    expect(files("Generate")).toEqual([
      "examples/orders/src/generated/schema.graphql",
      "examples/orders/src/generated/schema.ts",
    ]);
    expect(files("Nothing")).toEqual([]);
    expect(files("Guard")).toEqual(["examples/orders/src/models/User.ts"]);
    expect(files("Test")).toEqual(["examples/orders/test/resolvers.test.ts"]);
  });

  it("says why step 3 is nothing: effectSchema runs a new field with no registration", () => {
    expect(prose("Nothing")).toContain("There is no step 3: nothing registers the new field.");
    expect(prose("Nothing")).toContain(
      "`effectSchema` wraps every resolver of the schema once, at startup",
    );
    expect(prose("Nothing")).toContain("`src/graphql.ts` does not change.");
  });

  it("writes, generates, guards and tests the same field", () => {
    // Write: the query field's function.
    const field = /@gqlQueryField \*\/\nexport function (\w+)\(/.exec(code("Write"))?.[1] ?? "";
    expect(field).not.toBe("");
    const capitalized = `${field.charAt(0).toUpperCase()}${field.slice(1)}`;
    // Generate: the field in the SDL, and its generated resolver calling the written function.
    expect(code("Generate")).toMatch(new RegExp(`^\\s*${field}\\(`, "m"));
    expect(code("Generate")).toContain(`return query${capitalized}Resolver(`);
    // Guard: the guard call is the written code's own.
    expect(quotes(code("Write"), code("Guard"))).toBe(true);
    // Test: the written function, run with a fake layer.
    expect(code("Test")).toMatch(new RegExp(`\\b${field}\\(`));
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
