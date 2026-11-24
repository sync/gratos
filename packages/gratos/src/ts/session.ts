// The TypeScript 7 API process (tsgo) and the virtual file system it reads through.
//
// A session owns one `API` child process, acquired and released as an Effect resource. Its
// `fs.readFile` callback serves virtual tsconfigs and implements fast loading (spec §5): code
// files whose realpath is under `node_modules` are served as `export {};`, except TypeScript's
// own bundled lib files. `package.json` and other non-code files are always read in full, and so
// are workspace packages, whose realpath is outside `node_modules`.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

import { Effect, Exit, Scope } from "effect";
import { API } from "typescript/unstable/sync";
import type { Project, Snapshot } from "typescript/unstable/sync";

/** The code files that fast loading may blank; `.json` and everything else is never blanked. */
export const BLANKABLE_FILE = /\.(d\.)?[cm]?[tj]sx?$/;
export const BLANK_SOURCE = "export {};";

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The directory holding the lib.*.d.ts files bundled with the platform tsgo binary. */
export const bundledLibDirectory: string = (() => {
  const typescriptRequire = createRequire(import.meta.resolve("typescript/package.json"));
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
  return realpathOrSelf(join(dirname(typescriptRequire.resolve(platformPackage)), "lib"));
})();

const isUnderNodeModules = (realpath: string): boolean =>
  realpath.split(sep).includes("node_modules");

export interface SessionOptions {
  /** Blank third-party code files (fast loading). Off when TypeScript errors are reported. */
  readonly blankThirdParty: boolean;
}

export interface Session {
  readonly api: API;
  readonly blankThirdParty: boolean;
  /** Virtual files (tsconfigs) served by the readFile callback, keyed by absolute path. */
  readonly virtualFiles: Map<string, string>;
  /** Every real file name tsgo asked for. */
  readonly filesRead: Set<string>;
  /** File names and realpaths served as `export {};`. */
  readonly blanked: Set<string>;
  /** The snapshot holding the most recently opened project, if any. */
  current: {
    readonly snapshot: Snapshot;
    readonly project: Project;
    readonly config: string;
  } | null;
}

/**
 * The readFile policy, exported for tests: the source to serve for `fileName`, or `undefined` to
 * let tsgo read the real file.
 */
export const readFileOverride = (
  session: Pick<Session, "blankThirdParty" | "virtualFiles" | "filesRead" | "blanked">,
  fileName: string,
): string | undefined => {
  const virtual = session.virtualFiles.get(fileName);
  if (virtual !== undefined) {
    return virtual;
  }
  session.filesRead.add(fileName);
  if (!session.blankThirdParty || !BLANKABLE_FILE.test(fileName)) {
    return undefined;
  }
  const realpath = realpathOrSelf(fileName);
  if (realpath.startsWith(bundledLibDirectory + sep) || !isUnderNodeModules(realpath)) {
    return undefined;
  }
  session.blanked.add(fileName);
  session.blanked.add(realpath);
  return BLANK_SOURCE;
};

const openSession = (options: SessionOptions): Session => {
  const state = {
    blankThirdParty: options.blankThirdParty,
    virtualFiles: new Map<string, string>(),
    filesRead: new Set<string>(),
    blanked: new Set<string>(),
  };
  const api = new API({
    cwd: process.cwd(),
    fs: { readFile: (fileName) => readFileOverride(state, fileName) },
  });
  return { ...state, api, current: null };
};

const closeSession = (session: Session): void => {
  session.current?.snapshot.dispose();
  session.current = null;
  session.api.close();
};

/** A TypeScript 7 API session as a scoped resource: the tsgo process lives as long as the scope. */
export const acquireSession = (
  options: SessionOptions,
): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => openSession(options)),
    (session) => Effect.sync(() => closeSession(session)),
  );

// The synchronous, TS5-shaped facade needs sessions without an Effect context. They live in one
// process-wide scope, closed by closeDefaultSessions(). A process that exits without closing it
// leaves nothing behind: the TypeScript API kills its child processes on exit (closing them from
// another exit handler races that and makes tsgo print "context canceled").
let processScope = Effect.runSync(Scope.make());
const defaultSessions = new Map<boolean, Session>();

/** Closes every default session (their tsgo processes). Later calls start new ones. */
export const closeDefaultSessions = (): void => {
  const scope = processScope;
  processScope = Effect.runSync(Scope.make());
  defaultSessions.clear();
  Effect.runSync(Scope.close(scope, Exit.void));
};

/** The process-wide session for a blanking mode, started on first use. */
export const defaultSession = (blankThirdParty: boolean): Session => {
  const existing = defaultSessions.get(blankThirdParty);
  if (existing !== undefined) {
    return existing;
  }
  const session = Effect.runSync(Scope.provide(processScope)(acquireSession({ blankThirdParty })));
  defaultSessions.set(blankThirdParty, session);
  return session;
};

/** Every default session started so far. */
export const defaultSessionList = (): ReadonlyArray<Session> => [...defaultSessions.values()];

/**
 * Opens `configPath` (a real or virtual tsconfig) in a new snapshot, releasing the session's
 * previous project. The returned project stays usable until the next open on this session.
 */
export const openProject = (session: Session, configPath: string): Project => {
  const previous = session.current;
  const closeProjects =
    previous !== null && previous.config !== configPath ? [previous.config] : [];
  const snapshot = session.api.updateSnapshot({ openProjects: [configPath], closeProjects });
  previous?.snapshot.dispose();
  if (previous !== null && previous.config !== configPath) {
    session.virtualFiles.delete(previous.config);
  }
  const project =
    snapshot.getProject(configPath) ??
    snapshot.getProjects().find((candidate) => candidate.configFileName === configPath);
  if (project === undefined) {
    snapshot.dispose();
    session.current = null;
    throw new Error(`Gratos: TypeScript did not open a project for ${configPath}`);
  }
  session.current = { snapshot, project, config: configPath };
  return project;
};
