#!/usr/bin/env node

// LLM agent docs: See the llm-docs/ directory in the package root for
// Markdown documentation covering all Grats features and configuration.

import * as E from "./Errors.ts";
import { getParsedTsConfig } from "./index.ts";
import { type SchemaAndDoc, buildSchemaAndDocResult } from "./lib.ts";
import { Command } from "commander";
import { writeFileSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  printGratsSDL,
  printExecutableSchema,
  printEnumsModule,
} from "./printSchema.ts";
import * as ts from "typescript-baseline";
import {
  locationlessErr,
  ReportableDiagnostics,
  type DiagnosticsWithoutLocationResult,
} from "./utils/DiagnosticError.ts";
import { type GratsConfig, type ParsedCommandLineGrats } from "./gratsConfig.ts";
import { err, ok } from "./utils/Result.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const version = readPackageVersion();

function readPackageVersion(): string {
  // Works from both source (src/cli.ts → ../package.json)
  // and compiled output (dist/src/cli.js → ../../package.json)
  for (const relPath of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, relPath), "utf8"));
      if (pkg.name === "grats") return pkg.version;
    } catch {
      // Ignore missing/unreadable package.json files
    }
  }
  console.error(
    "Grats: Could not determine package version. Please report this issue at https://github.com/captbaritone/grats/issues",
  );
  return "unknown";
}

const program = new Command();

program
  .name("grats")
  .description("Extract GraphQL schema from your TypeScript project")
  .version(version)
  .option(
    "--tsconfig <TSCONFIG>",
    "Path to tsconfig.json. Defaults to auto-detecting based on the current working directory",
  )
  .action(async ({ tsconfig }) => {
    runBuild(tsconfig);
  });

program.parse();

/**
 * Run the compiler performing a single build.
 */
function runBuild(tsconfig: string) {
  const { config, configPath } = handleDiagnostics(getTsConfig(tsconfig));
  const schemaAndDoc = handleDiagnostics(buildSchemaAndDocResult(config));
  writeSchemaFilesAndReport(schemaAndDoc, config, configPath);
}

/**
 * Serializes the SDL and TypeScript schema to disk and reports to the console.
 */
function writeSchemaFilesAndReport(
  schemaAndDoc: SchemaAndDoc,
  config: ParsedCommandLineGrats,
  configPath: string,
) {
  const { schema, doc, resolvers } = schemaAndDoc;

  const gratsConfig: GratsConfig = config.raw.grats;

  const dest = resolve(dirname(configPath), gratsConfig.tsSchema);
  const code = printExecutableSchema(schema, resolvers, gratsConfig, dest);
  writeFileSync(dest, code);
  console.error(`Grats: Wrote TypeScript schema to \`${dest}\`.`);

  const schemaStr = printGratsSDL(doc, gratsConfig);

  const absOutput = resolve(dirname(configPath), gratsConfig.graphqlSchema);
  writeFileSync(absOutput, schemaStr);
  console.error(`Grats: Wrote schema to \`${absOutput}\`.`);

  if (config.raw.grats.EXPERIMENTAL__emitMetadata) {
    const absOutput = resolve(
      dirname(configPath),
      gratsConfig.graphqlSchema.replace(/\.graphql$/, ".json"),
    );
    writeFileSync(absOutput, JSON.stringify(resolvers, null, 2));
    console.error(`Grats: Wrote resolver signatures to \`${absOutput}\`.`);
  }

  if (config.raw.grats.tsClientEnums != null) {
    const absOutput = resolve(
      dirname(configPath),
      config.raw.grats.tsClientEnums,
    );
    const enumCode = printEnumsModule(schema, gratsConfig, absOutput);
    writeFileSync(absOutput, enumCode);
    console.error(`Grats: Wrote enums module to \`${absOutput}\`.`);
  }
}

/**
 * Utility function to report diagnostics to the console.
 */
function handleDiagnostics<T>(result: DiagnosticsWithoutLocationResult<T>): T {
  if (result.kind === "ERROR") {
    const reportable = ReportableDiagnostics.fromDiagnostics(result.err);
    console.error(reportable.formatDiagnosticsWithColorAndContext());
    process.exit(1);
  }
  return result.value;
}

// Locate and read the tsconfig.json file
function getTsConfig(tsconfig?: string): DiagnosticsWithoutLocationResult<{
  configPath: string;
  config: ParsedCommandLineGrats;
}> {
  const cwd = process.cwd();
  const configPath = tsconfig || ts.findConfigFile(cwd, ts.sys.fileExists);
  if (configPath == null) {
    return err([locationlessErr(E.tsConfigNotFound(cwd))]);
  }
  const optionsResult = getParsedTsConfig(configPath);
  if (optionsResult.kind === "ERROR") {
    return err(optionsResult.err);
  }
  return ok({ configPath, config: optionsResult.value });
}
