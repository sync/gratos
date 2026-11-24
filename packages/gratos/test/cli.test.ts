// The `gratos` CLI (docs/plan.html M3), run as the real binary under plain Node 26 (no build
// step) on a copy of the smoke fixture: it writes both files, writes nothing when they are up to
// date, and `--check` writes nothing and exits 1 when a file is stale. The generated schema
// typechecks with tsc and Node executes it, the committed smoke schema is exactly what the CLI
// generates, and the CLI never loads the TypeScript 5.9.2 baseline.
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scratchProject, smokeCopy } from "./support/scratch.ts";

const packageDir = join(import.meta.dirname, "..");
const cli = join(packageDir, "src", "cli.ts");
const smokeDir = join(import.meta.dirname, "smoke");
const recordModules = join(import.meta.dirname, "support", "recordModules.ts");

const decodeUrls = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const PackageBin = Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) });

const project = smokeCopy("cli");
const tsconfig = project.path("tsconfig.json");
const modulesFile = project.path("modules.json");

/** Runs `node src/cli.ts …args` the way the `gratos` bin does. */
const gratos = (args: ReadonlyArray<string>, options: { cwd?: string; record?: boolean } = {}) =>
  spawnSync(
    process.execPath,
    [...(options.record === true ? ["--import", recordModules] : []), cli, ...args],
    {
      cwd: options.cwd ?? packageDir,
      env: { ...process.env, GRATOS_RECORD_MODULES: modulesFile },
      encoding: "utf8",
    },
  );

const mtimeOf = (path: string): number => statSync(path).mtimeMs;
/** stderr is exactly one line (and its newline), starting with `prefix`. */
const expectOneLine = (stderr: string, prefix: string): void => {
  expect(stderr.endsWith("\n")).toBe(true);
  expect(stderr.slice(0, -1)).not.toContain("\n");
  expect(stderr.startsWith(prefix)).toBe(true);
};

let firstRun: ReturnType<typeof gratos>;
beforeAll(() => {
  firstRun = gratos(["--tsconfig", tsconfig], { record: true });
}, 60_000);
afterAll(() => {
  project.remove();
});

describe("gratos CLI", () => {
  it("writes both files", () => {
    expect(firstRun.stderr).not.toContain("context canceled");
    expect(firstRun.status).toBe(0);
    expect(firstRun.stderr).toBe(
      `Gratos: Wrote \`${project.path("schema.graphql")}\`.\nGratos: Wrote \`${project.path("schema.ts")}\`.\n`,
    );
    const sdl = readFileSync(project.path("schema.graphql"), "utf8");
    // ID and Int are the built-in scalars from Types.ts, imported through @dblechoc/gratos.
    expect(sdl).toContain("  id: ID\n");
    expect(sdl).toContain("  quantity: Int\n");
    expect(sdl).toContain("scalar DateTime");
    const schema = readFileSync(project.path("schema.ts"), "utf8");
    expect(schema).toContain('import type { GqlScalar } from "@dblechoc/gratos";');
    expect(schema).toContain('from "./models/Order.ts";');
  });

  it("generated the committed smoke schema (pnpm codegen runs this CLI)", () => {
    for (const file of ["schema.graphql", "schema.ts"]) {
      expect(readFileSync(project.path(file), "utf8")).toBe(
        readFileSync(join(smokeDir, file), "utf8"),
      );
    }
  });

  it("never loads the TypeScript 5.9.2 baseline", () => {
    const urls = decodeUrls(JSON.parse(readFileSync(modulesFile, "utf8")));
    expect(
      urls.some((url) => url.includes("/typescript@7.0.2/") && url.includes("/api/sync/")),
    ).toBe(true);
    expect(urls.some((url) => url.endsWith("/src/cli.ts"))).toBe(true);
    expect(
      urls.filter((url) => url.includes("typescript@5.9.2") || url.includes("typescript-baseline")),
    ).toEqual([]);
  });

  it("writes nothing when the files are up to date", () => {
    const before = [mtimeOf(project.path("schema.graphql")), mtimeOf(project.path("schema.ts"))];
    const run = gratos(["--tsconfig", tsconfig]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe(
      "Gratos: `schema.graphql` is up to date.\nGratos: `schema.ts` is up to date.\n",
    );
    expect([mtimeOf(project.path("schema.graphql")), mtimeOf(project.path("schema.ts"))]).toEqual(
      before,
    );
  });

  it("finds the nearest tsconfig.json without --tsconfig", () => {
    const run = gratos([], { cwd: project.path("models") });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Gratos: `schema.graphql` is up to date.");
  });

  it("--check exits 0 and writes nothing when the files are up to date", () => {
    const run = gratos(["--check", "--tsconfig", tsconfig]);
    expect(run.status).toBe(0);
  });

  it("--check exits 1, names the stale file and writes nothing", () => {
    const sdlPath = project.path("schema.graphql");
    const original = readFileSync(sdlPath, "utf8");
    writeFileSync(sdlPath, `${original}# edited\n`);
    const tsBefore = mtimeOf(project.path("schema.ts"));
    try {
      const run = gratos(["--check", "--tsconfig", tsconfig]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe("Gratos: `schema.graphql` is out of date. Run `gratos`.\n");
      expect(readFileSync(sdlPath, "utf8")).toBe(`${original}# edited\n`);
      expect(mtimeOf(project.path("schema.ts"))).toBe(tsBefore);
    } finally {
      writeFileSync(sdlPath, original);
    }
  });

  it("--check reports a missing file as out of date", () => {
    const tsPath = project.path("schema.ts");
    const original = readFileSync(tsPath, "utf8");
    rmSync(tsPath);
    try {
      const run = gratos(["--check", "--tsconfig", tsconfig]);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe("Gratos: `schema.ts` is out of date. Run `gratos`.\n");
    } finally {
      writeFileSync(tsPath, original);
    }
  });

  it("exits 1 with a clean message when an output file cannot be read", () => {
    const sdlPath = project.path("schema.graphql");
    chmodSync(sdlPath, 0o000);
    try {
      for (const args of [["--check"], []]) {
        const run = gratos([...args, "--tsconfig", tsconfig]);
        expect(run.status).toBe(1);
        expectOneLine(run.stderr, `Gratos: Could not read \`${sdlPath}\`: PermissionDenied: `);
      }
    } finally {
      chmodSync(sdlPath, 0o644);
    }
  });

  it("exits 1 with a clean message when an output file cannot be written", () => {
    const tsPath = project.path("schema.ts");
    const original = readFileSync(tsPath, "utf8");
    writeFileSync(tsPath, `${original}//`);
    chmodSync(tsPath, 0o444);
    try {
      const run = gratos(["--tsconfig", tsconfig]);
      expect(run.status).toBe(1);
      expectOneLine(run.stderr, `Gratos: Could not write \`${tsPath}\`: PermissionDenied: `);
    } finally {
      chmodSync(tsPath, 0o644);
      writeFileSync(tsPath, original);
    }
  });

  it("generates a schema that typechecks with tsc --noEmit", () => {
    const tsc = join(packageDir, "node_modules", ".bin", "tsc");
    expect(() =>
      execFileSync(tsc, ["--noEmit", "-p", tsconfig], { encoding: "utf8", stdio: "pipe" }),
    ).not.toThrow();
  });

  it("generates a schema that Node imports and executes", () => {
    const output = execFileSync(process.execPath, [project.path("query.ts")], {
      cwd: packageDir,
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({
      data: {
        orders: [
          {
            id: "o1",
            quantity: 2,
            customer: { id: "u1", name: "Ada", joinedAt: "2026-01-02T03:04:05.000Z" },
          },
        ],
      },
    });
  });

  it("exits 1 with Grats' diagnostics for an invalid project", () => {
    const invalid = scratchProject("cli-invalid", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext" },
        include: ["*.ts"],
      }),
      "query.ts": "/** @gqlQueryField */\nexport function count(): number {\n  return 1;\n}\n",
    });
    try {
      const run = gratos(["--tsconfig", invalid.path("tsconfig.json")]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Unexpected number type.");
    } finally {
      invalid.remove();
    }
  });

  it("exits 1 for an invalid grats config", () => {
    const invalid = scratchProject("cli-config", {
      "tsconfig.json": JSON.stringify({ include: ["*.ts"], grats: { nullableByDefault: "yes" } }),
    });
    try {
      const run = gratos(["--tsconfig", invalid.path("tsconfig.json")]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("its `grats` config is invalid");
      expect(run.stderr).toContain("nullableByDefault");
    } finally {
      invalid.remove();
    }
  });

  it("is the package's `gratos` bin, runnable as an executable", () => {
    const { bin } = Schema.decodeUnknownSync(PackageBin)(
      JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")),
    );
    expect(bin).toEqual({ gratos: "./src/cli.ts" });
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(() => accessSync(cli, constants.X_OK)).not.toThrow();
    const version = execFileSync(cli, ["--version"], { encoding: "utf8" });
    expect(version).toBe("gratos v0.0.0\n");
  });
});
