// Parity bar (a) of docs/plan.html: the vendored engine (on the TypeScript 7 facade, graphql 17.1)
// against the published oracle grats@0.0.36 (its own typescript 5.9.2 and graphql 16).
//
// For every valid schema fixture, the oracle's SDL is printed by its graphql 16, re-printed
// through graphql 17's parse/print, and must equal ours byte for byte. graphql 17's
// findBreakingChanges / findDangerousChanges must also report nothing in either direction.
//
// The generated schema.ts is compared live too, byte for byte, with Gratos' codegen deltas
// (src/effect/codegen.ts: explicit method and Effect property resolvers, the jit and
// semanticNonNull markers) turned off through the internal withUpstreamCodegen switch. Each delta
// is then attributed: turned on alone, it changes exactly the fixtures it applies to, and
// nothing else.
//
// Query results are compared with upstream's own recordings: the integration fixtures'
// `.expected.md` snapshots. The check below proves from vendor-changes.json that none of them
// changed, and that every changed TypeScript snapshot is one the deltas account for.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

import { Predicate, Schema } from "effect";
import { buildASTSchema, findBreakingChanges, findDangerousChanges, parse, print } from "graphql";
import { printExecutableSchema as oraclePrintExecutableSchema } from "grats-upstream/dist/src/printSchema.js";
import { buildSchemaAndDocResult as oracleBuildSchemaAndDocResult } from "grats-upstream/dist/src/lib.js";
import { validateGratsOptions as oracleValidateGratsOptions } from "grats-upstream/dist/src/gratsConfig.js";
import { describe, expect, it } from "vitest";

import { withCodegenDeltas, withUpstreamCodegen } from "../src/effect/codegen.ts";
import type { CodegenDelta } from "../src/effect/codegen.ts";
import { printExecutableSchema } from "../src/upstream/printSchema.ts";
import { validateGratsOptions } from "../src/upstream/gratsConfig.ts";
import { buildSchemaAndDocResult } from "../src/upstream/lib.ts";
import type { Metadata, ResolverDefinition } from "../src/upstream/metadata.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");
const typesFile = join(import.meta.dirname, "..", "src", "upstream", "Types.ts");
const oracleRequire = createRequire(import.meta.resolve("grats-upstream/package.json"));
const oracleGraphql: unknown = oracleRequire("graphql");

const OracleGraphql = Schema.Struct({ print: Schema.Any, version: Schema.String });
const oracleGraphqlModule = Schema.decodeUnknownSync(OracleGraphql)(oracleGraphql);
type Print = (doc: unknown) => string;
const isPrint = (value: unknown): value is Print => Predicate.isFunction(value);
const printWithOracleGraphql = (doc: unknown): string => {
  if (!isPrint(oracleGraphqlModule.print)) {
    throw new Error("oracle graphql has no print()");
  }
  return oracleGraphqlModule.print(doc);
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
  .map((entry) => relative(fixturesDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
  .toSorted();

/** Same gate as upstream's runner: fixtures with a `tsVersion` header only run on TS 5.0.2. */
const isTsVersionGated = (fixture: string): boolean =>
  headerOf(readFileSync(join(fixturesDir, fixture), "utf8")).tsVersion !== undefined;

/** The oracle predates Gratos' `libraryImport` option; ours names the library as upstream does. */
const optionsFor = (fileName: string, code: string, extra: { libraryImport?: string } = {}) => ({
  options: {},
  raw: {
    grats: {
      nullableByDefault: true,
      schemaHeader: null,
      tsSchemaHeader: null,
      ...extra,
      ...headerOf(code).overrides,
    },
  },
  errors: [],
  fileNames: [join(fixturesDir, fileName), typesFile],
});

/** Our SDL document, resolver metadata and generated schema.ts (with the given deltas) for a fixture. */
const ours = (fileName: string, code: string) => {
  const options = validateGratsOptions(optionsFor(fileName, code, { libraryImport: "grats" }));
  if (options.kind === "ERROR") {
    throw new Error("vendored engine rejected the config");
  }
  const result = buildSchemaAndDocResult(options.value);
  if (result.kind === "ERROR") {
    throw new Error("vendored engine reported diagnostics");
  }
  const { schema, doc, resolvers } = result.value;
  const print = () =>
    printExecutableSchema(schema, resolvers, options.value.raw.grats, join(fixturesDir, fileName));
  return {
    doc,
    resolvers,
    emitsResolverMap: options.value.raw.grats.EXPERIMENTAL__emitResolverMap,
    /** schema.ts as upstream generates it: every Gratos codegen delta off. */
    upstreamTs: withUpstreamCodegen(print),
    /** schema.ts as Gratos ships it (every delta on). */
    shippedTs: print(),
    /** schema.ts with only `delta` on. */
    tsWith: (delta: CodegenDelta) => withCodegenDeltas(new Set([delta]), print),
  };
};

/** The oracle's SDL (printed by its graphql 16) and generated schema.ts for a fixture. */
const oracle = (fileName: string, code: string) => {
  const options = oracleValidateGratsOptions(optionsFor(fileName, code));
  if (options.kind === "ERROR") {
    throw new Error("oracle rejected the config");
  }
  const result = oracleBuildSchemaAndDocResult(options.value);
  if (result.kind === "ERROR") {
    throw new Error("oracle reported diagnostics");
  }
  const { schema, doc, resolvers } = result.value;
  return {
    sdl: printWithOracleGraphql(doc),
    ts: oraclePrintExecutableSchema(
      schema,
      resolvers,
      options.value.raw.grats,
      join(fixturesDir, fileName),
    ),
  };
};

/** Snapshots recorded in vendor-changes.json, which lists every intentionally changed vendored file. */
const LedgerChanges = Schema.Struct({ changes: Schema.Record(Schema.String, Schema.Unknown) });
/** Fixtures whose schema.ts each codegen delta changes (counted from the run, set deliberately). */
const METHOD_RESOLVER_FIXTURES = 60;
const JIT_MARKER_FIXTURES = 3;
const CHANGED_FIXTURES = 63;

const changedVendoredFiles = Object.keys(
  Schema.decodeUnknownSync(LedgerChanges)(
    JSON.parse(readFileSync(join(import.meta.dirname, "..", "vendor-changes.json"), "utf8")),
  ).changes,
);

/** The resolver definitions of every object type field, as codegen sees them. */
const resolverDefinitions = (resolvers: Metadata): Array<ResolverDefinition> =>
  Object.values(resolvers.types).flatMap((fields) =>
    Object.values(fields).map((field) => field.resolver),
  );

/** Upstream's isDefaultResolverSignature for a method: upstream emits no resolve for it. */
const isUpstreamDefaultMethod = (fieldName: string, resolver: ResolverDefinition): boolean =>
  resolver.kind === "method" &&
  (resolver.name === null || resolver.name === fieldName) &&
  (resolver.arguments ?? []).every((argument, i) => i === 0 && argument.kind === "argumentsObject");

/** Fixtures each codegen delta applies to, from the engine's resolver metadata. */
const appliesTo: Record<CodegenDelta, (mine: ReturnType<typeof ours>) => boolean> = {
  // §8: a method field that upstream resolves with graphql-js' default resolver.
  methodResolvers: (mine) =>
    Object.values(mine.resolvers.types).some((fields) =>
      Object.entries(fields).some(([fieldName, field]) =>
        isUpstreamDefaultMethod(fieldName, field.resolver),
      ),
    ),
  // A resolver with a GqlInfo parameter, in a schema.ts with field configs (not a resolver map).
  jitMarker: (mine) =>
    !mine.emitsResolverMap &&
    resolverDefinitions(mine.resolvers).some(
      (resolver) =>
        resolver.kind !== "property" &&
        (resolver.arguments ?? []).some((argument) => argument.kind === "information"),
    ),
  // An Effect.Effect resolver or property: upstream fixtures have none.
  effectSemanticNonNull: () => false,
  effectResolvers: () => false,
};

const DELTAS: ReadonlyArray<CodegenDelta> = [
  "methodResolvers",
  "jitMarker",
  "effectSemanticNonNull",
  "effectResolvers",
];

/** Per delta, the fixtures whose schema.ts it changes; filled by the per-fixture tests. */
const changedBy: Record<CodegenDelta | "any", Set<string>> = {
  methodResolvers: new Set(),
  jitMarker: new Set(),
  effectSemanticNonNull: new Set(),
  effectResolvers: new Set(),
  any: new Set(),
};

describe("parity with grats@0.0.36", () => {
  it("compares every eligible fixture", () => {
    // 236 valid schema fixtures compared live; 2 only run on TS 5.0.2 and are skipped, as upstream does.
    expect(fixtures.filter((fixture) => !isTsVersionGated(fixture))).toHaveLength(236);
    expect(fixtures.filter(isTsVersionGated)).toEqual([
      "descriptions/DescriptionWithGitHubHandle.ts",
      "user_error/TypeErrorWithTypeCheckingEnabled.ts",
    ]);
  });

  it("runs the oracle on graphql 16", () => {
    expect(oracleGraphqlModule.version.startsWith("16.")).toBe(true);
  });

  for (const fixture of fixtures) {
    const code = readFileSync(join(fixturesDir, fixture), "utf8");
    it.skipIf(isTsVersionGated(fixture))(fixture, () => {
      const mine = ours(fixture, code);
      const reference = oracle(fixture, code);
      // The complete generated schema.ts (with tsSchemaHeader, or the resolver map when configured),
      // with Gratos' codegen deltas off: our TypeScript 7 printer against the oracle's TypeScript
      // 5.9.2 printer, byte for byte.
      expect(mine.upstreamTs).toBe(reference.ts);

      // Each delta, alone, changes schema.ts exactly when the fixture has a field it applies to.
      for (const delta of DELTAS) {
        const changed = mine.tsWith(delta) !== reference.ts;
        expect({ delta, changed }).toEqual({ delta, changed: appliesTo[delta](mine) });
        if (changed) {
          changedBy[delta].add(fixture);
        }
      }
      if (mine.shippedTs !== reference.ts) {
        changedBy.any.add(fixture);
      }

      const theirs = parse(reference.sdl);
      expect(print(mine.doc)).toBe(print(theirs));

      const oursSchema = buildASTSchema(mine.doc, { assumeValidSDL: true });
      const theirsSchema = buildASTSchema(theirs, { assumeValidSDL: true });
      expect(findBreakingChanges(theirsSchema, oursSchema)).toEqual([]);
      expect(findDangerousChanges(theirsSchema, oursSchema)).toEqual([]);
      expect(findBreakingChanges(oursSchema, theirsSchema)).toEqual([]);
      expect(findDangerousChanges(oursSchema, theirsSchema)).toEqual([]);
    });
  }

  // Runs after the per-fixture tests (vitest runs a file's tests in order).
  it("attributes every schema.ts difference to a codegen delta", () => {
    // The shipped output differs from upstream's exactly on the union of the deltas' fixtures.
    expect([...changedBy.any].toSorted()).toEqual(
      [...new Set([...changedBy.methodResolvers, ...changedBy.jitMarker])].toSorted(),
    );
    expect({
      methodResolvers: changedBy.methodResolvers.size,
      jitMarker: changedBy.jitMarker.size,
      effectSemanticNonNull: changedBy.effectSemanticNonNull.size,
      effectResolvers: changedBy.effectResolvers.size,
      any: changedBy.any.size,
    }).toEqual({
      methodResolvers: METHOD_RESOLVER_FIXTURES,
      jitMarker: JIT_MARKER_FIXTURES,
      effectSemanticNonNull: 0,
      effectResolvers: 0,
      any: CHANGED_FIXTURES,
    });
  });

  it("keeps upstream's recorded query results, and changes only delta-attributed TypeScript", () => {
    // No integration snapshot (Query Result) changed. Only the generated schema.ts of the two
    // fixtures with a method field changed (§8), and their Query Results are still upstream's.
    expect(
      changedVendoredFiles.filter((file) => file.startsWith("test/integrationFixtures/")),
    ).toEqual([
      "test/integrationFixtures/killsParentOnException/schema.ts",
      "test/integrationFixtures/killsParentOnExceptionReturnsNull/schema.ts",
    ]);
    const changedSnapshotsWithTypeScript = changedVendoredFiles
      .filter((file) => file.startsWith("test/fixtures/") && file.endsWith(".expected.md"))
      .filter((file) => {
        const path = join(import.meta.dirname, "..", file);
        // Removed files (the cut locate fixtures) are in the ledger too.
        return existsSync(path) && readFileSync(path, "utf8").includes("### TypeScript");
      });
    // These 3 changed their SDL in M1b (graphql 17 prints object literals with spaces); every other
    // changed snapshot with a TypeScript section is one whose schema.ts a codegen delta changes.
    const sdlOnly = [
      "test/fixtures/arguments/PositionalArgDeprecatedWithDefault.ts.expected.md",
      "test/fixtures/default_values/DefaultArgumentObjectLiteral.ts.expected.md",
      "test/fixtures/enums/NonNullEnumDefaultInInputObject.ts.expected.md",
    ];
    const deltaSnapshots = [...changedBy.any].map(
      (fixture) => `test/fixtures/${fixture}.expected.md`,
    );
    expect(changedSnapshotsWithTypeScript.toSorted()).toEqual(
      [...new Set([...sdlOnly, ...deltaSnapshots])].toSorted(),
    );
  });
});
