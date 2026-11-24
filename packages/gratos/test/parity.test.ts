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
// is then attributed: turned on alone, it changes exactly the fixtures it applies to, it adds one
// node per field it applies to, and with exactly those nodes undone the output is the oracle's
// byte for byte again (so an unrelated edit inside an attributed fixture still fails). The
// shipped output, every delta on, must undo to the oracle's too.
//
// Query results are compared with upstream's own recordings: the integration fixtures'
// `.expected.md` snapshots. The check below proves from vendor-changes.json that none of them
// changed, and that every changed TypeScript snapshot is one the deltas account for.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

import { Predicate, Schema } from "effect";
import {
  buildASTSchema,
  findBreakingChanges,
  findDangerousChanges,
  isObjectType,
  parse,
  print,
} from "graphql";
import type { GraphQLSchema } from "graphql";
import { printExecutableSchema as oraclePrintExecutableSchema } from "grats-upstream/dist/src/printSchema.js";
import { buildSchemaAndDocResult as oracleBuildSchemaAndDocResult } from "grats-upstream/dist/src/lib.js";
import { validateGratsOptions as oracleValidateGratsOptions } from "grats-upstream/dist/src/gratsConfig.js";
import { describe, expect, it } from "vitest";

import { withCodegenDeltas, withUpstreamCodegen } from "../src/effect/codegen.ts";
import type { CodegenDelta } from "../src/effect/codegen.ts";
import { printExecutableSchema } from "../src/upstream/printSchema.ts";
import { SEMANTIC_NON_NULL_DIRECTIVE } from "../src/upstream/publicDirectives.ts";
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
    schema,
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

/** Every object type field with its resolver definition, as codegen sees them. */
const resolverFields = (
  resolvers: Metadata,
): Array<{ typeName: string; fieldName: string; resolver: ResolverDefinition }> =>
  Object.entries(resolvers.types).flatMap(([typeName, fields]) =>
    Object.entries(fields).map(([fieldName, field]) => ({
      typeName,
      fieldName,
      resolver: field.resolver,
    })),
  );

/** Upstream's isDefaultResolverSignature for a method: upstream emits no resolve for it. */
const isUpstreamDefaultMethod = (fieldName: string, resolver: ResolverDefinition): boolean =>
  resolver.kind === "method" &&
  (resolver.name === null || resolver.name === fieldName) &&
  (resolver.arguments ?? []).every((argument, i) => i === 0 && argument.kind === "argumentsObject");

/** A resolver with a GqlInfo parameter: the jit marker's trigger. */
const usesInfo = (resolver: ResolverDefinition): boolean =>
  resolver.kind !== "property" &&
  (resolver.arguments ?? []).some((argument) => argument.kind === "information");

const isSemanticNonNull = (schema: GraphQLSchema, typeName: string, fieldName: string): boolean => {
  const type = schema.getType(typeName);
  if (!isObjectType(type)) {
    return false;
  }
  const directives = type.getFields()[fieldName]?.astNode?.directives ?? [];
  return directives.some((directive) => directive.name.value === SEMANTIC_NON_NULL_DIRECTIVE);
};

/**
 * The explicit resolve the methodResolvers delta must emit for an upstream-default method, as
 * upstream's resolverCodegen would print it: `source` plus the parameters its arguments use, and
 * the field's own method called with them in the resolver's argument order (upstream's
 * resolverParam), wrapped in assertNonNull for a semantically non-null field.
 */
const expectedMethodResolve = (
  schema: GraphQLSchema,
  typeName: string,
  fieldName: string,
  resolver: ResolverDefinition,
): string => {
  const callArgs = (resolver.kind === "method" ? (resolver.arguments ?? []) : []).map(
    (argument) => {
      if (argument.kind !== "argumentsObject") {
        throw new Error(`not an upstream-default method argument: ${argument.kind}`);
      }
      return "args";
    },
  );
  const params = callArgs.length === 0 ? "source" : "source, args";
  const call = `source.${fieldName}(${callArgs.join(", ")})`;
  const body = isSemanticNonNull(schema, typeName, fieldName) ? `assertNonNull(${call})` : call;
  return `${typeName}.${fieldName}: resolve(${params}) { return ${body}; }`;
};

/** Fixtures each codegen delta applies to, from the engine's resolver metadata. */
const appliesTo: Record<CodegenDelta, (mine: ReturnType<typeof ours>) => boolean> = {
  // §8: a method field that upstream resolves with graphql-js' default resolver.
  methodResolvers: (mine) =>
    resolverFields(mine.resolvers).some(({ fieldName, resolver }) =>
      isUpstreamDefaultMethod(fieldName, resolver),
    ),
  // A resolver with a GqlInfo parameter, in a schema.ts with field configs (not a resolver map).
  jitMarker: (mine) =>
    !mine.emitsResolverMap &&
    resolverFields(mine.resolvers).some(({ resolver }) => usesInfo(resolver)),
  // An Effect.Effect resolver or property: upstream fixtures have none.
  effectSemanticNonNull: () => false,
  effectResolvers: () => false,
};

/**
 * The nodes each delta must add, one per field it applies to, from the engine's resolver
 * metadata, each named by its parent type and field: for methodResolvers the exact explicit
 * resolve (expectedMethodResolve), for jitMarker the marker on the field whose resolver takes
 * the GqlInfo.
 */
const expectedNodes: Record<CodegenDelta, (mine: ReturnType<typeof ours>) => Array<string>> = {
  methodResolvers: (mine) =>
    resolverFields(mine.resolvers).flatMap(({ typeName, fieldName, resolver }) =>
      isUpstreamDefaultMethod(fieldName, resolver)
        ? [expectedMethodResolve(mine.schema, typeName, fieldName, resolver)]
        : [],
    ),
  jitMarker: (mine) =>
    mine.emitsResolverMap
      ? []
      : resolverFields(mine.resolvers).flatMap(({ typeName, fieldName, resolver }) =>
          usesInfo(resolver) ? [`${typeName}.${fieldName}: jit`] : [],
        ),
  effectSemanticNonNull: () => [],
  effectResolvers: () => [],
};

// A delta's nodes as codegen prints them, preceded by the comma it adds to the property before
// and followed by `,` when another property follows. Undoing one removes it and that comma.
// Only the shapes an upstream-default method can take (no arguments, or the arguments object):
// upstream prints every other explicit resolve itself, and one the delta got wrong stays put.
const METHOD_RESOLVE =
  /,\n( +)resolve\((source|source, args)\) \{\n\1 {4}return (.+);\n\1\}(,?)(?=\n)/g;
const METHOD_CALL = /^(assertNonNull\()?source\.(\w+)\((|args)\)(\)?)$/;
const JIT_MARKER =
  /,\n( +)extensions: \{\n\1 {4}gratos: \{\n\1 {8}jit: false\n\1 {4}\}\n\1\}(,?)(?=\n)/g;
/** One jit marker block with its leading comma (and its trailing one, when present). */
const JIT_MARKER_BLOCK = new RegExp(JIT_MARKER.source);
const GRAPHQL_IMPORT = /^import \{ (.*) \} from "graphql";$/m;
const TYPE_CONFIG = /= new GraphQL\w+Type\(\{\n +name: "(\w+)",$/gm;

/**
 * The parent type and field (`Type.field`) of the field config that a property at `indent`, at
 * `offset`, belongs to: the field's `name` at the property's indent, and the `name` of the type
 * config around it.
 */
const enclosingField = (ts: string, offset: number, indent: string): string | undefined => {
  const before = ts.slice(0, offset);
  const nameLine = before.lastIndexOf(`\n${indent}name: "`);
  const fieldName =
    nameLine === -1
      ? undefined
      : /^name: "(\w+)",$/m.exec(before.slice(nameLine + 1 + indent.length))?.[1];
  const typeName = [...before.matchAll(TYPE_CONFIG)].at(-1)?.[1];
  return fieldName === undefined || typeName === undefined ? undefined : `${typeName}.${fieldName}`;
};

const graphqlImports = (ts: string): Array<string> =>
  GRAPHQL_IMPORT.exec(ts)?.[1]?.split(", ") ?? [];

interface UndoneDelta {
  /** schema.ts with the delta's nodes undone. */
  readonly ts: string;
  /**
   * The nodes undone, each as `Type.field: <node>`: the explicit resolve as printed, or `jit`
   * per marker. A strict check compares them with expectedNodes.
   */
  readonly nodes: Array<string>;
}

/**
 * `ts` with exactly the nodes `delta` adds put back as upstream prints them, and the nodes it
 * found, each named by the field it sits on. An explicit resolve calling the field's own method
 * goes; one wrapped in assertNonNull becomes upstream's `assertNonNull(defaultFieldResolver(…))`
 * resolve again, whose import the delta dropped (the only other line it may change). Anything
 * else the delta changed stays, so the result differs from the oracle's; a node with the wrong
 * signature or on the wrong field differs from expectedNodes.
 */
const undoDelta = (delta: CodegenDelta, ts: string, oracleTs: string): UndoneDelta => {
  const nodes: Array<string> = [];
  switch (delta) {
    case "methodResolvers": {
      let restoredDefault = false;
      const undone = ts.replaceAll(
        METHOD_RESOLVE,
        (
          match,
          indent: string,
          params: string,
          expression: string,
          after: string,
          offset: number,
        ) => {
          const call = METHOD_CALL.exec(expression);
          const field = enclosingField(ts, offset, indent);
          const wrapped = call?.[1] !== undefined;
          // Only the field's own method: upstream already resolves a renamed method explicitly.
          if (
            call === null ||
            field === undefined ||
            call[2] !== field.slice(field.indexOf(".") + 1) ||
            wrapped !== (call[4] === ")")
          ) {
            return match;
          }
          nodes.push(`${field}: resolve(${params}) { return ${expression}; }`);
          if (!wrapped) {
            return after;
          }
          restoredDefault = true;
          return `,\n${indent}resolve(source, args, context, info) {\n${indent}    return assertNonNull(defaultFieldResolver(source, args, context, info));\n${indent}}${after}`;
        },
      );
      const ours = graphqlImports(undone);
      const theirs = graphqlImports(oracleTs);
      const droppedOnlyDefaultResolver =
        restoredDefault &&
        theirs.includes("defaultFieldResolver") &&
        theirs.filter((name) => name !== "defaultFieldResolver").join(", ") === ours.join(", ");
      return {
        ts: droppedOnlyDefaultResolver
          ? undone.replace(GRAPHQL_IMPORT, `import { ${theirs.join(", ")} } from "graphql";`)
          : undone,
        nodes,
      };
    }
    case "jitMarker":
      return {
        ts: ts.replaceAll(JIT_MARKER, (_match, indent: string, after: string, offset: number) => {
          nodes.push(`${enclosingField(ts, offset, indent) ?? "?"}: jit`);
          return after;
        }),
        nodes,
      };
    case "effectSemanticNonNull":
    case "effectResolvers":
      return { ts, nodes };
  }
};

/**
 * Undoes `deltas` from `ts` in turn: the nodes found and the nodes expected, sorted, and `ts`
 * with them undone.
 */
const accountForDeltas = (
  deltas: ReadonlyArray<CodegenDelta>,
  ts: string,
  mine: ReturnType<typeof ours>,
  oracleTs: string,
) => {
  const nodes: Array<string> = [];
  const undone = deltas.reduce((current, delta) => {
    const result = undoDelta(delta, current, oracleTs);
    nodes.push(...result.nodes);
    return result.ts;
  }, ts);
  return {
    nodes: nodes.toSorted(),
    expected: deltas.flatMap((delta) => expectedNodes[delta](mine)).toSorted(),
    undone,
  };
};

/**
 * Requires that `ts` is the oracle's schema.ts plus exactly the expected nodes of `deltas`: each
 * on its own field, with the exact signature, and the oracle's byte for byte once undone.
 */
const expectOnlyDeltaNodes = (
  deltas: ReadonlyArray<CodegenDelta>,
  ts: string,
  mine: ReturnType<typeof ours>,
  oracleTs: string,
): void => {
  const { nodes, expected, undone } = accountForDeltas(deltas, ts, mine, oracleTs);
  expect({ deltas, nodes }).toEqual({ deltas, nodes: expected });
  expect(undone).toBe(oracleTs);
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

/** A fixture's resolver metadata, its schema.ts with only `delta` on, and the oracle's schema.ts. */
const deltaOutputs = (fixture: string, delta: CodegenDelta) => {
  const code = readFileSync(join(fixturesDir, fixture), "utf8");
  const mine = ours(fixture, code);
  return { mine, ts: mine.tsWith(delta), oracleTs: oracle(fixture, code).ts };
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

      // Each delta, alone, changes schema.ts exactly when the fixture has a field it applies to,
      // and only by its own nodes: one per field it applies to, and with them undone the output
      // is the oracle's again, byte for byte.
      for (const delta of DELTAS) {
        const ts = mine.tsWith(delta);
        const changed = ts !== reference.ts;
        expect({ delta, changed }).toEqual({ delta, changed: appliesTo[delta](mine) });
        expectOnlyDeltaNodes([delta], ts, mine, reference.ts);
        if (changed) {
          changedBy[delta].add(fixture);
        }
      }
      // The shipped output (every delta on) is the oracle's plus exactly those nodes.
      expectOnlyDeltaNodes(DELTAS, mine.shippedTs, mine, reference.ts);
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

  // The attribution check itself must reject a delta node with the wrong signature or on the
  // wrong field, although undoing such a node still gives the oracle's schema.ts.
  describe("rejects a mis-emitted delta node", () => {
    it("an explicit method resolve that drops the field's arguments", () => {
      const { mine, ts, oracleTs } = deltaOutputs("generics/genericOverArg.ts", "methodResolvers");
      const good = accountForDeltas(["methodResolvers"], ts, mine, oracleTs);
      expect(good.nodes).toEqual([
        "SomeInputSomeClass.someField: resolve(source, args) { return source.someField(args); }",
      ]);
      expect(good.nodes).toEqual(good.expected);
      const dropped = ts.replace(
        /resolve\(source, args\) \{\n( +)return source\.someField\(args\);/,
        "resolve(source) {\n$1return source.someField();",
      );
      expect(dropped).not.toBe(ts);
      const bad = accountForDeltas(["methodResolvers"], dropped, mine, oracleTs);
      expect(bad.undone).toBe(oracleTs);
      expect(bad.nodes).not.toEqual(bad.expected);
    });

    it("a jit marker moved to another field", () => {
      const { mine, ts, oracleTs } = deltaOutputs(
        "resolver_info/StaticMethodWithInfoValue.ts",
        "jitMarker",
      );
      const good = accountForDeltas(["jitMarker"], ts, mine, oracleTs);
      expect(good.nodes).toEqual(["Query.greeting: jit"]);
      expect(good.nodes).toEqual(good.expected);
      const marker = JIT_MARKER_BLOCK.exec(ts)?.[0] ?? "";
      expect(marker).not.toBe("");
      expect(marker.endsWith(",")).toBe(true);
      const moved = ts
        .replace(marker, ",")
        .replace(
          'name: "someField",\n                    type: GraphQLString',
          `name: "someField",\n                    type: GraphQLString${marker.replace(/,$/, "")}`,
        );
      expect(moved).not.toBe(ts);
      const bad = accountForDeltas(["jitMarker"], moved, mine, oracleTs);
      expect(bad.undone).toBe(oracleTs);
      expect(bad.nodes).toEqual(["SomeType.someField: jit"]);
      expect(bad.nodes).not.toEqual(bad.expected);
    });
  });

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
