// The Effect shell around the vendored engine (docs/plan.html M3): config, file IO, the
// compiler-process lifecycle and errors are Effect; extraction and codegen stay upstream's.
//
// generate(tsconfig) reads the tsconfig through FileSystem, decodes its `grats` key with Schema,
// opens the TypeScript 7 project (the tsgo process lives as long as the caller's Scope), builds
// the schema and writes each output file only when its content differs. check(tsconfig) does the
// same without writing, and fails with StaleFilesError when a file is missing or out of date.
import { dirname, relative, resolve } from "node:path";

import { Data, Effect, FileSystem, Result } from "effect";
import type { Scope } from "effect";

import { getParsedCommandLineOfConfigFile, sys } from "#typescript";
import type { Diagnostic } from "#typescript";

import { decodeGratsConfig } from "./effect/config.ts";
import { closeDefaultSessions } from "./ts/session.ts";
import type { GratsConfig, ParsedCommandLineGrats } from "./upstream/gratsConfig.ts";
import { buildSchemaAndDocResult } from "./upstream/lib.ts";
import type { SchemaAndDoc } from "./upstream/lib.ts";
import { printEnumsModule, printExecutableSchema, printGratsSDL } from "./upstream/printSchema.ts";
import { ReportableDiagnostics } from "./upstream/utils/DiagnosticError.ts";

/** The tsconfig is missing, unreadable, or its `grats` config is invalid. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly path: string;
  readonly message: string;
}> {}

/** TypeScript or Grats reported diagnostics (config, syntax, type or schema errors). */
export class DiagnosticsError extends Data.TaggedError("DiagnosticsError")<{
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly message: string;
}> {
  /** The diagnostics as upstream's CLI prints them: with color and source context. */
  get formatted(): string {
    return ReportableDiagnostics.fromDiagnostics([
      ...this.diagnostics,
    ]).formatDiagnosticsWithColorAndContext();
  }
}

/** `check` found generated files that are missing or differ from what Gratos would write. */
export class StaleFilesError extends Data.TaggedError("StaleFilesError")<{
  /** The stale files, relative to the tsconfig's directory. */
  readonly files: ReadonlyArray<string>;
  readonly message: string;
}> {}

export type GratsError = ConfigError | DiagnosticsError | StaleFilesError;

export interface GeneratedFile {
  /** Absolute path. */
  readonly path: string;
  /** Path relative to the tsconfig's directory, as messages print it. */
  readonly name: string;
  readonly content: string;
  /** Whether the file on disk already had exactly this content. */
  readonly upToDate: boolean;
}

export interface GenerateResult {
  /** The GraphQL schema (SDL), as written to `graphqlSchema`. */
  readonly sdl: string;
  /** The executable TypeScript schema, as written to `tsSchema`. */
  readonly ts: string;
  /** Non-fatal diagnostics (warnings), such as the use of an experimental option. */
  readonly diagnostics: ReadonlyArray<string>;
  /** Every output file, SDL first. */
  readonly files: ReadonlyArray<GeneratedFile>;
}

const staleMessage = (name: string): string =>
  `Gratos: \`${name}\` is out of date. Run \`gratos\`.`;

/** The nearest tsconfig.json in `directory` or an ancestor, as TypeScript finds it. */
export const findTsconfig = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  let current = resolve(directory);
  while (true) {
    const candidate = resolve(current, "tsconfig.json");
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return yield* new ConfigError({
        path: directory,
        message: `Gratos: Could not find \`tsconfig.json\` searching in ${directory}.`,
      });
    }
    current = parent;
  }
});

const readConfig = Effect.fnUntraced(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          path: configPath,
          message: `Gratos: Could not read \`${configPath}\`: ${error.message}`,
        }),
    ),
  );
  const decoded = decodeGratsConfig(text);
  if (Result.isFailure(decoded)) {
    return yield* new ConfigError({
      path: configPath,
      message: `Gratos: Could not use \`${configPath}\`: ${decoded.failure}`,
    });
  }
  return decoded.success;
});

const diagnosticsError = (diagnostics: ReadonlyArray<Diagnostic>): DiagnosticsError =>
  new DiagnosticsError({
    diagnostics,
    message: ReportableDiagnostics.fromDiagnostics([...diagnostics]).formatDiagnosticsWithContext(),
  });

/**
 * Opens the TypeScript project for `configPath` as a scoped resource: its tsgo process is closed
 * when the scope closes.
 */
const openProject = (configPath: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        getParsedCommandLineOfConfigFile(configPath, undefined, {
          ...sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        }),
      catch: (cause) =>
        new ConfigError({
          path: configPath,
          message: `Gratos: TypeScript could not open \`${configPath}\`: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }),
    () => Effect.sync(closeDefaultSessions),
  );

/** The files Gratos writes for a config, in the order messages list them. */
const outputs = (
  configPath: string,
  config: GratsConfig,
  build: SchemaAndDoc,
): Array<{ path: string; content: string }> => {
  const directory = dirname(configPath);
  const sdlPath = resolve(directory, config.graphqlSchema);
  const tsPath = resolve(directory, config.tsSchema);
  const files = [
    { path: sdlPath, content: printGratsSDL(build.doc, config) },
    {
      path: tsPath,
      content: printExecutableSchema(build.schema, build.resolvers, config, tsPath),
    },
  ];
  if (config.tsClientEnums !== null) {
    const enumsPath = resolve(directory, config.tsClientEnums);
    files.push({ path: enumsPath, content: printEnumsModule(build.schema, config, enumsPath) });
  }
  if (config.EXPERIMENTAL__emitMetadata) {
    files.push({
      path: resolve(directory, config.graphqlSchema.replace(/\.graphql$/, ".json")),
      content: JSON.stringify(build.resolvers, null, 2),
    });
  }
  return files;
};

/** Builds every output for `tsconfig` and compares each with the file on disk. */
const build = Effect.fnUntraced(function* (tsconfig: string) {
  const fs = yield* FileSystem.FileSystem;
  const configPath = resolve(tsconfig);
  const { config, warnings } = yield* readConfig(configPath);
  const parsed = yield* openProject(configPath);
  if (parsed === undefined) {
    return yield* new ConfigError({
      path: configPath,
      message: `Gratos: TypeScript could not open \`${configPath}\`.`,
    });
  }
  if (parsed.errors.length > 0) {
    return yield* diagnosticsError(parsed.errors);
  }
  const options: ParsedCommandLineGrats = { ...parsed, raw: { grats: config } };
  const result = buildSchemaAndDocResult(options);
  if (result.kind === "ERROR") {
    return yield* diagnosticsError(result.err);
  }
  const files: Array<GeneratedFile> = [];
  for (const output of outputs(configPath, config, result.value)) {
    const existing = yield* fs.readFileString(output.path).pipe(Effect.option);
    files.push({
      ...output,
      name: relative(dirname(configPath), output.path),
      upToDate: existing._tag === "Some" && existing.value === output.content,
    });
  }
  const [sdl, tsSchema] = files;
  return {
    sdl: sdl?.content ?? "",
    ts: tsSchema?.content ?? "",
    diagnostics: warnings,
    files,
  } satisfies GenerateResult;
});

/**
 * Generates the schema files for `tsconfig` and writes each one whose content differs from the
 * file on disk. Unchanged files are not written (their mtime is kept).
 */
export const generate = (
  tsconfig: string,
): Effect.Effect<GenerateResult, GratsError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result = yield* build(tsconfig);
    for (const file of result.files) {
      if (!file.upToDate) {
        yield* fs.writeFileString(file.path, file.content).pipe(Effect.orDie);
      }
    }
    return result;
  });

/**
 * Checks that the schema files for `tsconfig` are up to date, without writing anything. Fails
 * with StaleFilesError naming every missing or out-of-date file.
 */
export const check = (
  tsconfig: string,
): Effect.Effect<GenerateResult, GratsError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const result = yield* build(tsconfig);
    const stale = result.files.filter((file) => !file.upToDate).map((file) => file.name);
    if (stale.length > 0) {
      return yield* new StaleFilesError({
        files: stale,
        message: stale.map(staleMessage).join("\n"),
      });
    }
    return result;
  });
