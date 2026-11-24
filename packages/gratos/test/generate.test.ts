// The Effect shell (src/generate.ts): generate() and check() against an in-memory FileSystem.
// TypeScript itself (tsgo) reads the project's sources from disk; every file the shell reads or
// writes (the tsconfig and the generated files) goes through the FileSystem service, so a fake
// one shows exactly which files it writes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, PlatformError, Scope } from "effect";

import {
  check,
  ConfigError,
  DiagnosticsError,
  generate,
  OutputError,
  StaleFilesError,
} from "../src/generate.ts";
import {
  closeDefaultSessions,
  defaultSession,
  defaultSessionList,
  openProject,
  openSessionList,
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
