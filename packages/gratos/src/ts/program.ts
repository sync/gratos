// TS5-shaped programs, checkers and config parsing on top of the TypeScript 7 API.
//
// TypeScript 7 opens programs only from a tsconfig. Programs built from a tsconfig that
// getParsedCommandLineOfConfigFile read open that real tsconfig, with fast loading unless the
// Grats config asks for TypeScript errors; with other roots or options, a virtual tsconfig
// beside it holds those roots and all of those options. Any other program (the fixture harness,
// API users) gets a virtual tsconfig with explicit `files` and the given compiler options,
// served by the session's readFile callback, and loads every file in full.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import type { Checker, Project, Symbol as Ts7Symbol, SymbolFlags } from "typescript/unstable/sync";
import type { Node, SourceFile } from "typescript/unstable/ast";

import { fromTs7Diagnostic, sortAndDeduplicateDiagnostics } from "./diagnostics.ts";
import type { Diagnostic, DiagnosticFile } from "./diagnostics.ts";
import { defaultSession, openProject, restartDefaultSession } from "./session.ts";
import type { Session } from "./session.ts";

export type CompilerOptions = Record<string, unknown>;

export interface CompilerHost {
  readonly options: CompilerOptions;
}

export interface ParsedCommandLine {
  readonly options: CompilerOptions;
  /** A mutable copy, as in TypeScript 5: changing it does not change the parsed config. */
  readonly fileNames: Array<string>;
  readonly errors: ReadonlyArray<Diagnostic>;
  readonly raw: unknown;
  /** Not in TypeScript 5's shape: the program opened for this config, which createProgram reuses. */
  readonly program: FacadeProgram;
}

/** A TS5-shaped symbol: `declarations` are resolved nodes, not TypeScript 7 NodeHandles. */
export interface FacadeSymbol {
  readonly name: string;
  readonly escapedName: string;
  readonly flags: SymbolFlags;
  readonly declarations: ReadonlyArray<Node> | undefined;
  readonly valueDeclaration: Node | undefined;
}

export interface FacadeChecker {
  getSymbolAtLocation(node: Node): FacadeSymbol | undefined;
  getAliasedSymbol(symbol: FacadeSymbol): FacadeSymbol;
  /** TypeScript 7 symbols are already merged. */
  getMergedSymbol(symbol: FacadeSymbol): FacadeSymbol;
}

export interface FacadeProgram {
  readonly project: Project;
  readonly session: Session;
  getSourceFiles(): ReadonlyArray<SourceFile>;
  getSourceFile(fileName: string): SourceFile | undefined;
  getTypeChecker(): FacadeChecker;
  getCompilerOptions(): CompilerOptions;
  getSyntacticDiagnostics(sourceFile?: SourceFile): ReadonlyArray<Diagnostic>;
  getSemanticDiagnostics(sourceFile?: SourceFile): ReadonlyArray<Diagnostic>;
  getGlobalDiagnostics(): ReadonlyArray<Diagnostic>;
  getOptionsDiagnostics(): ReadonlyArray<Diagnostic>;
  getConfigFileParsingDiagnostics(): ReadonlyArray<Diagnostic>;
  getDeclarationDiagnostics(sourceFile?: SourceFile): ReadonlyArray<Diagnostic>;
}

// ---- Symbols and the checker ----

class SymbolView implements FacadeSymbol {
  readonly inner: Ts7Symbol;
  readonly #project: Project;
  #declarations: ReadonlyArray<Node> | undefined;

  constructor(inner: Ts7Symbol, project: Project) {
    this.inner = inner;
    this.#project = project;
  }
  get name(): string {
    return this.inner.name;
  }
  get escapedName(): string {
    return this.inner.escapedName;
  }
  get flags(): SymbolFlags {
    return this.inner.flags;
  }
  get declarations(): ReadonlyArray<Node> | undefined {
    this.#declarations ??= this.inner.declarations.flatMap((handle) => {
      const node = handle.resolve(this.#project);
      return node === undefined ? [] : [node];
    });
    return this.#declarations;
  }
  get valueDeclaration(): Node | undefined {
    return this.inner.valueDeclaration?.resolve(this.#project);
  }
}

const makeChecker = (project: Project): FacadeChecker => {
  const checker: Checker = project.checker;
  // Symbols are identity-stable per snapshot in TypeScript 7; keep their views stable too, since
  // the engine tracks visited symbols in a Set.
  const views = new Map<Ts7Symbol, SymbolView>();
  const inners = new WeakMap<FacadeSymbol, Ts7Symbol>();
  const view = (symbol: Ts7Symbol): SymbolView => {
    let existing = views.get(symbol);
    if (existing === undefined) {
      existing = new SymbolView(symbol, project);
      views.set(symbol, existing);
      inners.set(existing, symbol);
    }
    return existing;
  };
  const innerOf = (symbol: FacadeSymbol): Ts7Symbol => {
    const inner = inners.get(symbol);
    if (inner === undefined) {
      throw new TypeError("Gratos: expected a symbol from this program's checker");
    }
    return inner;
  };
  return {
    getSymbolAtLocation: (node) => {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol === undefined ? undefined : view(symbol);
    },
    getAliasedSymbol: (symbol) => view(checker.getAliasedSymbol(innerOf(symbol))),
    getMergedSymbol: (symbol) => symbol,
  };
};

// ---- Programs ----

const makeProgram = (session: Session, project: Project): FacadeProgram => {
  const program = project.program;
  const sourceFiles = new Map<string, SourceFile | undefined>();
  const sourceFileOf = (fileName: string): SourceFile | undefined => {
    if (!sourceFiles.has(fileName)) {
      sourceFiles.set(fileName, program.getSourceFile(fileName));
    }
    return sourceFiles.get(fileName);
  };
  // A diagnostic can point into a file that is not a program source file, such as the tsconfig
  // for an invalid compiler option. It gets a diagnostic file backed by that file's text, so it
  // keeps its file name, line and underline.
  const textFiles = new Map<string, DiagnosticFile | undefined>();
  const diagnosticFileOf = (fileName: string): DiagnosticFile | undefined => {
    const sourceFile = sourceFileOf(fileName);
    if (sourceFile !== undefined) {
      return sourceFile;
    }
    if (!textFiles.has(fileName)) {
      const text = session.virtualFiles.get(fileName) ?? sys.readFile(fileName);
      textFiles.set(fileName, text === undefined ? undefined : { fileName, text: stripBom(text) });
    }
    return textFiles.get(fileName);
  };
  const convert = (diagnostics: ReadonlyArray<Parameters<typeof fromTs7Diagnostic>[0]>) =>
    diagnostics.map((diagnostic) => fromTs7Diagnostic(diagnostic, diagnosticFileOf));
  let checker: FacadeChecker | undefined;
  return {
    project,
    session,
    // Lib files and blanked third-party files cannot hold Grats tags, so their ASTs are never
    // fetched. Everything else is returned in program order, as TypeScript 5 does.
    getSourceFiles: () =>
      program.getSourceFileNames().flatMap((fileName) => {
        if (
          session.blanked.has(fileName) ||
          program.getSourceFileMetadata(fileName)?.isDefaultLibrary
        ) {
          return [];
        }
        const sourceFile = sourceFileOf(fileName);
        return sourceFile === undefined ? [] : [sourceFile];
      }),
    getSourceFile: sourceFileOf,
    getTypeChecker: () => {
      checker ??= makeChecker(project);
      return checker;
    },
    getCompilerOptions: () => Object.fromEntries(Object.entries(project.compilerOptions)),
    getSyntacticDiagnostics: (sourceFile) =>
      convert(program.getSyntacticDiagnostics(sourceFile?.fileName)),
    getSemanticDiagnostics: (sourceFile) =>
      convert(program.getSemanticDiagnostics(sourceFile?.fileName)),
    getGlobalDiagnostics: () => convert(program.getGlobalDiagnostics()),
    getOptionsDiagnostics: () => convert(program.getProgramDiagnostics()),
    getConfigFileParsingDiagnostics: () => convert(program.getConfigFileParsingDiagnostics()),
    getDeclarationDiagnostics: (sourceFile) =>
      convert(program.getDeclarationDiagnostics(sourceFile?.fileName)),
  };
};

/** TypeScript 5's getPreEmitDiagnostics, on the facade program. */
export const getPreEmitDiagnostics = (
  program: FacadeProgram,
  sourceFile?: SourceFile,
): Array<Diagnostic> => {
  const options = program.getCompilerOptions();
  return sortAndDeduplicateDiagnostics([
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getGlobalDiagnostics(),
    ...program.getSemanticDiagnostics(sourceFile),
    ...(options["declaration"] === true || options["composite"] === true
      ? program.getDeclarationDiagnostics(sourceFile)
      : []),
  ]);
};

/** A config read by getParsedCommandLineOfConfigFile, and the program last opened for it. */
interface ParsedConfig {
  readonly configPath: string;
  /**
   * The session to build its programs on: the default session of its blanking mode (a later
   * parse may replace that with a new one), or the caller's own (parseConfigFileOnSession).
   */
  readonly session: () => Session;
  /**
   * The root file names as returned, frozen and separate from the returned array, to tell
   * whether a caller changed the roots since (even by mutating that array).
   */
  readonly fileNames: ReadonlyArray<string>;
  /** The options as returned, to tell whether a caller changed them since. */
  readonly optionsJson: string;
  program: FacadeProgram;
}

/** Configs read by getParsedCommandLineOfConfigFile, keyed by the options object it returned. */
const parsedConfigs = new WeakMap<CompilerOptions, ParsedConfig>();

export const createCompilerHost = (
  options: CompilerOptions,
  _setParentNodes?: boolean,
): CompilerHost => ({
  options,
});

// TypeScript 5 passes enum-valued options as numbers (its own enum values); a tsconfig needs
// their names.
const ENUM_OPTIONS: ReadonlyMap<string, ReadonlyMap<number, string>> = new Map([
  [
    "target",
    new Map([
      [0, "es3"],
      [1, "es5"],
      [2, "es2015"],
      [3, "es2016"],
      [4, "es2017"],
      [5, "es2018"],
      [6, "es2019"],
      [7, "es2020"],
      [8, "es2021"],
      [9, "es2022"],
      [10, "es2023"],
      [11, "es2024"],
      [99, "esnext"],
    ]),
  ],
  [
    "module",
    new Map([
      [0, "none"],
      [1, "commonjs"],
      [2, "amd"],
      [3, "umd"],
      [4, "system"],
      [5, "es2015"],
      [6, "es2020"],
      [7, "es2022"],
      [99, "esnext"],
      [100, "node16"],
      [101, "node18"],
      [102, "node20"],
      [199, "nodenext"],
      [200, "preserve"],
    ]),
  ],
  [
    "moduleResolution",
    new Map([
      [1, "classic"],
      [2, "node10"],
      [3, "node16"],
      [99, "nodenext"],
      [100, "bundler"],
    ]),
  ],
  [
    "jsx",
    new Map([
      [1, "preserve"],
      [2, "react"],
      [3, "react-native"],
      [4, "react-jsx"],
      [5, "react-jsxdev"],
    ]),
  ],
  [
    "moduleDetection",
    new Map([
      [1, "legacy"],
      [2, "auto"],
      [3, "force"],
    ]),
  ],
  [
    "newLine",
    new Map([
      [0, "crlf"],
      [1, "lf"],
    ]),
  ],
]);
/** Options that only describe where a config came from. */
const DROPPED_OPTIONS: ReadonlySet<string> = new Set(["configFilePath", "pathsBasePath"]);

/**
 * Path options that TypeScript 5's createProgram resolves against the current directory. A virtual
 * tsconfig may sit beside another config, so a relative one is made absolute before it is written.
 */
const CWD_RELATIVE_PATH_OPTIONS: ReadonlySet<string> = new Set(["outDir", "rootDir"]);

/**
 * `paths` with relative substitutions made absolute. TypeScript resolves them against `baseUrl`,
 * or else `pathsBasePath`, the directory of the tsconfig that set `paths`. A virtual tsconfig
 * lives in the current directory, so a relative substitution written into it as is would move
 * there.
 */
/** TypeScript's own test for a relative path: ".", "..", or either followed by / or \. */
const isRelative = (substitution: string): boolean => /^\.\.?(?:$|[\\/])/.test(substitution);

const absolutePaths = (paths: unknown, options: CompilerOptions): unknown => {
  const baseUrl = options["baseUrl"];
  const base = baseUrl ?? options["pathsBasePath"];
  if (typeof base !== "string" || paths === null || typeof paths !== "object") {
    return paths;
  }
  // Without baseUrl, TypeScript rejects a bare substitution (TS5090); keep it bare so it still does.
  const isRebased = (substitution: string): boolean =>
    !isAbsolute(substitution) && (baseUrl !== undefined || isRelative(substitution));
  // Prefix the base without normalizing: `*` must stay in place until TypeScript expands it,
  // so `./src/*/../shared` cannot collapse to `./src/shared`.
  const rebase = (substitution: string): string =>
    base.endsWith("/") || base.endsWith(sep) ? `${base}${substitution}` : `${base}/${substitution}`;
  return Object.fromEntries(
    Object.entries(paths).map(([pattern, substitutions]: [string, unknown]) => [
      pattern,
      Array.isArray(substitutions)
        ? substitutions.map((substitution: unknown) =>
            typeof substitution === "string" && isRebased(substitution)
              ? rebase(substitution)
              : substitution,
          )
        : substitutions,
    ]),
  );
};

/** `options` as a tsconfig's compilerOptions, relative `paths` made absolute. */
const toTsconfigOptions = (options: CompilerOptions): CompilerOptions =>
  Object.fromEntries(
    Object.entries(options).flatMap(([key, value]): Array<[string, unknown]> => {
      if (DROPPED_OPTIONS.has(key) || value === undefined) {
        return [];
      }
      if (key === "paths") {
        return [[key, absolutePaths(value, options)]];
      }
      if (CWD_RELATIVE_PATH_OPTIONS.has(key) && typeof value === "string") {
        return [[key, resolve(value)]];
      }
      const names = ENUM_OPTIONS.get(key);
      if (names !== undefined && typeof value === "number") {
        const name = names.get(value);
        return name === undefined ? [] : [[key, name]];
      }
      return [[key, value]];
    }),
  );

let virtualConfigCount = 0;

/** Opens a virtual tsconfig with these contents on `session`. */
/**
 * Opens a program from a virtual tsconfig placed in `directory`. TypeScript derives defaults such
 * as the `node_modules/@types` lookup from the config's directory, so a config built from a parsed
 * tsconfig must sit beside it.
 */
const openVirtualProgram = (
  session: Session,
  tsconfig: unknown,
  directory: string = process.cwd(),
): FacadeProgram => {
  virtualConfigCount += 1;
  const configPath = join(
    directory,
    `__gratos_virtual_${process.pid}_${virtualConfigCount}__.tsconfig.json`,
  );
  session.virtualFiles.set(configPath, JSON.stringify(tsconfig));
  return makeProgram(session, openProject(session, configPath));
};

const sameFileNames = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((fileName, i) => resolve(fileName) === resolve(b[i] ?? ""));

/**
 * The program for a config read by getParsedCommandLineOfConfigFile. Its own program is reused
 * only while it is still the session's open project and the caller kept its roots and options.
 * Otherwise a virtual tsconfig beside the config builds exactly the caller's roots with all of
 * the caller's options, as TypeScript 5's createProgram would: the config may have changed on
 * disk since it was parsed (a later parse restarts the session), so nothing is read from it.
 */
const programForParsedConfig = (
  parsed: ParsedConfig,
  rootNames: ReadonlyArray<string>,
  options: CompilerOptions,
): FacadeProgram => {
  const session = parsed.session();
  const reusable =
    JSON.stringify(options) === parsed.optionsJson && sameFileNames(rootNames, parsed.fileNames);
  if (reusable && session.current?.project === parsed.program.project) {
    return parsed.program;
  }
  const program = openVirtualProgram(
    session,
    {
      compilerOptions: toTsconfigOptions(options),
      files: rootNames.map((fileName) => resolve(fileName)),
      include: [],
    },
    dirname(parsed.configPath),
  );
  if (reusable) {
    parsed.program = program;
  }
  return program;
};

/** TypeScript 5's createProgram(rootNames, options, host). */
export const createProgram = (
  rootNames: ReadonlyArray<string>,
  options: CompilerOptions,
  _host?: CompilerHost,
): FacadeProgram => {
  const parsed = parsedConfigs.get(options);
  if (parsed !== undefined) {
    return programForParsedConfig(parsed, rootNames, options);
  }
  return openVirtualProgram(defaultSession(false), {
    compilerOptions: toTsconfigOptions(options),
    files: rootNames.map((fileName) => resolve(fileName)),
  });
};

/** The project of the most recent program on any session, for the printer. */
export const anyOpenProject = (sessions: ReadonlyArray<Session>): Project | undefined =>
  sessions.find((session) => session.current !== null)?.current?.project;

// ---- Config files ----

/** Drops a leading UTF-8 byte order mark, as TypeScript does when it reads a file. */
const stripBom = (text: string): string => (text.startsWith("\uFEFF") ? text.slice(1) : text);

/**
 * A file's text decoded by its byte order mark, without the mark, as TypeScript 5's sys.readFile
 * reads it: UTF-16 big or little endian, or else UTF-8. The Effect shell decodes the tsconfig
 * bytes it reads through FileSystem with it too.
 */
export const decodeFileText = (data: Uint8Array): string => {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Swap a copy's bytes, dropping an odd trailing byte as TypeScript 5 does.
    const swapped = Buffer.from(bytes.subarray(0, bytes.length & ~1));
    return swapped.swap16().toString("utf16le", 2);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.toString("utf16le", 2);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.toString("utf8", 3);
  }
  return bytes.toString("utf8");
};

export const sys = {
  newLine: "\n",
  fileExists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string | undefined => {
    try {
      return decodeFileText(readFileSync(path));
    } catch {
      return undefined;
    }
  },
  getCurrentDirectory: (): string => process.cwd(),
};

/** TypeScript 5's findConfigFile: the nearest `configName` in `searchPath` or an ancestor. */
export const findConfigFile = (
  searchPath: string,
  fileExists: (fileName: string) => boolean,
  configName = "tsconfig.json",
): string | undefined => {
  let directory = resolve(searchPath);
  while (true) {
    const fileName = join(directory, configName);
    if (fileExists(fileName)) {
      return fileName;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};

/**
 * The root tsconfig's JSON, read with comments and trailing commas allowed, or `undefined` when
 * it is not valid JSON with comments. Only this file is read: its top-level `grats` key is the
 * Grats config, with no `extends` merging (TypeScript 5's `raw` behaved the same way).
 */
const parseRawConfig = (configFile: string): { readonly raw: unknown } | undefined => {
  const errors: Array<ParseError> = [];
  const text = decodeFileText(readFileSync(configFile));
  const raw: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length > 0 ? undefined : { raw };
};

const unparsableConfig = (configFile: string): Error =>
  new Error(`Gratos: could not parse ${configFile} as JSON with comments`);

/** The root tsconfig's JSON, as parseRawConfig reads it; throws when it is not valid. */
export const readRawConfig = (configFile: string): unknown => {
  const parsed = parseRawConfig(configFile);
  if (parsed === undefined) {
    throw unparsableConfig(configFile);
  }
  return parsed.raw;
};

const reportsTypeScriptErrors = (raw: unknown): boolean => {
  if (raw === null || typeof raw !== "object") {
    return false;
  }
  const grats: unknown = Reflect.get(raw, "grats");
  return (
    grats !== null &&
    typeof grats === "object" &&
    Reflect.get(grats, "reportTypeScriptTypeErrors") === true
  );
};

/**
 * Opens the project for `configPath` on `session` and returns its parsed command line. Programs
 * that createProgram later builds from the returned options use `sessionOf()`.
 */
const parseConfigOn = (
  configPath: string,
  rawConfig: { readonly raw: unknown } | undefined,
  session: Session,
  sessionOf: () => Session,
): ParsedCommandLine => {
  const program = makeProgram(session, openProject(session, configPath));
  const errors = program.getConfigFileParsingDiagnostics();
  if (rawConfig === undefined && errors.length === 0) {
    throw unparsableConfig(configPath);
  }
  const options = {
    ...Object.fromEntries(Object.entries(program.project.compilerOptions)),
    configFilePath: configPath,
  };
  const fileNames = program.project.rootFiles;
  parsedConfigs.set(options, {
    configPath,
    session: sessionOf,
    fileNames: Object.freeze([...fileNames]),
    optionsJson: JSON.stringify(options),
    program,
  });
  return {
    options,
    fileNames: [...fileNames],
    errors,
    raw: rawConfig?.raw,
    program,
  };
};

/** The caller's session for getParsedCommandLineOfConfigFile, inside withParseSession. */
let parseSession: Session | null = null;

/**
 * Runs synchronous `f` with getParsedCommandLineOfConfigFile opening projects on `session`
 * instead of a restarted default session. The project, and every program createProgram later
 * builds from the returned options, live on `session`, whose blanking mode the caller chose.
 * The Effect shell scopes one session to each generate() or check() call, so closing it never
 * touches another session.
 */
export const withParseSession = <A>(session: Session, f: () => A): A => {
  const previous = parseSession;
  parseSession = session;
  try {
    return f();
  } finally {
    parseSession = previous;
  }
};

/**
 * TypeScript 5's getParsedCommandLineOfConfigFile. It opens the project right away: TypeScript
 * 7 reports config errors only on a project. A later createProgram with the returned options
 * and file names reuses that project while it is open (see programForParsedConfig).
 *
 * Every call opens the project on a new tsgo session, as TypeScript 5 reads the config, its
 * root files and their sources again on every call. Reusing a session would keep the config's
 * options, its root files and the third-party files blanked as they were when it was first
 * read. The CLI parses once, so it starts one session either way. Inside withParseSession, the
 * caller's (new) session is used instead.
 */
export const getParsedCommandLineOfConfigFile = (
  configFile: string,
  _optionsToExtend?: unknown,
  _host?: unknown,
): ParsedCommandLine => {
  const configPath = resolve(configFile);
  // A tsconfig with syntax errors is left to TypeScript, which reports them with their place as
  // config diagnostics. Its partial `grats` key is never read.
  const rawConfig = parseRawConfig(configPath);
  const session = parseSession;
  if (session !== null) {
    return parseConfigOn(configPath, rawConfig, session, () => session);
  }
  const blankThirdParty = !reportsTypeScriptErrors(rawConfig?.raw);
  return parseConfigOn(configPath, rawConfig, restartDefaultSession(blankThirdParty), () =>
    defaultSession(blankThirdParty),
  );
};
