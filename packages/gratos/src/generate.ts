// The Effect shell around the vendored engine (docs/plan.html M3): config, file IO, the
// compiler-process lifecycle and errors are Effect; extraction and codegen stay upstream's.
//
// generate(tsconfig) reads the tsconfig through FileSystem, decodes its `grats` key with Schema,
// opens the TypeScript 7 project on a tsgo session of its own (the process lives as long as the
// caller's Scope), builds the schema and writes each output file only when its content differs.
// check(tsconfig) does the same without writing, and fails with StaleFilesError when a file is
// missing or out of date.
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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

/** A path key: letter case and Unicode spelling never tell two outputs apart. */
const pathKey = (physical: string): string => `path:${physical.normalize("NFC").toLowerCase()}`;

/** The symlink hops one walk may take, as Linux bounds the links of one path lookup. */
const maxHops = 40;

/**
 * A path's root (empty for a relative path) and its segments after the root, in order. The root
 * is parsed first, so a Windows drive (`C:\`) or UNC share (`\\server\share\`) is never read
 * as segments. Only Windows also separates segments with a backslash. Exported for its test,
 * which runs it with `path.win32` too.
 */
export const splitPath = (
  path: string,
  platform: {
    readonly parse: (path: string) => { readonly root: string };
    readonly sep: string;
  } = {
    parse,
    sep,
  },
) => {
  const { root } = platform.parse(path);
  const segments = path
    .slice(root.length)
    .split(platform.sep === "/" ? "/" : /[\\/]/)
    .filter((segment) => segment !== "" && segment !== ".");
  return { root, segments };
};

/**
 * Where `path` really is: the path applied one segment at a time to a physical path, starting at
 * its root. A segment that is a symlink is read with `readLink` and its target expanded in place,
 * one hop at a time, so a `..` in the target climbs from where the path really is, as the OS
 * does (resolving the target as text would cancel `link/..` without following `link`). Once a
 * segment is missing, the rest is appended as text.
 *
 * Links are never followed with `realPath`, which can take several hops in one call. The hops
 * share one budget for the whole walk, nested targets included: when it runs out, the walk stops,
 * and the path is treated as missing at the link it stopped on.
 *
 * Only for a file system that does not change during the walk: a link retargeted between this
 * check and the write is not covered.
 */
const physicalPathOf = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, path: string) {
  const start = splitPath(path);
  let current = start.root;
  // The segments still to apply, last first.
  const pending = start.segments.reverse();
  let hops = 0;
  let exists = true;
  for (let segment = pending.pop(); segment !== undefined; segment = pending.pop()) {
    if (segment === "..") {
      // `current` is physical (or, once missing, text), so climbing it is what the OS does.
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    if (exists) {
      const info = yield* Effect.option(fs.lstat(next));
      if (Option.isSome(info) && info.value.type === "SymbolicLink" && hops < maxHops) {
        hops += 1;
        const target = yield* Effect.option(fs.readLink(next));
        if (Option.isSome(target)) {
          const targetPath = splitPath(target.value);
          if (isAbsolute(target.value)) {
            current = targetPath.root;
          }
          pending.push(...targetPath.segments.reverse());
          continue;
        }
      }
      // A file or directory keeps the path physical. Missing, unreadable, or a link past the
      // budget: the rest is text from here.
      exists = Option.isSome(info) && info.value.type !== "SymbolicLink";
    }
    current = next;
  }
  return { path: current, exists };
});

/**
 * Where a generated file lands, as keys for comparing outputs: two outputs collide when they share
 * any key.
 * - Always a path key: the physical path (see physicalPathOf: symlinks followed one hop at a time,
 *   a symlink to a missing file followed to where its target would be), in Unicode NFC and
 *   lowercased. Letter case and Unicode spelling then never tell two outputs apart, on any file
 *   system and whether or not the files exist yet.
 * - For an existing file, also its device and inode, which catches hard links.
 */
const destinationKeysOf = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, path: string) {
  const physical = yield* physicalPathOf(fs, path);
  const keys = [pathKey(physical.path)];
  if (physical.exists) {
    const info = yield* Effect.option(fs.stat(physical.path));
    if (Option.isSome(info) && Option.isSome(info.value.ino)) {
      keys.push(`inode:${info.value.dev}:${info.value.ino.value}`);
    }
  }
  return keys;
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
  const destinations = yield* Effect.forEach(planned, (output) =>
    destinationKeysOf(fs, output.path),
  );
  // The first output that shares a key with an earlier one.
  const seen = new Set<string>();
  let collision: (typeof planned)[number] | undefined;
  for (const [i, keys] of destinations.entries()) {
    if (keys.some((key) => seen.has(key))) {
      collision = planned[i];
      break;
    }
    for (const key of keys) {
      seen.add(key);
    }
  }
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
