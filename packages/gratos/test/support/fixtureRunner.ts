// A vitest port of upstream Grats v0.0.36 src/tests/TestRunner.ts (MIT).
//
// Each fixture becomes one test. The produced Markdown must equal the committed
// `<fixture>.expected.md`. Set GRATOS_UPDATE_FIXTURES=1 to rewrite the expected files instead.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown.ts";

export type TransformerResult =
  | { readonly kind: "OK"; readonly value: Markdown }
  | { readonly kind: "ERROR"; readonly err: Markdown | string };

export type Transformer = (
  code: string,
  fileName: string,
) => TransformerResult | Promise<TransformerResult>;

export interface FixtureSuite {
  readonly name: string;
  readonly fixturesDir: string;
  readonly testFilePattern: RegExp;
  readonly ignoreFilePattern: RegExp | null;
  readonly transformer: Transformer;
  /**
   * Why a fixture does not run on the current TypeScript (for example a `tsVersion` gate), or
   * `undefined` to run it. A skipped fixture is reported as skipped, never as a pass.
   */
  readonly skipReason?: (code: string, fileName: string) => string | undefined;
}

const UPDATE = process.env["GRATOS_UPDATE_FIXTURES"] === "1";

const readdirRecursive = (dir: string): Array<string> =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .toSorted();

const runTransformer = async (
  transformer: Transformer,
  code: string,
  fileName: string,
): Promise<TransformerResult> => {
  try {
    return await transformer(code, fileName);
  } catch (error) {
    return { kind: "ERROR", err: error instanceof Error ? error.message : String(error) };
  }
};

export const defineFixtureSuite = (suite: FixtureSuite): void => {
  const files = readdirRecursive(suite.fixturesDir);
  const fixtures = files.filter((file) => suite.testFilePattern.test(file));
  const fixtureSet = new Set(fixtures);
  const expectedSet = new Set(fixtures.map((fixture) => `${fixture}.expected.md`));
  const unexpected = files.filter(
    (file) =>
      !fixtureSet.has(file) &&
      !expectedSet.has(file) &&
      (suite.ignoreFilePattern === null || !suite.ignoreFilePattern.test(file)),
  );

  describe(suite.name, () => {
    it("has no unexpected files", () => {
      expect(unexpected).toEqual([]);
    });

    for (const fixture of fixtures) {
      const fixturePath = join(suite.fixturesDir, fixture);
      const skipReason = suite.skipReason?.(readFileSync(fixturePath, "utf8"), fixture);
      if (skipReason !== undefined) {
        it.skip(`${fixture} (${skipReason})`, () => {});
        continue;
      }
      it(fixture, async () => {
        const expectedPath = `${fixturePath}.expected.md`;
        const code = readFileSync(fixturePath, "utf8");
        const result = await runTransformer(suite.transformer, code, fixture);

        const output = new Markdown();
        output.addHeader(1, fixture);
        output.addHeader(2, "Input");
        output.addCodeBlock(code, extname(fixture).slice(1), fixture);
        output.addHeader(2, "Output");
        const actual = result.kind === "OK" ? result.value : result.err;
        if (typeof actual === "string") {
          output.addCodeBlock(actual, "");
        } else {
          output.addMarkdown(actual);
        }
        const text = output.toString();

        if (UPDATE) {
          writeFileSync(expectedPath, text, "utf8");
        } else {
          const expected = existsSync(expectedPath) ? readFileSync(expectedPath, "utf8") : "";
          expect(text).toBe(expected);
        }

        const isInvalidTest = fixture.includes(".invalid.");
        const hasError = result.kind === "ERROR";
        expect(
          hasError,
          isInvalidTest
            ? `"${fixture}" has ".invalid" in its name but succeeded`
            : `"${fixture}" produced an error but has no ".invalid" in its name`,
        ).toBe(isInvalidTest);
      });
    }
  });
};
