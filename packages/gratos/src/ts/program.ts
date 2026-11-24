// TS5-shaped programs, checkers and config parsing on top of the TypeScript 7 API.
//
// TypeScript 7 opens programs only from a tsconfig. Programs built from a tsconfig that
// getParsedCommandLineOfConfigFile read open that real tsconfig, with fast loading unless the
// Grats config asks for TypeScript errors. Any other program (the fixture harness, API users)
// gets a virtual tsconfig with explicit `files` and the given compiler options, served by the
// session's readFile callback, and loads every file in full.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import type { Checker, Project, Symbol as Ts7Symbol, SymbolFlags } from "typescript/unstable/sync";
import type { Node, SourceFile } from "typescript/unstable/ast";

import { fromTs7Diagnostic, sortAndDeduplicateDiagnostics } from "./diagnostics.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { defaultSession, openProject } from "./session.ts";
import type { Session } from "./session.ts";

export type CompilerOptions = Record<string, unknown>;

export interface CompilerHost {
  readonly options: CompilerOptions;
}

export interface ParsedCommandLine {
  readonly options: CompilerOptions;
  readonly fileNames: ReadonlyArray<string>;
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
  const convert = (diagnostics: ReadonlyArray<Parameters<typeof fromTs7Diagnostic>[0]>) =>
    diagnostics.map((diagnostic) => fromTs7Diagnostic(diagnostic, sourceFileOf));
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

/** Configs read by getParsedCommandLineOfConfigFile, keyed by the options object it returned. */
const parsedConfigs = new WeakMap<CompilerOptions, { readonly program: FacadeProgram }>();

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
const DROPPED_OPTIONS: ReadonlySet<string> = new Set(["configFilePath", "outDir", "rootDir"]);

const toTsconfigOptions = (options: CompilerOptions): CompilerOptions =>
  Object.fromEntries(
    Object.entries(options).flatMap(([key, value]): Array<[string, unknown]> => {
      if (DROPPED_OPTIONS.has(key) || value === undefined) {
        return [];
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

/** TypeScript 5's createProgram(rootNames, options, host). */
export const createProgram = (
  rootNames: ReadonlyArray<string>,
  options: CompilerOptions,
  _host?: CompilerHost,
): FacadeProgram => {
  const parsed = parsedConfigs.get(options);
  if (parsed !== undefined) {
    return parsed.program;
  }
  const session = defaultSession(false);
  virtualConfigCount += 1;
  const configPath = join(
    process.cwd(),
    `__gratos_virtual_${process.pid}_${virtualConfigCount}__.tsconfig.json`,
  );
  session.virtualFiles.set(
    configPath,
    JSON.stringify({
      compilerOptions: toTsconfigOptions(options),
      files: rootNames.map((fileName) => resolve(fileName)),
    }),
  );
  return makeProgram(session, openProject(session, configPath));
};

/** The project of the most recent program on any session, for the printer. */
export const anyOpenProject = (sessions: ReadonlyArray<Session>): Project | undefined =>
  sessions.find((session) => session.current !== null)?.current?.project;

// ---- Config files ----

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
  const text = readFileSync(configFile, "utf8");
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
 * reuses that project.
 */
export const getParsedCommandLineOfConfigFile = (
  configFile: string,
  _optionsToExtend?: unknown,
  _host?: unknown,
): ParsedCommandLine => {
  const configPath = resolve(configFile);
  const raw = readRawConfig(configPath);
  const session = defaultSession(!reportsTypeScriptErrors(raw));
  const program = makeProgram(session, openProject(session, configPath));
  const options = {
    ...Object.fromEntries(Object.entries(program.project.compilerOptions)),
    configFilePath: configPath,
  };
  parsedConfigs.set(options, { program });
  return {
    options,
    fileNames: program.project.rootFiles,
    errors: program.getConfigFileParsingDiagnostics(),
    raw,
    program,
  };
};
