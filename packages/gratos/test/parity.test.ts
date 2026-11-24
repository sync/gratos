// Parity bar (a) of docs/plan.html: the vendored engine (TS 5.9.2 baseline, graphql 17.1)
// against the published oracle grats@0.0.36 (its own typescript 5.9.2 and graphql 16).
//
// For every valid schema fixture, the oracle's SDL is printed by its graphql 16, re-printed
// through graphql 17's parse/print, and must equal ours byte for byte. graphql 17's
// findBreakingChanges / findDangerousChanges must also report nothing in either direction.
// (The integration fixtures' "Query Result" snapshots, recorded by upstream, already pass.)
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

import { Predicate, Schema } from "effect";
import { buildASTSchema, findBreakingChanges, findDangerousChanges, parse, print } from "graphql";
import type { DocumentNode } from "graphql";
import { buildSchemaAndDocResult as oracleBuildSchemaAndDocResult } from "grats-upstream/dist/src/lib.js";
import { validateGratsOptions as oracleValidateGratsOptions } from "grats-upstream/dist/src/gratsConfig.js";
import { describe, expect, it } from "vitest";

import { validateGratsOptions } from "../src/upstream/gratsConfig.ts";
import { buildSchemaAndDocResult } from "../src/upstream/lib.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");
const typesFile = join(import.meta.dirname, "..", "src", "upstream", "Types.ts");
const oracleRequire = createRequire(import.meta.resolve("grats-upstream/package.json"));
const oracleGraphql: unknown = oracleRequire("graphql");

const OracleGraphql = Schema.Struct({ print: Schema.Any, version: Schema.String });
const oracle = Schema.decodeUnknownSync(OracleGraphql)(oracleGraphql);
type Print = (doc: unknown) => string;
const isPrint = (value: unknown): value is Print => Predicate.isFunction(value);
const printWithOracleGraphql = (doc: unknown): string => {
  if (!isPrint(oracle.print)) {
    throw new Error("oracle graphql has no print()");
  }
  return oracle.print(doc);
};

const FixtureHeader = Schema.Struct({ tsVersion: Schema.optional(Schema.String) });
const decodeFixtureHeader = Schema.decodeUnknownSync(FixtureHeader);
const ConfigOverrides = Schema.Record(Schema.String, Schema.Unknown);
const decodeConfigOverrides = Schema.decodeUnknownSync(ConfigOverrides);
const headerOf = (code: string) => {
  const firstLine = code.split("\n")[0] ?? "";
  if (!firstLine.startsWith("// {")) {
    return { tsVersion: undefined, overrides: decodeConfigOverrides({}) };
  }
  const json = firstLine.slice(3);
  return {
    tsVersion: decodeFixtureHeader(JSON.parse(json)).tsVersion,
    overrides: decodeConfigOverrides(
      JSON.parse(json, (key: string, value: unknown) => (key === "tsVersion" ? undefined : value)),
    ),
  };
};

const fixtures = readdirSync(fixturesDir, { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".invalid."),
  )
  .map((entry) => relative(fixturesDir, join(entry.parentPath, entry.name)))
  .toSorted();

const optionsFor = (fileName: string, code: string) => ({
  options: {},
  raw: {
    grats: {
      nullableByDefault: true,
      schemaHeader: null,
      tsSchemaHeader: null,
      ...headerOf(code).overrides,
    },
  },
  errors: [],
  fileNames: [join(fixturesDir, fileName), typesFile],
});

const oursSdl = (fileName: string, code: string): DocumentNode => {
  const options = validateGratsOptions(optionsFor(fileName, code));
  if (options.kind === "ERROR") {
    throw new Error("vendored engine rejected the config");
  }
  const result = buildSchemaAndDocResult(options.value);
  if (result.kind === "ERROR") {
    throw new Error("vendored engine reported diagnostics");
  }
  return result.value.doc;
};

const oracleSdl = (fileName: string, code: string): string => {
  const options = oracleValidateGratsOptions(optionsFor(fileName, code));
  if (options.kind === "ERROR") {
    throw new Error("oracle rejected the config");
  }
  const result = oracleBuildSchemaAndDocResult(options.value);
  if (result.kind === "ERROR") {
    throw new Error("oracle reported diagnostics");
  }
  return printWithOracleGraphql(result.value.doc);
};

describe("parity with grats@0.0.36", () => {
  it("runs the oracle on graphql 16", () => {
    expect(oracle.version.startsWith("16.")).toBe(true);
  });

  for (const fixture of fixtures) {
    const code = readFileSync(join(fixturesDir, fixture), "utf8");
    // Same gate as upstream's runner: these fixtures only run on TS 5.0.2.
    const skip = headerOf(code).tsVersion !== undefined;
    it.skipIf(skip)(fixture, () => {
      const ours = oursSdl(fixture, code);
      const theirs = parse(oracleSdl(fixture, code));
      expect(print(ours)).toBe(print(theirs));

      const oursSchema = buildASTSchema(ours, { assumeValidSDL: true });
      const theirsSchema = buildASTSchema(theirs, { assumeValidSDL: true });
      expect(findBreakingChanges(theirsSchema, oursSchema)).toEqual([]);
      expect(findDangerousChanges(theirsSchema, oursSchema)).toEqual([]);
      expect(findBreakingChanges(oursSchema, theirsSchema)).toEqual([]);
      expect(findDangerousChanges(oursSchema, theirsSchema)).toEqual([]);
    });
  }
});
