// A vitest port of upstream Grats v0.0.36 src/tests/TestRunner.ts (MIT).
//
// Each fixture becomes one test. The produced Markdown must equal the committed
// `<fixture>.expected.md`. Set GRATOS_UPDATE_FIXTURES=1 to rewrite the expected files instead.
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown.ts";

export type TransformerResult =
  | { readonly kind: "OK"; readonly value: Markdown }
  | { readonly kind: "ERROR"; readonly err: Markdown | string }
  | false;

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
}

const UPDATE = process.env["GRATOS_UPDATE_FIXTURES"] === "1";

const readdirRecursive = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
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
      it(fixture, async () => {
        const fixturePath = path.join(suite.fixturesDir, fixture);
        const expectedPath = `${fixturePath}.expected.md`;
        const code = fs.readFileSync(fixturePath, "utf8");
        const result = await runTransformer(suite.transformer, code, fixture);
        if (result === false) {
          return; // skipped by the transformer (for example a tsVersion gate)
        }

        const output = new Markdown();
        output.addHeader(1, fixture);
        output.addHeader(2, "Input");
        output.addCodeBlock(code, path.extname(fixture).slice(1), fixture);
        output.addHeader(2, "Output");
        const actual = result.kind === "OK" ? result.value : result.err;
        if (actual instanceof Markdown) {
          output.addMarkdown(actual);
        } else {
          output.addCodeBlock(actual, "");
        }
        const text = output.toString();

        if (UPDATE) {
          fs.writeFileSync(expectedPath, text, "utf8");
        } else {
          const expected = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath, "utf8") : "";
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
