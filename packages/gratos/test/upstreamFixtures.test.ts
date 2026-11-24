// A vitest port of upstream Grats v0.0.36 src/tests/test.ts (MIT): the three fixture suites
// (config parser, schema fixtures, integration fixtures). The transformers follow upstream
// line by line, so the committed `.expected.md` snapshots stay the source of truth.
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { buildASTSchema, graphql, GraphQLSchema, print, printSchema, specifiedScalarTypes } from "graphql";
import { diff } from "jest-diff";
import * as ts from "typescript-baseline";

import { codegen } from "../src/upstream/codegen/schemaCodegen.js";
import { applyFixes } from "../src/upstream/fixFixable.js";
import { type GratsConfig, type ParsedCommandLineGrats, validateGratsOptions } from "../src/upstream/gratsConfig.js";
import { buildSchemaAndDocResult, buildSchemaAndDocResultWithHost } from "../src/upstream/lib.js";
import { locate } from "../src/upstream/Locate.js";
import { applySDLHeader, applyTypeScriptHeader, printEnumsModule } from "../src/upstream/printSchema.js";
import { SEMANTIC_NON_NULL_DIRECTIVE } from "../src/upstream/publicDirectives.js";
import { gqlErr, ReportableDiagnostics } from "../src/upstream/utils/DiagnosticError.js";
import { extend } from "../src/upstream/utils/helpers.js";

import { defineFixtureSuite, type TransformerResult } from "./support/fixtureRunner.ts";
import { Markdown } from "./support/Markdown.ts";

const packageDir = path.join(import.meta.dirname, "..");
const srcDir = path.join(packageDir, "src", "upstream");
const typesFile = path.join(srcDir, "Types.ts");
const fixturesDir = path.join(import.meta.dirname, "fixtures");
const configFixturesDir = path.join(import.meta.dirname, "configParserFixtures");
const integrationFixturesDir = path.join(import.meta.dirname, "integrationFixtures");

const ok = (value: Markdown): TransformerResult => ({ kind: "OK", value });
const err = (error: Markdown | string): TransformerResult => ({ kind: "ERROR", err: error });

/** Upstream gates a few fixtures with `semver.satisfies(ts.version, range)`; they only use `X` and `<=X`. */
const satisfiesTsVersion = (range: string): boolean => {
  const parse = (version: string): Array<number> => version.split(".").map(Number);
  const compare = (a: Array<number>, b: Array<number>): number => {
    for (let i = 0; i < 3; i++) {
      const delta = (a[i] ?? 0) - (b[i] ?? 0);
      if (delta !== 0) {
        return delta;
      }
    }
    return 0;
  };
  const current = parse(ts.version);
  if (range.startsWith("<=")) {
    return compare(current, parse(range.slice(2))) <= 0;
  }
  return compare(current, parse(range)) === 0;
};

defineFixtureSuite({
  name: "configParserFixtures",
  fixturesDir: configFixturesDir,
  testFilePattern: /\.json$/,
  ignoreFilePattern: null,
  transformer: (code) => {
    const config: unknown = JSON.parse(code);
    const warnings: Array<string> = [];
    const consoleWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    let parsed: ParsedCommandLineGrats;
    try {
      const parsedResult = validateGratsOptions({
        options: {},
        raw: { grats: config },
        errors: [],
        fileNames: [],
      });
      if (parsedResult.kind === "ERROR") {
        return err(formatDiagnosticsWithContext(code, ReportableDiagnostics.fromDiagnostics(parsedResult.err)));
      }
      parsed = parsedResult.value;
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    } finally {
      console.warn = consoleWarn;
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
    const firstLine = code.split("\n")[0] ?? "";
    let config: Partial<GratsConfig> = {
      nullableByDefault: true,
      schemaHeader: null,
      tsSchemaHeader: null,
    };
    if (firstLine.startsWith("// {")) {
      const { tsVersion, ...testOptions } = JSON.parse(firstLine.slice(3)) as {
        tsVersion?: string;
      } & Partial<GratsConfig>;
      if (tsVersion !== undefined && !satisfiesTsVersion(tsVersion)) {
        return false;
      }
      config = { ...config, ...testOptions };
    }

    const files = [path.join(fixturesDir, fileName), typesFile];
    let parsedOptions: ParsedCommandLineGrats;
    try {
      const parsedOptionsResult = validateGratsOptions({
        options: {},
        raw: { grats: config },
        errors: [],
        fileNames: files,
      });
      if (parsedOptionsResult.kind === "ERROR") {
        return err(formatDiagnosticsWithContext(code, ReportableDiagnostics.fromDiagnostics(parsedOptionsResult.err)));
      }
      parsedOptions = parsedOptionsResult.value;
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }

    // setParentNodes is needed for finding JSDoc.
    const compilerHost = ts.createCompilerHost(parsedOptions.options, true);
    const schemaResult = buildSchemaAndDocResultWithHost(parsedOptions, compilerHost);
    if (schemaResult.kind === "ERROR") {
      return err(formatDiagnosticsWithContext(code, ReportableDiagnostics.fromDiagnostics(schemaResult.err)));
    }
    const { schema, doc, resolvers } = schemaResult.value;

    // Run codegen here to make sure it doesn't throw.
    const executableSchema = applyTypeScriptHeader(
      parsedOptions.raw.grats,
      codegen(schema, resolvers, parsedOptions.raw.grats, path.join(fixturesDir, fileName)),
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
          new ReportableDiagnostics(compilerHost, [gqlErr({ loc: locResult.value }, "Located here")]),
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
    const firstLine = code.split("\n")[0] ?? "";
    let config: Partial<GratsConfig> = {
      nullableByDefault: true,
      importModuleSpecifierEnding: ".js",
    };
    if (firstLine.startsWith("// {")) {
      config = { ...config, ...(JSON.parse(firstLine.slice(3)) as Partial<GratsConfig>) };
    }
    const filePath = path.join(integrationFixturesDir, fileName);
    const schemaPath = path.join(path.dirname(filePath), "schema.ts");

    const parsedOptionsResult = validateGratsOptions({
      options: { rootDir: packageDir, outDir: "dist", configFilePath: "tsconfig.json" },
      raw: { grats: config },
      errors: [],
      fileNames: [filePath, typesFile],
    });
    if (parsedOptionsResult.kind === "ERROR") {
      throw new Error(ReportableDiagnostics.fromDiagnostics(parsedOptionsResult.err).formatDiagnosticsWithContext());
    }
    const parsedOptions = parsedOptionsResult.value;
    const schemaResult = buildSchemaAndDocResult(parsedOptions);
    if (schemaResult.kind === "ERROR") {
      throw new Error(ReportableDiagnostics.fromDiagnostics(schemaResult.err).formatDiagnosticsWithContext());
    }
    const { schema, doc, resolvers } = schemaResult.value;

    writeFileSync(schemaPath, codegen(schema, resolvers, parsedOptions.raw.grats, schemaPath));
    const enumsFile = parsedOptions.raw.grats.tsClientEnums;
    if (enumsFile !== null) {
      const enumsPath = path.join(path.dirname(filePath), enumsFile);
      writeFileSync(enumsPath, printEnumsModule(schema, parsedOptions.raw.grats, enumsPath));
    }

    const server = (await import(filePath)) as {
      query?: unknown;
      variables?: Record<string, unknown>;
      schemaConfig?: unknown;
    };
    if (typeof server.query !== "string") {
      throw new Error(`Expected \`${filePath}\` to export a query text as \`query\``);
    }
    const schemaModule = (await import(schemaPath)) as { getSchema: (config: unknown) => GraphQLSchema };
    const actualSchema = schemaModule.getSchema(server.schemaConfig);
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
      directives: schema.getDirectives().filter((directive) => directive.name !== SEMANTIC_NON_NULL_DIRECTIVE),
    }),
  );

/** Returns null if the schemas print the same, otherwise a diff. */
const compareSchemas = (actual: GraphQLSchema, expected: GraphQLSchema): string | null => {
  const actualSDL = printSDLWithoutSemanticNonNull(actual);
  const expectedSDL = printSDLWithoutSemanticNonNull(expected);
  return actualSDL === expectedSDL ? null : diff(expectedSDL, actualSDL);
};

/**
 * Diagnostics print paths relative to the working directory. Upstream ran from its repo root with
 * fixtures in src/tests/; here they live in test/, so map the prefix back to keep the snapshots.
 */
const toUpstreamPaths = (text: string): string =>
  text.replaceAll(/(^|\s)test\/(fixtures|integrationFixtures|configParserFixtures)\//g, "$1src/tests/$2/");

function formatDiagnosticsWithContext(code: string, diagnostics: ReportableDiagnostics): Markdown {
  const markdown = new Markdown();
  markdown.addHeader(3, "Error Report");
  markdown.addCodeBlock(toUpstreamPaths(diagnostics.formatDiagnosticsWithContext()), "text");

  const noColor = (text: string): string => text;
  const actions: Array<{ fixName: string; description: string; diff: string }> = [];
  for (const diagnostic of diagnostics._diagnostics) {
    if (diagnostic.fix == null) {
      continue;
    }
    const textChanges: Array<ts.TextChange> = [];
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

  const fixable = diagnostics._diagnostics.filter((diagnostic) => diagnostic.fix != null);
  if (fixable.length > 0) {
    const fileName = fixable[0]?.file?.fileName;
    if (fileName == null) {
      throw new Error("Cannot apply fixes to diagnostic with no file");
    }
    const logEvents: Array<string> = [];
    const current = readFileSync(fileName, "utf8");
    applyFixes(diagnostics._diagnostics, { fix: true, log: (event: string) => logEvents.push(event) });
    const newText = readFileSync(fileName, "utf8");
    writeFileSync(fileName, current, "utf8");

    markdown.addHeader(4, "Applied Fixes");
    // Upstream ran its fixes from the parent of its repo, so the log says "grats/src/tests/…".
    markdown.addCodeBlock(logEvents.join("\n").replaceAll(" in test/fixtures/", " in grats/src/tests/fixtures/"), "text");
    markdown.addHeader(4, "Fixed Text");
    markdown.addCodeBlock(newText, "typescript");
  }
  return markdown;
}
