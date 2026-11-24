// A vitest port of upstream Grats v0.0.36 src/tests/test.ts (MIT): the three fixture suites
// (config parser, schema fixtures, integration fixtures). The transformers follow upstream
// closely, so the committed `.expected.md` snapshots stay the source of truth.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Predicate, Schema } from "effect";
import {
  buildASTSchema,
  graphql,
  GraphQLSchema,
  isSchema,
  print,
  printSchema,
  specifiedScalarTypes,
} from "graphql";
import { diff } from "jest-diff";
import { createCompilerHost, version as tsVersion } from "typescript-baseline";
import type { TextChange } from "typescript-baseline";
import { vi } from "vitest";

import { codegen } from "../src/upstream/codegen/schemaCodegen.ts";
import { applyFixes } from "../src/upstream/fixFixable.ts";
import { validateGratsOptions } from "../src/upstream/gratsConfig.ts";
import type { ParsedCommandLineGrats } from "../src/upstream/gratsConfig.ts";
import { buildSchemaAndDocResult, buildSchemaAndDocResultWithHost } from "../src/upstream/lib.ts";
import { locate } from "../src/upstream/Locate.ts";
import {
  applySDLHeader,
  applyTypeScriptHeader,
  printEnumsModule,
} from "../src/upstream/printSchema.ts";
import { SEMANTIC_NON_NULL_DIRECTIVE } from "../src/upstream/publicDirectives.ts";
import { gqlErr, ReportableDiagnostics } from "../src/upstream/utils/DiagnosticError.ts";
import { extend } from "../src/upstream/utils/helpers.ts";

import { defineFixtureSuite } from "./support/fixtureRunner.ts";
import type { TransformerResult } from "./support/fixtureRunner.ts";
import { Markdown } from "./support/Markdown.ts";

const packageDir = join(import.meta.dirname, "..");
const typesFile = join(packageDir, "src", "upstream", "Types.ts");
const fixturesDir = join(import.meta.dirname, "fixtures");
const configFixturesDir = join(import.meta.dirname, "configParserFixtures");
const integrationFixturesDir = join(import.meta.dirname, "integrationFixtures");

const ok = (value: Markdown): TransformerResult => ({ kind: "OK", value });
const err = (error: Markdown | string): TransformerResult => ({ kind: "ERROR", err: error });
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A fixture may start with `// {…}`: Grats config overrides plus an optional `tsVersion` gate. */
const FixtureHeader = Schema.Struct({ tsVersion: Schema.optional(Schema.String) });
const decodeFixtureHeader = Schema.decodeUnknownSync(FixtureHeader);
const headerJsonOf = (code: string): string | null => {
  const firstLine = code.split("\n")[0] ?? "";
  return firstLine.startsWith("// {") ? firstLine.slice(3) : null;
};
const tsVersionGateOf = (code: string): string | undefined => {
  const json = headerJsonOf(code);
  return json === null ? undefined : decodeFixtureHeader(JSON.parse(json)).tsVersion;
};
const ConfigOverrides = Schema.Record(Schema.String, Schema.Unknown);
const decodeConfigOverrides = Schema.decodeUnknownSync(ConfigOverrides);
/** The header's Grats config overrides, without the test-only `tsVersion` key. */
const configOverridesOf = (code: string) => {
  const json = headerJsonOf(code);
  return decodeConfigOverrides(
    json === null
      ? {}
      : JSON.parse(json, (key: string, value: unknown) =>
          key === "tsVersion" ? undefined : value,
        ),
  );
};

/** The modules a test integration fixture exports. */
const IntegrationServer = Schema.Struct({
  query: Schema.String,
  variables: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  schemaConfig: Schema.optional(Schema.Unknown),
});
const decodeIntegrationServer = Schema.decodeUnknownSync(IntegrationServer);
/** The generated schema.ts exports `getSchema(config?)`. */
type GetSchema = (config: unknown) => GraphQLSchema;
const isGetSchema = (value: unknown): value is GetSchema => Predicate.isFunction(value);

const parseVersion = (version: string): Array<number> => version.split(".").map(Number);
const compareVersions = (a: Array<number>, b: Array<number>): number => {
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
};
/** Upstream gates a few fixtures with `semver.satisfies(ts.version, range)`; they only use `X` and `<=X`. */
const satisfiesTsVersion = (range: string): boolean => {
  const current = parseVersion(tsVersion);
  return range.startsWith("<=")
    ? compareVersions(current, parseVersion(range.slice(2))) <= 0
    : compareVersions(current, parseVersion(range)) === 0;
};

/**
 * Diagnostics print paths relative to the working directory. Upstream ran from its repo root with
 * fixtures in src/tests/; here they live in test/, so map the prefix back to keep the snapshots.
 */
const toUpstreamPaths = (text: string): string =>
  text.replaceAll(
    /(^|\s)test\/(fixtures|integrationFixtures|configParserFixtures)\//g,
    "$1src/tests/$2/",
  );

const noColor = (text: string): string => text;

defineFixtureSuite({
  name: "configParserFixtures",
  fixturesDir: configFixturesDir,
  testFilePattern: /\.json$/,
  ignoreFilePattern: null,
  transformer: (code) => {
    const config: unknown = JSON.parse(code);
    const warnings: Array<string> = [];
    const warn = vi.spyOn(globalThis.console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });
    let parsed: ParsedCommandLineGrats;
    try {
      const parsedResult = validateGratsOptions({
        options: {},
        raw: { grats: config },
        errors: [],
        fileNames: [],
      });
      if (parsedResult.kind === "ERROR") {
        return err(
          formatDiagnosticsWithContext(
            code,
            ReportableDiagnostics.fromDiagnostics(parsedResult.err),
          ),
        );
      }
      parsed = parsedResult.value;
    } catch (error) {
      return err(messageOf(error));
    } finally {
      warn.mockRestore();
    }

    const markdown = new Markdown();
    markdown.addHeader(3, "Parsed Config");
    markdown.addCodeBlock(JSON.stringify(parsed.raw.grats, null, 2), "json");
    if (warnings.length > 0) {
      markdown.addHeader(3, "Warnings");
      markdown.addCodeBlock(warnings.join("\n"), "text");
    }
    return ok(markdown);
  },
});

defineFixtureSuite({
  name: "fixtures",
  fixturesDir,
  testFilePattern: /\.ts$/,
  ignoreFilePattern: null,
  transformer: (code, fileName) => {
    const tsVersionGate = tsVersionGateOf(code);
    if (tsVersionGate !== undefined && !satisfiesTsVersion(tsVersionGate)) {
      return false;
    }
    const config = {
      nullableByDefault: true,
      schemaHeader: null,
      tsSchemaHeader: null,
      ...configOverridesOf(code),
    };

    let parsedOptions: ParsedCommandLineGrats;
    try {
      const parsedOptionsResult = validateGratsOptions({
        options: {},
        raw: { grats: config },
        errors: [],
        fileNames: [join(fixturesDir, fileName), typesFile],
      });
      if (parsedOptionsResult.kind === "ERROR") {
        return err(
          formatDiagnosticsWithContext(
            code,
            ReportableDiagnostics.fromDiagnostics(parsedOptionsResult.err),
          ),
        );
      }
      parsedOptions = parsedOptionsResult.value;
    } catch (error) {
      return err(messageOf(error));
    }

    // setParentNodes is needed for finding JSDoc.
    const compilerHost = createCompilerHost(parsedOptions.options, true);
    const schemaResult = buildSchemaAndDocResultWithHost(parsedOptions, compilerHost);
    if (schemaResult.kind === "ERROR") {
      return err(
        formatDiagnosticsWithContext(code, ReportableDiagnostics.fromDiagnostics(schemaResult.err)),
      );
    }
    const { schema, doc, resolvers } = schemaResult.value;

    // Run codegen here to make sure it doesn't throw.
    const executableSchema = applyTypeScriptHeader(
      parsedOptions.raw.grats,
      codegen(schema, resolvers, parsedOptions.raw.grats, join(fixturesDir, fileName)),
    );

    const locationMatch = /^\/\/ Locate: (.*)/.exec(code);
    if (locationMatch !== null) {
      const locResult = locate(schema, (locationMatch[1] ?? "").trim());
      if (locResult.kind === "ERROR") {
        const markdown = new Markdown();
        markdown.addHeader(3, "Error Locating Type");
        markdown.addCodeBlock(locResult.err, "text");
        return err(markdown);
      }
      return err(
        formatDiagnosticsWithContext(
          code,
          new ReportableDiagnostics(compilerHost, [
            gqlErr({ loc: locResult.value }, "Located here"),
          ]),
        ),
      );
    }

    const docSansDirectives = {
      ...doc,
      definitions: doc.definitions.filter(
        (def) =>
          def.kind !== "ScalarTypeDefinition" ||
          !specifiedScalarTypes.some((scalar) => scalar.name === def.name.value),
      ),
    };
    const sdl = applySDLHeader(parsedOptions.raw.grats, print(docSansDirectives));

    const markdown = new Markdown();
    markdown.addHeader(3, "SDL");
    markdown.addCodeBlock(sdl, "graphql");
    markdown.addHeader(3, "TypeScript");
    markdown.addCodeBlock(executableSchema, "ts");
    return ok(markdown);
  },
});

defineFixtureSuite({
  name: "integrationFixtures",
  fixturesDir: integrationFixturesDir,
  testFilePattern: /index.ts$/,
  ignoreFilePattern: /(schema)|(enums).ts$/,
  transformer: async (code, fileName) => {
    const config = {
      nullableByDefault: true,
      importModuleSpecifierEnding: ".js",
      ...configOverridesOf(code),
    };
    const filePath = join(integrationFixturesDir, fileName);
    const schemaPath = join(dirname(filePath), "schema.ts");

    const parsedOptionsResult = validateGratsOptions({
      options: { rootDir: packageDir, outDir: "dist", configFilePath: "tsconfig.json" },
      raw: { grats: config },
      errors: [],
      fileNames: [filePath, typesFile],
    });
    if (parsedOptionsResult.kind === "ERROR") {
      throw new Error(
        ReportableDiagnostics.fromDiagnostics(
          parsedOptionsResult.err,
        ).formatDiagnosticsWithContext(),
      );
    }
    const parsedOptions = parsedOptionsResult.value;
    const schemaResult = buildSchemaAndDocResult(parsedOptions);
    if (schemaResult.kind === "ERROR") {
      throw new Error(
        ReportableDiagnostics.fromDiagnostics(schemaResult.err).formatDiagnosticsWithContext(),
      );
    }
    const { schema, doc, resolvers } = schemaResult.value;

    writeFileSync(schemaPath, codegen(schema, resolvers, parsedOptions.raw.grats, schemaPath));
    const enumsFile = parsedOptions.raw.grats.tsClientEnums;
    if (enumsFile !== null) {
      const enumsPath = join(dirname(filePath), enumsFile);
      writeFileSync(enumsPath, printEnumsModule(schema, parsedOptions.raw.grats, enumsPath));
    }

    const server = decodeIntegrationServer(await import(filePath));
    const schemaModule: unknown = await import(schemaPath);
    if (!Predicate.hasProperty(schemaModule, "getSchema") || !isGetSchema(schemaModule.getSchema)) {
      throw new Error(`Expected \`${schemaPath}\` to export getSchema()`);
    }
    const actualSchema: unknown = schemaModule.getSchema(server.schemaConfig);
    if (!isSchema(actualSchema)) {
      throw new Error(`\`${schemaPath}\` getSchema() did not return a GraphQLSchema`);
    }
    const schemaDiff = compareSchemas(actualSchema, buildASTSchema(doc));
    if (schemaDiff !== null) {
      throw new Error(`The codegen schema does not match the SDL schema.\n${schemaDiff}`);
    }

    const data = await graphql({
      schema: actualSchema,
      source: server.query,
      variableValues: server.variables,
    });
    const markdown = new Markdown();
    markdown.addHeader(3, "Query Result");
    markdown.addCodeBlock(JSON.stringify(data, null, 2), "json");
    return ok(markdown);
  },
});

const printSDLWithoutSemanticNonNull = (schema: GraphQLSchema): string =>
  printSchema(
    new GraphQLSchema({
      ...schema.toConfig(),
      directives: schema
        .getDirectives()
        .filter((directive) => directive.name !== SEMANTIC_NON_NULL_DIRECTIVE),
    }),
  );

/** Returns null if the schemas print the same, otherwise a diff. */
const compareSchemas = (actual: GraphQLSchema, expected: GraphQLSchema): string | null => {
  const actualSDL = printSDLWithoutSemanticNonNull(actual);
  const expectedSDL = printSDLWithoutSemanticNonNull(expected);
  return actualSDL === expectedSDL ? null : diff(expectedSDL, actualSDL);
};

function formatDiagnosticsWithContext(code: string, diagnostics: ReportableDiagnostics): Markdown {
  const markdown = new Markdown();
  markdown.addHeader(3, "Error Report");
  markdown.addCodeBlock(toUpstreamPaths(diagnostics.formatDiagnosticsWithContext()), "text");

  const actions: Array<{ fixName: string; description: string; diff: string }> = [];
  for (const diagnostic of diagnostics._diagnostics) {
    if (diagnostic.fix === undefined) {
      continue;
    }
    const textChanges: Array<TextChange> = [];
    for (const change of diagnostic.fix.changes) {
      extend(textChanges, change.textChanges);
    }
    let newCode = code;
    // Apply edits in reverse so earlier spans stay valid.
    for (const textChange of textChanges.toSorted((a, b) => b.span.start - a.span.start)) {
      newCode =
        newCode.slice(0, textChange.span.start) +
        textChange.newText +
        newCode.slice(textChange.span.start + textChange.span.length);
    }
    actions.push({
      fixName: diagnostic.fix.fixName,
      description: diagnostic.fix.description,
      diff:
        diff(code, newCode, {
          aAnnotation: "Original",
          bAnnotation: "Fixed",
          aColor: noColor,
          bColor: noColor,
          changeColor: noColor,
          commonColor: noColor,
          patchColor: noColor,
          contextLines: 1,
          expand: false,
        }) ?? "No diff",
    });
  }
  if (actions.length === 0) {
    return markdown;
  }

  for (const action of actions) {
    markdown.addHeader(4, `Code Action: "${action.description}" (${action.fixName})`);
    markdown.addCodeBlock(action.diff, "diff");
  }

  const fileName = diagnostics._diagnostics.find((diagnostic) => diagnostic.fix !== undefined)?.file
    ?.fileName;
  if (fileName === undefined) {
    throw new Error("Cannot apply fixes to diagnostic with no file");
  }
  const logEvents: Array<string> = [];
  const current = readFileSync(fileName, "utf8");
  applyFixes(diagnostics._diagnostics, {
    fix: true,
    log: (event: string) => logEvents.push(event),
  });
  const newText = readFileSync(fileName, "utf8");
  writeFileSync(fileName, current, "utf8");

  markdown.addHeader(4, "Applied Fixes");
  // Upstream ran its fixes from the parent of its repo, so the log says "grats/src/tests/…".
  markdown.addCodeBlock(
    logEvents.join("\n").replaceAll(" in test/fixtures/", " in grats/src/tests/fixtures/"),
    "text",
  );
  markdown.addHeader(4, "Fixed Text");
  markdown.addCodeBlock(newText, "typescript");
  return markdown;
}
