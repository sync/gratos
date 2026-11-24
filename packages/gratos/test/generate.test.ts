// The Effect shell (src/generate.ts): generate() and check() against an in-memory FileSystem.
// TypeScript itself (tsgo) reads the project's sources from disk; every file the shell reads or
// writes (the tsconfig and the generated files) goes through the FileSystem service, so a fake
// one shows exactly which files it writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, PlatformError } from "effect";

import {
  check,
  ConfigError,
  DiagnosticsError,
  generate,
  StaleFilesError,
} from "../src/generate.ts";
import { defaultSessionList } from "../src/ts/session.ts";

import { scratchProject } from "./support/scratch.ts";

const smokeDir = join(import.meta.dirname, "smoke");
const smokeTsconfig = join(smokeDir, "tsconfig.json");
const sdlPath = join(smokeDir, "schema.graphql");
const tsPath = join(smokeDir, "schema.ts");
const committedSdl = readFileSync(sdlPath, "utf8");
const committedTs = readFileSync(tsPath, "utf8");

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

/** An in-memory FileSystem holding `files`, recording every write. */
const memoryFileSystem = (files: Record<string, string>) => {
  const contents = new Map(Object.entries(files));
  const writes: Array<string> = [];
  const layer = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(contents.has(path)),
    readFileString: (path) => {
      const content = contents.get(path);
      return content === undefined
        ? Effect.fail(notFound("readFileString", path))
        : Effect.succeed(content);
    },
    writeFileString: (path, data) =>
      Effect.sync(() => {
        writes.push(path);
        contents.set(path, data);
      }),
  });
  return { layer, writes, contents };
};

const smokeConfig = readFileSync(smokeTsconfig, "utf8");

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

  it.effect("closes the TypeScript process with the scope", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* generate(smokeTsconfig);
          expect(defaultSessionList()).toHaveLength(1);
        }),
      );
      expect(defaultSessionList()).toEqual([]);
    }).pipe(Effect.provide(memoryFileSystem({ [smokeTsconfig]: smokeConfig }).layer)),
  );

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
        const error = yield* Effect.scoped(
          Effect.gen(function* () {
            const failure = yield* Effect.flip(generate(tsconfig));
            // Fast loading was on: effect's own declaration files were read as empty.
            const [session] = defaultSessionList();
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
