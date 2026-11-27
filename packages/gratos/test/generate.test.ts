// The Effect shell (src/generate.ts): generate() and check() against an in-memory FileSystem.
// TypeScript itself (tsgo) reads the project's sources from disk; every file the shell reads or
// writes (the tsconfig and the generated files) goes through the FileSystem service, so a fake
// one shows exactly which files it writes.
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, posix, win32 } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, PlatformError, Scope } from "effect";

import {
  check,
  ConfigError,
  DiagnosticsError,
  generate,
  OutputError,
  splitPath,
  StaleFilesError,
} from "../src/generate.ts";
import {
  closeDefaultSessions,
  defaultSession,
  defaultSessionList,
  openProject,
  openSessionList,
  tsgoProcess,
} from "../src/ts/session.ts";
import type { Session } from "../src/ts/session.ts";

import { scratchProject, smokeCopy } from "./support/scratch.ts";

const smokeDir = join(import.meta.dirname, "smoke");
const smokeTsconfig = join(smokeDir, "tsconfig.json");
const sdlPath = join(smokeDir, "schema.graphql");
const tsPath = join(smokeDir, "schema.ts");
const committedSdl = readFileSync(sdlPath, "utf8");
const committedTs = readFileSync(tsPath, "utf8");

const systemError = (_tag: "NotFound" | "PermissionDenied", method: string, path: string) =>
  PlatformError.systemError({ _tag, module: "FileSystem", method, pathOrDescriptor: path });

/**
 * An in-memory FileSystem holding `files`, recording every write. Reading a path in `unreadable`,
 * or writing one in `unwritable`, fails with PermissionDenied.
 */
const memoryFileSystem = (
  files: Record<string, string | Uint8Array>,
  denied: {
    readonly unreadable?: ReadonlyArray<string>;
    readonly unwritable?: ReadonlyArray<string>;
  } = {},
) => {
  const contents = new Map(Object.entries(files));
  const writes: Array<string> = [];
  const layer = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(contents.has(path)),
    // Strings are stored as UTF-8.
    readFile: (path) => {
      if (denied.unreadable?.includes(path) === true) {
        return Effect.fail(systemError("PermissionDenied", "readFile", path));
      }
      const content = contents.get(path);
      if (content === undefined) {
        return Effect.fail(systemError("NotFound", "readFile", path));
      }
      return Effect.succeed(
        typeof content === "string" ? new TextEncoder().encode(content) : content,
      );
    },
    // Decodes as Effect's FileSystem does (TextDecoder), dropping a leading UTF-8 byte order mark.
    readFileString: (path) => {
      if (denied.unreadable?.includes(path) === true) {
        return Effect.fail(systemError("PermissionDenied", "readFileString", path));
      }
      const content = contents.get(path);
      return content === undefined
        ? Effect.fail(systemError("NotFound", "readFileString", path))
        : Effect.succeed(typeof content === "string" ? content : new TextDecoder().decode(content));
    },
    writeFileString: (path, data) =>
      denied.unwritable?.includes(path) === true
        ? Effect.fail(systemError("PermissionDenied", "writeFileString", path))
        : Effect.sync(() => {
            writes.push(path);
            contents.set(path, data);
          }),
  });
  return { layer, writes, contents };
};

/**
 * NodeFileSystem, recording the paths it reads links of (inside `dir`, as a physical path) and
 * counting its realPath calls.
 */
const spiedFileSystem = (dir: string) => {
  const physicalDir = realpathSync(dir);
  const readLinks: Array<string> = [];
  let realPaths = 0;
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({
        ...fs,
        readLink: (path) => {
          if (path.startsWith(physicalDir)) {
            readLinks.push(path);
          }
          return fs.readLink(path);
        },
        realPath: (path) => {
          realPaths += 1;
          return fs.realPath(path);
        },
      });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));
  return { layer, readLinks, realPaths: () => realPaths };
};

const smokeConfig = readFileSync(smokeTsconfig, "utf8");

/** The sessions opened since `before` that are still open. */
const sessionsSince = (before: ReadonlyArray<Session>): ReadonlyArray<Session> =>
  openSessionList().filter((session) => !before.includes(session));

/** Opens an empty virtual project on `session`: it throws once the session's tsgo is closed. */
let probeCount = 0;
const probe = (session: Session): void => {
  probeCount += 1;
  const configPath = join(smokeDir, `__gratos_probe_${probeCount}__.tsconfig.json`);
  session.virtualFiles.set(configPath, JSON.stringify({ compilerOptions: {}, files: [] }));
  openProject(session, configPath);
};

describe("splitPath: a root is never read as segments", () => {
  it("posix: the root, then the segments", () => {
    expect(splitPath("/project/./real//schema.ts", posix)).toEqual({
      root: "/",
      segments: ["project", "real", "schema.ts"],
    });
    expect(splitPath("../real/schema.ts", posix)).toEqual({
      root: "",
      segments: ["..", "real", "schema.ts"],
    });
  });

  it("Windows: a drive root and a UNC share root stay whole, either separator", () => {
    expect(splitPath(String.raw`C:\project\real/schema.ts`, win32)).toEqual({
      root: `C:${win32.sep}`,
      segments: ["project", "real", "schema.ts"],
    });
    expect(splitPath(String.raw`\\server\share\project\schema.ts`, win32)).toEqual({
      root: `${String.raw`\\server\share`}${win32.sep}`,
      segments: ["project", "schema.ts"],
    });
    expect(splitPath(String.raw`..\real\schema.ts`, win32)).toEqual({
      root: "",
      segments: ["..", "real", "schema.ts"],
    });
  });
});

describe("generate", () => {
  it.effect("writes both files when they are missing", () => {
    const fs = memoryFileSystem({ [smokeTsconfig]: smokeConfig });
    return Effect.gen(function* () {
      const result = yield* Effect.scoped(generate(smokeTsconfig));
      expect(result.sdl).toBe(committedSdl);
      expect(result.ts).toBe(committedTs);
      expect(result.diagnostics).toEqual([]);
      expect(fs.writes).toEqual([sdlPath, tsPath]);
      expect(fs.contents.get(sdlPath)).toBe(committedSdl);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("does not rewrite files whose content is unchanged", () => {
    const fs = memoryFileSystem({
      [smokeTsconfig]: smokeConfig,
      [sdlPath]: committedSdl,
      [tsPath]: committedTs,
    });
    return Effect.gen(function* () {
      const result = yield* Effect.scoped(generate(smokeTsconfig));
      expect(result.files.map((file) => [file.name, file.upToDate])).toEqual([
        ["schema.graphql", true],
        ["schema.ts", true],
      ]);
      expect(fs.writes).toEqual([]);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("rewrites only the file that changed", () => {
    const fs = memoryFileSystem({
      [smokeTsconfig]: smokeConfig,
      [sdlPath]: `${committedSdl}# stale\n`,
      [tsPath]: committedTs,
    });
    return Effect.gen(function* () {
      yield* Effect.scoped(generate(smokeTsconfig));
      expect(fs.writes).toEqual([sdlPath]);
      expect(fs.contents.get(sdlPath)).toBe(committedSdl);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("closes its own TypeScript process with the scope", () =>
    Effect.gen(function* () {
      const before = openSessionList();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* generate(smokeTsconfig);
          expect(sessionsSince(before)).toHaveLength(1);
        }),
      );
      expect(openSessionList()).toEqual(before);
    }).pipe(Effect.provide(memoryFileSystem({ [smokeTsconfig]: smokeConfig }).layer)),
  );

  it.effect("kills its tsgo process outright, so tsgo cannot log while it shuts down", () =>
    Effect.gen(function* () {
      const before = openSessionList();
      const child = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* generate(smokeTsconfig);
          const [session] = sessionsSince(before);
          const process = tsgoProcess(session?.api);
          // TypeScript's internals still lead to the child; otherwise the kill would be a no-op.
          assert.isDefined(process);
          return process;
        }),
      );
      const signal = yield* Effect.promise(
        () =>
          new Promise<NodeJS.Signals | null>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve(child.signalCode);
            } else {
              child.once("exit", (_code, exitSignal) => resolve(exitSignal));
            }
          }),
      );
      expect(signal).toBe("SIGKILL");
    }).pipe(Effect.provide(memoryFileSystem({ [smokeTsconfig]: smokeConfig }).layer)),
  );

  it.effect("leaves every other TypeScript session open (both blanking modes)", () =>
    Effect.gen(function* () {
      // The facade's process-wide sessions, in both blanking modes, as a host process may hold.
      const blanking = defaultSession(true);
      const full = defaultSession(false);
      // Another generate() call, still running in its own scope.
      const concurrent = yield* Scope.make();
      yield* generate(smokeTsconfig).pipe(Scope.provide(concurrent));
      const [other] = sessionsSince([blanking, full]);
      assert.isDefined(other);
      yield* Effect.scoped(check(smokeTsconfig));
      for (const session of [blanking, full, other]) {
        expect(openSessionList()).toContain(session);
        probe(session);
      }
      expect(defaultSessionList()).toEqual([blanking, full]);
      yield* Scope.close(concurrent, Exit.void);
      expect(openSessionList()).not.toContain(other);
    }).pipe(
      Effect.provide(
        memoryFileSystem({
          [smokeTsconfig]: smokeConfig,
          [sdlPath]: committedSdl,
          [tsPath]: committedTs,
        }).layer,
      ),
      Effect.ensuring(Effect.sync(closeDefaultSessions)),
    ),
  );

  it.effect("closes its TypeScript process when the project fails to open", () => {
    // The FileSystem has the tsconfig, but TypeScript reads the disk, where it does not exist.
    const missing = join(smokeDir, "missing", "tsconfig.json");
    return Effect.gen(function* () {
      const before = openSessionList();
      const error = yield* Effect.flip(Effect.scoped(generate(missing)));
      assert.instanceOf(error, ConfigError);
      expect(openSessionList()).toEqual(before);
    }).pipe(Effect.provide(memoryFileSystem({ [missing]: smokeConfig }).layer));
  });

  it.effect("decodes the grats config with Schema: an unknown option is a ConfigError", () => {
    const fs = memoryFileSystem({
      [smokeTsconfig]: JSON.stringify({ grats: { graphqlSchema: "./a.graphql", colour: true } }),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(generate(smokeTsconfig)));
      assert.instanceOf(error, ConfigError);
      expect(error.message).toContain("its `grats` config is invalid");
      expect(error.message).toContain("colour");
      expect(fs.writes).toEqual([]);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("rejects two outputs with the same path as a ConfigError, and writes nothing", () => {
    // The metadata file is named by replacing a `.graphql` extension, so with `schema.gql` it
    // would overwrite the SDL: every run would rewrite it, and --check could never pass.
    const config = smokeConfig.replace(
      '"graphqlSchema": "./schema.graphql",',
      '"graphqlSchema": "./schema.gql", "EXPERIMENTAL__emitMetadata": true,',
    );
    expect(config).not.toBe(smokeConfig);
    const fs = memoryFileSystem({ [smokeTsconfig]: config });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(generate(smokeTsconfig)));
      assert.instanceOf(error, ConfigError);
      expect(error.message).toContain("Two generated files would both be written to `schema.gql`");
      expect(fs.writes).toEqual([]);
      const checked = yield* Effect.flip(Effect.scoped(check(smokeTsconfig)));
      assert.instanceOf(checked, ConfigError);
    }).pipe(Effect.provide(fs.layer));
  });

  // Real projects on disk: the outputs alias one file only through the file system. The schema's
  // name has an "é" (composed, U+00E9) so that a decomposed spelling can alias it.
  const schemaName = "sch\u00e9ma.ts";
  /** What each output path holds (following links), or null when nothing is there. */
  const outputsOnDisk = (dir: string) =>
    ["schema.graphql", join("real", schemaName), "enums.ts", join("link", "enums.ts")].map((name) =>
      existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null,
    );
  for (const [alias, tsClientEnums, prepare] of [
    [
      "a symlinked directory",
      `./link/${schemaName}`,
      (dir: string) => {
        mkdirSync(join(dir, "real"));
        symlinkSync(join(dir, "real"), join(dir, "link"));
      },
    ],
    ["letter case", "./real/SCH\u00c9MA.ts", (dir: string) => mkdirSync(join(dir, "real"))],
    [
      // The schema exists: on a case-sensitive file system the other spelling is a separate,
      // missing file, compared by its path key.
      "letter case, the schema already written",
      "./real/SCH\u00c9MA.ts",
      (dir: string) => {
        mkdirSync(join(dir, "real"));
        writeFileSync(join(dir, "real", schemaName), "");
      },
    ],
    [
      "Unicode normalization, the schema already written",
      "./real/sche\u0301ma.ts", // decomposed: "e" + U+0301
      (dir: string) => {
        mkdirSync(join(dir, "real"));
        writeFileSync(join(dir, "real", schemaName), "");
      },
    ],
    [
      "a symlink to the missing output",
      "./enums.ts",
      (dir: string) => {
        mkdirSync(join(dir, "real"));
        symlinkSync(join(dir, "real", schemaName), join(dir, "enums.ts"));
      },
    ],
    [
      "a relative symlink reached through a symlinked directory",
      "./link/enums.ts",
      (dir: string) => {
        // link/enums.ts -> ../../real/schéma.ts climbs from nested/real/, where the link really
        // is, to real/schéma.ts; read from link/ instead, it would point outside the project.
        mkdirSync(join(dir, "real"));
        mkdirSync(join(dir, "nested", "real"), { recursive: true });
        symlinkSync(join(dir, "nested", "real"), join(dir, "link"));
        symlinkSync(`../../real/${schemaName}`, join(dir, "nested", "real", "enums.ts"));
      },
    ],
    [
      "a symlink whose target climbs through another symlink",
      "./enums.ts",
      (dir: string) => {
        // enums.ts -> sub/link/../../../real/schéma.ts: the OS follows sub/link to
        // elsewhere/deep/deeper first, so the three `..` climb back to the project's real/. Read
        // as text, `link/..` cancels and the target points outside the project.
        mkdirSync(join(dir, "real"));
        mkdirSync(join(dir, "sub"));
        mkdirSync(join(dir, "elsewhere", "deep", "deeper"), { recursive: true });
        symlinkSync("../elsewhere/deep/deeper", join(dir, "sub", "link"));
        symlinkSync(`sub/link/../../../real/${schemaName}`, join(dir, "enums.ts"));
      },
    ],
    [
      "a hard link",
      "./enums.ts",
      (dir: string) => {
        mkdirSync(join(dir, "real"));
        writeFileSync(join(dir, "real", schemaName), "");
        linkSync(join(dir, "real", schemaName), join(dir, "enums.ts"));
      },
    ],
    [
      "Unicode normalization",
      "./real/sche\u0301ma.ts", // decomposed: "e" + U+0301
      (dir: string) => mkdirSync(join(dir, "real")),
    ],
  ] as const) {
    it.effect(`rejects two outputs that are one file through ${alias}`, () => {
      const project = smokeCopy("output-alias");
      prepare(project.dir);
      const tsconfig = project.path("tsconfig.json");
      const config = readFileSync(tsconfig, "utf8").replace(
        '"tsSchema": "./schema.ts",',
        `"tsSchema": "./real/${schemaName}", "tsClientEnums": "${tsClientEnums}",`,
      );
      expect(config).toContain("tsClientEnums");
      writeFileSync(tsconfig, config);
      const before = outputsOnDisk(project.dir);
      return Effect.gen(function* () {
        const error = yield* Effect.flip(Effect.scoped(generate(tsconfig)));
        assert.instanceOf(error, ConfigError);
        expect(error.message).toContain("Two generated files would both be written to");
        // A ConfigError, not StaleFilesError: no output exists yet, so check() would fail anyway.
        const checked = yield* Effect.flip(Effect.scoped(check(tsconfig)));
        assert.instanceOf(checked, ConfigError);
        expect(outputsOnDisk(project.dir)).toEqual(before);
      }).pipe(Effect.provide(NodeFileSystem.layer), Effect.ensuring(Effect.sync(project.remove)));
    });
  }

  /**
   * enums.ts -> a1/b1/schéma.ts, where a1 -> a2 -> … -> level/ (a directory) and
   * level/b1 -> level/b2 -> … -> real/: followed to the end, enums.ts is real/schéma.ts, the
   * schema. The walk takes 1 + `aLinks` + `bLinks` hops, over two levels of one target.
   */
  const linkChains = (aLinks: number, bLinks: number) => (dir: string) => {
    mkdirSync(join(dir, "real"));
    mkdirSync(join(dir, "level"));
    for (let i = 1; i <= aLinks; i += 1) {
      symlinkSync(i === aLinks ? "level" : `a${i + 1}`, join(dir, `a${i}`));
    }
    for (let i = 1; i <= bLinks; i += 1) {
      symlinkSync(i === bLinks ? "../real" : `b${i + 1}`, join(dir, "level", `b${i}`));
    }
    symlinkSync(`a1/b1/${schemaName}`, join(dir, "enums.ts"));
  };

  for (const [layout, prepare, readLinks, outcome] of [
    // 39 hops: followed to the end, enums.ts is the schema.
    ["links within the hop budget, over two levels", linkChains(20, 18), 39, "collision"],
    // 46 hops: each level is under 40, but the budget is for the whole walk. The walk stops at
    // level/b20 and treats enums.ts as missing there, so no collision is found; reading it then
    // fails (ELOOP: the OS bounds a lookup at 40 links on Linux, 32 on macOS).
    ["links over the hop budget, over two levels", linkChains(20, 25), 40, "unreadable"],
    [
      "a symlink to itself",
      (dir: string) => {
        mkdirSync(join(dir, "real"));
        symlinkSync("enums.ts", join(dir, "enums.ts"));
      },
      40,
      "unreadable",
    ],
  ] as const) {
    it.effect(`follows ${layout} one readLink per hop, with no realPath`, () => {
      const project = smokeCopy("output-hops");
      prepare(project.dir);
      const tsconfig = project.path("tsconfig.json");
      const config = readFileSync(tsconfig, "utf8").replace(
        '"tsSchema": "./schema.ts",',
        `"tsSchema": "./real/${schemaName}", "tsClientEnums": "./enums.ts",`,
      );
      expect(config).toContain("tsClientEnums");
      writeFileSync(tsconfig, config);
      const spy = spiedFileSystem(project.dir);
      const before = outputsOnDisk(project.dir);
      return Effect.gen(function* () {
        const error = yield* Effect.flip(Effect.scoped(generate(tsconfig)));
        expect(spy.readLinks).toHaveLength(readLinks);
        expect(spy.realPaths()).toBe(0);
        if (outcome === "collision") {
          assert.instanceOf(error, ConfigError);
          expect(error.message).toContain("Two generated files would both be written to");
        } else {
          assert.instanceOf(error, OutputError);
          expect(error.path).toBe(project.path("enums.ts"));
        }
        const checked = yield* Effect.flip(Effect.scoped(check(tsconfig)));
        expect(checked._tag).toBe(outcome === "collision" ? "ConfigError" : "OutputError");
        expect(outputsOnDisk(project.dir)).toEqual(before);
      }).pipe(Effect.provide(spy.layer), Effect.ensuring(Effect.sync(project.remove)));
    });
  }

  it.effect("reports a tsconfig that is not JSON with comments as a ConfigError", () => {
    const fs = memoryFileSystem({ [smokeTsconfig]: '{ "grats": { ' });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(generate(smokeTsconfig)));
      assert.instanceOf(error, ConfigError);
      expect(error.message).toContain("is not valid JSON with comments");
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("reports a missing tsconfig as a ConfigError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(generate(smokeTsconfig)));
      assert.instanceOf(error, ConfigError);
      expect(error.message).toContain("Could not read");
    }).pipe(Effect.provide(memoryFileSystem({}).layer)),
  );

  for (const encoding of ["utf16le", "utf16be"] as const) {
    it.effect(`reads a ${encoding} tsconfig with a byte order mark, as TypeScript does`, () => {
      // TypeScript reads the tsconfig from disk, and the shell through FileSystem: both get the
      // same bytes.
      const bytes = Buffer.from(`\uFEFF${smokeConfig}`, "utf16le");
      if (encoding === "utf16be") {
        bytes.swap16();
      }
      const project = smokeCopy(`generate-${encoding}`);
      writeFileSync(project.path("tsconfig.json"), bytes);
      const tsconfig = project.path("tsconfig.json");
      const fs = memoryFileSystem({ [tsconfig]: bytes });
      return Effect.gen(function* () {
        const result = yield* Effect.scoped(generate(tsconfig));
        expect(result.sdl).toBe(committedSdl);
        expect(result.ts).toBe(committedTs);
        expect(fs.writes).toEqual([project.path("schema.graphql"), project.path("schema.ts")]);
      }).pipe(Effect.provide(fs.layer), Effect.ensuring(Effect.sync(project.remove)));
    });
  }

  it.effect("warns about experimental options", () => {
    const withMetadata = smokeConfig.replace(
      '"tsSchemaHeader": null',
      '"tsSchemaHeader": null,\n    "EXPERIMENTAL__emitMetadata": true',
    );
    expect(withMetadata).not.toBe(smokeConfig);
    const fs = memoryFileSystem({ [smokeTsconfig]: withMetadata });
    return Effect.gen(function* () {
      const result = yield* Effect.scoped(generate(smokeTsconfig));
      expect(result.diagnostics).toEqual([
        "Gratos: The `EXPERIMENTAL__emitMetadata` option is experimental and will be renamed or removed in a future release.",
      ]);
      expect(fs.writes).toEqual([sdlPath, tsPath, join(smokeDir, "schema.json")]);
    }).pipe(Effect.provide(fs.layer));
  });
});

describe("check", () => {
  it.effect("succeeds and writes nothing when the files are up to date", () => {
    const fs = memoryFileSystem({
      [smokeTsconfig]: smokeConfig,
      [sdlPath]: committedSdl,
      [tsPath]: committedTs,
    });
    return Effect.gen(function* () {
      yield* Effect.scoped(check(smokeTsconfig));
      expect(fs.writes).toEqual([]);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("fails with StaleFilesError naming the stale files, and writes nothing", () => {
    const fs = memoryFileSystem({ [smokeTsconfig]: smokeConfig, [tsPath]: `${committedTs}//` });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(check(smokeTsconfig)));
      assert.instanceOf(error, StaleFilesError);
      expect(error.files).toEqual(["schema.graphql", "schema.ts"]);
      expect(error.message).toBe(
        "Gratos: `schema.graphql` is out of date. Run `gratos`.\nGratos: `schema.ts` is out of date. Run `gratos`.",
      );
      expect(fs.writes).toEqual([]);
    }).pipe(Effect.provide(fs.layer));
  });
});

describe("an output file with a UTF-8 byte order mark", () => {
  // The committed SDL, prefixed with a byte order mark: decoded as text, it equals the SDL.
  const sdlWithBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(committedSdl)]);

  it.effect("is out of date for check(), which writes nothing", () => {
    const fs = memoryFileSystem({
      [smokeTsconfig]: smokeConfig,
      [sdlPath]: sdlWithBom,
      [tsPath]: committedTs,
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(check(smokeTsconfig)));
      assert.instanceOf(error, StaleFilesError);
      expect(error.files).toEqual(["schema.graphql"]);
      expect(fs.writes).toEqual([]);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("is rewritten without it by generate()", () => {
    const fs = memoryFileSystem({
      [smokeTsconfig]: smokeConfig,
      [sdlPath]: sdlWithBom,
      [tsPath]: committedTs,
    });
    return Effect.gen(function* () {
      yield* Effect.scoped(generate(smokeTsconfig));
      expect(fs.writes).toEqual([sdlPath]);
      expect(fs.contents.get(sdlPath)).toBe(committedSdl);
    }).pipe(Effect.provide(fs.layer));
  });
});

describe("output files that cannot be read or written", () => {
  it.effect("check() reports an unreadable file as an OutputError, not as stale", () => {
    const fs = memoryFileSystem(
      { [smokeTsconfig]: smokeConfig, [sdlPath]: committedSdl, [tsPath]: committedTs },
      { unreadable: [sdlPath] },
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(check(smokeTsconfig)));
      assert.instanceOf(error, OutputError);
      expect(error.path).toBe(sdlPath);
      expect(error.message).toBe(
        `Gratos: Could not read \`${sdlPath}\`: ${systemError("PermissionDenied", "readFile", sdlPath).message}`,
      );
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("generate() reports an unreadable file as an OutputError and writes nothing", () => {
    const fs = memoryFileSystem({ [smokeTsconfig]: smokeConfig }, { unreadable: [tsPath] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(generate(smokeTsconfig)));
      assert.instanceOf(error, OutputError);
      expect(error.path).toBe(tsPath);
      expect(fs.writes).toEqual([]);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("generate() reports a denied write as an OutputError, not a defect", () => {
    const fs = memoryFileSystem({ [smokeTsconfig]: smokeConfig }, { unwritable: [tsPath] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.scoped(generate(smokeTsconfig)));
      assert.instanceOf(error, OutputError);
      expect(error.path).toBe(tsPath);
      expect(error.message).toContain(`Gratos: Could not write \`${tsPath}\`: `);
      expect(error.message).toContain("PermissionDenied");
      expect(fs.writes).toEqual([sdlPath]);
    }).pipe(Effect.provide(fs.layer));
  });
});

describe("diagnostics", () => {
  // A real project on disk: the hint must fire with node_modules read as empty (fast loading).
  const bareEffect = scratchProject("bare-effect", {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext" },
      include: ["*.ts"],
    }),
    "query.ts": [
      'import type { Effect } from "effect/Effect";',
      "",
      "/** @gqlQueryField */",
      "export function greeting(): Effect<string> {",
      '  throw new Error("not called");',
      "}",
      "",
    ].join("\n"),
  });
  const tsconfig = bareEffect.path("tsconfig.json");

  it.effect(
    "fails with DiagnosticsError, and hints at Effect.Effect with node_modules blanked",
    () =>
      Effect.gen(function* () {
        const before = openSessionList();
        const error = yield* Effect.scoped(
          Effect.gen(function* () {
            const failure = yield* Effect.flip(generate(tsconfig));
            // Fast loading was on: effect's own declaration files were read as empty.
            const [session] = sessionsSince(before);
            expect(session?.blankThirdParty).toBe(true);
            expect(
              [...(session?.blanked ?? [])].some((file) =>
                file.includes("/node_modules/effect/dist/Effect.d.ts"),
              ),
            ).toBe(true);
            return failure;
          }),
        );
        assert.instanceOf(error, DiagnosticsError);
        expect(error.message).toContain("Expected `Effect.Effect`, not a bare `Effect`.");
        expect(error.formatted).toContain("\u001b[");
      }).pipe(
        Effect.provide(memoryFileSystem({ [tsconfig]: readFileSync(tsconfig, "utf8") }).layer),
        Effect.ensuring(Effect.sync(bareEffect.remove)),
      ),
  );
});
