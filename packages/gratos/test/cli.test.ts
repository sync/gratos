// The M2 generate-and-import test: the CLI, run under plain Node 26 on TypeScript 7, generates
// the test/smoke schema; tsc typechecks it; Node imports and executes it. The CLI's loaded
// modules prove it never loads the TypeScript 5.9.2 baseline.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = join(import.meta.dirname, "..");
const smokeDir = join(import.meta.dirname, "smoke");
const recordModules = join(import.meta.dirname, "support", "recordModules.ts");
const scratch = mkdtempSync(join(tmpdir(), "gratos-cli-"));
const modulesFile = join(scratch, "modules.json");

const decodeUrls = Schema.decodeUnknownSync(Schema.Array(Schema.String));

let stderr = "";
beforeAll(() => {
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      recordModules,
      join(packageDir, "src", "upstream", "cli.ts"),
      "--tsconfig",
      join(smokeDir, "tsconfig.json"),
    ],
    {
      cwd: packageDir,
      env: { ...process.env, GRATOS_RECORD_MODULES: modulesFile },
      encoding: "utf8",
    },
  );
  if (run.status !== 0) {
    throw new Error(`gratos exited with ${run.status}:\n${run.stderr}`);
  }
  stderr = run.stderr;
}, 60_000);
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("gratos CLI on TypeScript 7", () => {
  it("writes the smoke schema", () => {
    expect(stderr).toContain("Grats: Wrote TypeScript schema to");
    expect(stderr).not.toContain("context canceled");
    const sdl = readFileSync(join(smokeDir, "schema.graphql"), "utf8");
    // ID and Int are the built-in scalars from Types.ts, imported through @dblechoc/gratos.
    expect(sdl).toContain("  id: ID\n");
    expect(sdl).toContain("  quantity: Int\n");
    expect(sdl).toContain("scalar DateTime");
    const schema = readFileSync(join(smokeDir, "schema.ts"), "utf8");
    expect(schema).toContain('import type { GqlScalar } from "@dblechoc/gratos";');
    expect(schema).toContain('from "./models/Order.ts";');
  });

  it("never loads the TypeScript 5.9.2 baseline", () => {
    const urls = decodeUrls(JSON.parse(readFileSync(modulesFile, "utf8")));
    expect(
      urls.some((url) => url.includes("/typescript@7.0.2/") && url.includes("/api/sync/")),
    ).toBe(true);
    expect(
      urls.filter((url) => url.includes("typescript@5.9.2") || url.includes("typescript-baseline")),
    ).toEqual([]);
  });

  it("generates a schema that typechecks with tsc --noEmit", () => {
    const tsc = join(packageDir, "node_modules", ".bin", "tsc");
    expect(() =>
      execFileSync(tsc, ["--noEmit", "-p", join(smokeDir, "tsconfig.json")], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("generates a schema that Node imports and executes", () => {
    const output = execFileSync(process.execPath, [join(smokeDir, "query.ts")], {
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
});
