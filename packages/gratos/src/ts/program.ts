// TS5-shaped programs, checkers and config parsing on top of the TypeScript 7 API.
//
// TypeScript 7 opens programs only from a tsconfig. Programs built from a tsconfig that
// getParsedCommandLineOfConfigFile read open that real tsconfig, with fast loading unless the
// Grats config asks for TypeScript errors; with other roots or options, a virtual tsconfig
// extends it. Any other program (the fixture harness, API users) gets a virtual tsconfig with
// explicit `files` and the given compiler options, served by the session's readFile callback,
// and loads every file in full.
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
  /** The blanking mode of its session. A later parse may replace that session with a new one. */
  readonly blankThirdParty: boolean;
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
/** Options that only describe where a config came from, or only matter for emit. */
const DROPPED_OPTIONS: ReadonlySet<string> = new Set([
  "configFilePath",
  "outDir",
  "pathsBasePath",
  "rootDir",
]);

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

/**
 * `options` as a tsconfig's compilerOptions. `context` is the full set of options they belong
 * to, which gives relative `paths` their base.
 */
const toTsconfigOptions = (
  options: CompilerOptions,
  context: CompilerOptions = options,
): CompilerOptions =>
  Object.fromEntries(
    Object.entries(options).flatMap(([key, value]): Array<[string, unknown]> => {
      if (DROPPED_OPTIONS.has(key) || value === undefined) {
        return [];
      }
      if (key === "paths") {
        return [[key, absolutePaths(value, context)]];
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
 * After another project was opened, or another config parsed, the config is reopened. With
 * other roots or options, a virtual tsconfig extends it with exactly those roots and the changed
 * options.
 */
const programForParsedConfig = (
  parsed: ParsedConfig,
  rootNames: ReadonlyArray<string>,
  options: CompilerOptions,
): FacadeProgram => {
  const { configPath } = parsed;
  const session = defaultSession(parsed.blankThirdParty);
  const sameOptions = JSON.stringify(options) === parsed.optionsJson;
  if (sameOptions && sameFileNames(rootNames, parsed.fileNames)) {
    if (session.current?.project !== parsed.program.project) {
      // The config may have changed on disk since it was parsed (a later parse restarts the
      // session), so build exactly what the caller passed, as TypeScript 5 would.
      parsed.program = openVirtualProgram(
        session,
        {
          compilerOptions: toTsconfigOptions(options),
          files: rootNames.map((fileName) => resolve(fileName)),
          include: [],
        },
        dirname(configPath),
      );
    }
    return parsed.program;
  }
  const original: CompilerOptions = JSON.parse(parsed.optionsJson);
  const changed = Object.fromEntries(
    Object.keys({ ...original, ...options }).flatMap((key): Array<[string, unknown]> => {
      if (JSON.stringify(options[key]) === JSON.stringify(original[key])) {
        return [];
      }
      // A removed option is reset to its default with null, as in an extending tsconfig.
      return [[key, options[key] ?? null]];
    }),
  );
  return openVirtualProgram(
    session,
    {
      extends: configPath,
      compilerOptions: toTsconfigOptions(changed, options),
      files: rootNames.map((fileName) => resolve(fileName)),
      include: [],
    },
    dirname(configPath),
  );
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

export const sys = {
  newLine: "\n",
  fileExists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
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
 * The root tsconfig's JSON, read with comments and trailing commas allowed. Only this file is
 * read: its top-level `grats` key is the Grats config, with no `extends` merging (TypeScript 5's
 * `raw` behaved the same way).
 */
export const readRawConfig = (configFile: string): unknown => {
  const errors: Array<ParseError> = [];
  const text = stripBom(readFileSync(configFile, "utf8"));
  const raw: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Gratos: could not parse ${configFile} as JSON with comments`);
  }
  return raw;
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
 * TypeScript 5's getParsedCommandLineOfConfigFile. It opens the project right away: TypeScript
 * 7 reports config errors only on a project. A later createProgram with the returned options
 * and file names reuses that project while it is open (see programForParsedConfig).
 *
 * Every call opens the project on a new tsgo session, as TypeScript 5 reads the config, its
 * root files and their sources again on every call. Reusing a session would keep the config's
 * options, its root files and the third-party files blanked as they were when it was first
 * read. The CLI parses once, so it starts one session either way.
 */
export const getParsedCommandLineOfConfigFile = (
  configFile: string,
  _optionsToExtend?: unknown,
  _host?: unknown,
): ParsedCommandLine => {
  const configPath = resolve(configFile);
  const raw = readRawConfig(configPath);
  const blankThirdParty = !reportsTypeScriptErrors(raw);
  const session = restartDefaultSession(blankThirdParty);
  const program = makeProgram(session, openProject(session, configPath));
  const options = {
    ...Object.fromEntries(Object.entries(program.project.compilerOptions)),
    configFilePath: configPath,
  };
  const fileNames = program.project.rootFiles;
  parsedConfigs.set(options, {
    configPath,
    blankThirdParty,
    fileNames: Object.freeze([...fileNames]),
    optionsJson: JSON.stringify(options),
    program,
  });
  return {
    options,
    fileNames: [...fileNames],
    errors: program.getConfigFileParsingDiagnostics(),
    raw,
    program,
  };
};
