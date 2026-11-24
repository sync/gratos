// The Effect shell around the vendored engine (docs/plan.html M3): config, file IO, the
// compiler-process lifecycle and errors are Effect; extraction and codegen stay upstream's.
//
// generate(tsconfig) reads the tsconfig through FileSystem, decodes its `grats` key with Schema,
// opens the TypeScript 7 project on a tsgo session of its own (the process lives as long as the
// caller's Scope), builds the schema and writes each output file only when its content differs.
// check(tsconfig) does the same without writing, and fails with StaleFilesError when a file is
// missing or out of date.
import { basename, dirname, join, relative, resolve } from "node:path";

import { Data, Effect, FileSystem, Option, Result } from "effect";
import type { PlatformError } from "effect";
import type { Scope } from "effect";

import { getParsedCommandLineOfConfigFile, sys } from "#typescript";
import type { Diagnostic } from "#typescript";

import { decodeGratsConfig } from "./effect/config.ts";
import { decodeFileText, withParseSession } from "./ts/program.ts";
import { acquireSession } from "./ts/session.ts";
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

/** A generated file could not be read (other than because it does not exist yet) or written. */
export class OutputError extends Data.TaggedError("OutputError")<{
  readonly path: string;
  readonly message: string;
}> {}

export type GratsError = ConfigError | DiagnosticsError | StaleFilesError | OutputError;

export interface GeneratedFile {
  /** Absolute path. */
  readonly path: string;
  /** Path relative to the tsconfig's directory, as messages print it. */
  readonly name: string;
  readonly content: string;
  /** Whether the file on disk already had exactly this content, byte for byte (UTF-8). */
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
  // Bytes, decoded by their byte order mark (UTF-8, UTF-16 LE or BE) as TypeScript reads them.
  const bytes = yield* fs.readFile(configPath).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          path: configPath,
          message: `Gratos: Could not read \`${configPath}\`: ${error.message}`,
        }),
    ),
  );
  const decoded = decodeGratsConfig(decodeFileText(bytes));
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
 * Opens the TypeScript project for `configPath` on a tsgo session of its own, scoped to the
 * caller: the session's release is registered before the project is opened, so the process is
 * closed with the scope even when opening fails, and no other session (the facade's default
 * ones, another generate() call) is touched. Fast loading is on unless the config asks for
 * TypeScript errors.
 */
const openProject = Effect.fnUntraced(function* (configPath: string, config: GratsConfig) {
  const session = yield* acquireSession({ blankThirdParty: !config.reportTypeScriptTypeErrors });
  return yield* Effect.try({
    try: () =>
      withParseSession(session, () =>
        getParsedCommandLineOfConfigFile(configPath, undefined, {
          ...sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        }),
      ),
    catch: (cause) =>
      new ConfigError({
        path: configPath,
        message: `Gratos: TypeScript could not open \`${configPath}\`: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
});

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

const outputError =
  (verb: "read" | "write", path: string) =>
  (error: PlatformError.PlatformError): OutputError =>
    new OutputError({ path, message: `Gratos: Could not ${verb} \`${path}\`: ${error.message}` });

/**
 * A generated file's current bytes, or None when it does not exist yet. Any other failure (such
 * as permission denied) is an OutputError: it does not mean the file is out of date.
 *
 * Bytes, not text: decoding would drop a leading byte order mark, so a file with one would pass
 * as up to date although its bytes differ from what Gratos writes.
 */
const readOutput = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFile(path).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.mapError(outputError("read", path)),
  );

/**
 * Where a generated file lands, for comparing outputs:
 * - an existing file: its device and inode, so hard links, symlinks and letter case on a
 *   case-insensitive file system (macOS, Windows) all compare equal;
 * - a symlink whose target is missing: where the target would be;
 * - otherwise: the real path of its nearest existing ancestor joined with the rest, in Unicode
 *   NFC and lowercased. Lowercasing also rejects outputs that differ only by case on a
 *   case-sensitive file system, which no project needs.
 */
const destinationOf = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, path: string) {
  let target = path;
  // A chain of symlinks to missing files, bounded as the OS bounds symlink loops.
  for (let hops = 0; hops < 40; hops += 1) {
    const info = yield* Effect.option(fs.stat(target));
    if (Option.isSome(info) && Option.isSome(info.value.ino)) {
      return `inode:${info.value.dev}:${info.value.ino.value}`;
    }
    const link = yield* Effect.option(fs.readLink(target));
    if (Option.isNone(link)) {
      break;
    }
    target = resolve(dirname(target), link.value);
  }
  const rest: Array<string> = [];
  let current = target;
  for (;;) {
    const real = yield* Effect.option(fs.realPath(current));
    if (Option.isSome(real)) {
      return `path:${join(real.value, ...rest)
        .normalize("NFC")
        .toLowerCase()}`;
    }
    const parent = dirname(current);
    if (parent === current) {
      return `path:${target.normalize("NFC").toLowerCase()}`;
    }
    rest.unshift(basename(current));
    current = parent;
  }
});

const utf8 = new TextEncoder();

/** Whether `bytes` are exactly `content` as Gratos writes it (UTF-8, no byte order mark). */
const hasContent = (bytes: Uint8Array, content: string): boolean => {
  const expected = utf8.encode(content);
  return bytes.length === expected.length && bytes.every((byte, i) => byte === expected[i]);
};

/** Builds every output for `tsconfig` and compares each with the file on disk. */
const build = Effect.fnUntraced(function* (tsconfig: string) {
  const fs = yield* FileSystem.FileSystem;
  const configPath = resolve(tsconfig);
  const { config, warnings } = yield* readConfig(configPath);
  const parsed = yield* openProject(configPath, config);
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
  const planned = outputs(configPath, config, result.value);
  const destinations = yield* Effect.forEach(planned, (output) => destinationOf(fs, output.path));
  const collision =
    planned[destinations.findIndex((destination, i) => destinations.indexOf(destination) !== i)];
  if (collision !== undefined) {
    // Writing both would leave whichever came last, so every run would rewrite the file and
    // --check would never pass (for example `graphqlSchema: "schema.gql"` with metadata on,
    // whose metadata file is named by replacing a `.graphql` extension).
    return yield* new ConfigError({
      path: configPath,
      message: `Gratos: Two generated files would both be written to \`${relative(dirname(configPath), collision.path)}\`. Give \`graphqlSchema\`, \`tsSchema\` and \`tsClientEnums\` distinct paths (with \`EXPERIMENTAL__emitMetadata\`, \`graphqlSchema\` must end in \`.graphql\`).`,
    });
  }
  const files: Array<GeneratedFile> = [];
  for (const output of planned) {
    const existing = yield* readOutput(fs, output.path);
    files.push({
      ...output,
      name: relative(dirname(configPath), output.path),
      upToDate: Option.isSome(existing) && hasContent(existing.value, output.content),
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
        yield* fs
          .writeFileString(file.path, file.content)
          .pipe(Effect.mapError(outputError("write", file.path)));
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
