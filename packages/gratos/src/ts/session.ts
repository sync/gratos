// The TypeScript 7 API process (tsgo) and the virtual file system it reads through.
//
// A session owns one `API` child process, acquired and released as an Effect resource. Its
// `fs.readFile` callback serves virtual tsconfigs and implements fast loading (spec §5): code
// files whose realpath is under `node_modules` are served as `export {};`, except TypeScript's
// own bundled lib files and this package's own public declarations (an installed
// @dblechoc/gratos sits under `node_modules`, and its models import `ID`, `Int`, `Float` and
// `GqlInfo` from them). `package.json` and other non-code files are always read in full, and so
// are workspace packages, whose realpath is outside `node_modules`.
import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

import { Effect, Exit, Predicate, Scope } from "effect";
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

/**
 * The public declaration files of an installed @dblechoc/gratos, which fast loading serves in
 * full: the `.` and `./dev` entries' types, and the Types module that `.` re-exports. The release
 * build (tsconfig.build-dts.json) emits exactly these, beside the JavaScript, so they are found
 * from where this module really is: `dist/ts/session.js` in the package, `src/ts/session.ts` in
 * the workspace, where they do not exist and nothing under `node_modules` matches.
 */
export const ownPublicDeclarations: ReadonlySet<string> = (() => {
  const outDir = dirname(dirname(realpathOrSelf(import.meta.filename)));
  return new Set(
    ["index.d.ts", "devApi.d.ts", join("upstream", "Types.d.ts")].map((file) => join(outDir, file)),
  );
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
  /** File names and realpaths served as `export {};`, as they were last read. */
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
 * let tsgo read the real file. `servedInFull` (realpaths) is this package's own public
 * declarations, or a stand-in for them in a test.
 */
export const readFileOverride = (
  session: Pick<Session, "blankThirdParty" | "virtualFiles" | "filesRead" | "blanked">,
  fileName: string,
  servedInFull: ReadonlySet<string> = ownPublicDeclarations,
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
  if (
    realpath.startsWith(bundledLibDirectory + sep) ||
    servedInFull.has(realpath) ||
    !isUnderNodeModules(realpath)
  ) {
    // An earlier snapshot of this session may have blanked it (a symlink into node_modules since
    // retargeted); it is served in full now.
    session.blanked.delete(fileName);
    session.blanked.delete(realpath);
    return undefined;
  }
  session.blanked.add(fileName);
  session.blanked.add(realpath);
  return BLANK_SOURCE;
};

/** Every session not yet closed, in the order they were opened: default and scoped ones. */
const liveSessions = new Set<Session>();

/** Every session not yet closed, oldest first, for the printer, which needs any open project. */
export const openSessionList = (): ReadonlyArray<Session> => [...liveSessions];

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
  const session: Session = { ...state, api, current: null };
  liveSessions.add(session);
  return session;
};

/** A Node child process, recognized by the methods this module and its tests call on it. */
const isChildProcess = (value: unknown): value is ChildProcess =>
  Predicate.hasProperty(value, "kill") &&
  Predicate.isFunction(value.kill) &&
  Predicate.hasProperty(value, "once") &&
  Predicate.isFunction(value.once);

/**
 * The tsgo child process behind an API (`api.client.channel.child` in TypeScript 7.0.2). Exported
 * for the test that proves closing a session reaches it.
 * @internal
 */
export const tsgoProcess = (api: unknown): ChildProcess | undefined => {
  const client: unknown = Predicate.hasProperty(api, "client") ? api.client : undefined;
  const channel = Predicate.hasProperty(client, "channel") ? client.channel : undefined;
  const child = Predicate.hasProperty(channel, "child") ? channel.child : undefined;
  return isChildProcess(child) ? child : undefined;
};

const closeSession = (session: Session): void => {
  liveSessions.delete(session);
  // Older snapshots are disposed when replaced (openProject), so after this one the API has
  // nothing left to release and close() sends no request.
  session.current?.snapshot.dispose();
  session.current = null;
  // API.close() closes tsgo's stdin and then sends SIGTERM. tsgo shuts down on either, and can
  // log "context canceled" to the stderr it shares with this process while it does, racing the
  // CLI's own output (seen on Linux). Nothing is left to say to it, so stop it outright first.
  tsgoProcess(session.api)?.kill("SIGKILL");
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

// The synchronous, TS5-shaped facade needs sessions without an Effect context. Each lives in its
// own child of one process-wide scope, closed by closeDefaultSessions(). A process that exits
// without closing it leaves nothing behind: the TypeScript API kills its child processes on exit
// (closing them from another exit handler races that and makes tsgo print "context canceled").
let processScope = Effect.runSync(Scope.make());
const defaultSessions = new Map<
  boolean,
  { readonly session: Session; readonly scope: Scope.Closeable }
>();

/** Closes every default session (their tsgo processes). Later calls start new ones. */
export const closeDefaultSessions = (): void => {
  const scope = processScope;
  processScope = Effect.runSync(Scope.make());
  defaultSessions.clear();
  Effect.runSync(Scope.close(scope, Exit.void));
};

const startDefaultSession = (blankThirdParty: boolean): Session => {
  const scope = Scope.forkUnsafe(processScope);
  const session = Effect.runSync(Scope.provide(scope)(acquireSession({ blankThirdParty })));
  defaultSessions.set(blankThirdParty, { session, scope });
  return session;
};

/** The process-wide session for a blanking mode, started on first use. */
export const defaultSession = (blankThirdParty: boolean): Session =>
  defaultSessions.get(blankThirdParty)?.session ?? startDefaultSession(blankThirdParty);

/**
 * Replaces the process-wide session for a blanking mode with a new tsgo process, closing the
 * previous one and every program opened on it. tsgo keeps a config's options and root files,
 * and the session keeps the files it blanked, across snapshots; a new session reads them all
 * again.
 */
export const restartDefaultSession = (blankThirdParty: boolean): Session => {
  const existing = defaultSessions.get(blankThirdParty);
  if (existing !== undefined) {
    defaultSessions.delete(blankThirdParty);
    Effect.runSync(Scope.close(existing.scope, Exit.void));
  }
  return startDefaultSession(blankThirdParty);
};

/** Every default session started so far. */
export const defaultSessionList = (): ReadonlyArray<Session> =>
  [...defaultSessions.values()].map(({ session }) => session);

/**
 * Opens `configPath` (a real or virtual tsconfig) in a new snapshot, releasing the session's
 * previous project. The returned project stays usable until the next open on this session.
 * Every open after the first invalidates tsgo's cached files, so files edited since the previous
 * open (or created or deleted) are read again.
 */
export const openProject = (session: Session, configPath: string): Project => {
  const previous = session.current;
  const closeProjects =
    previous !== null && previous.config !== configPath ? [previous.config] : [];
  const snapshot = session.api.updateSnapshot({
    openProjects: [configPath],
    closeProjects,
    fileChanges: previous === null ? undefined : { invalidateAll: true },
  });
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
