// The core and its plugins never import `effect`, directly or transitively (docs/plan.html M4a):
// the package entry, run under plain Node with every plugin installed, resolves no module from
// the effect package. Only the separate `gratos-server/effect` entry (M5) imports it.
// And the core entry alone never loads graphql-jit, an optional peer: jit() is the separate
// `gratos-server/jit` entry (F7).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const support = join(import.meta.dirname, "support");
const scratch = mkdtempSync(join(tmpdir(), "gratos-server-modules-"));
const modulesFile = join(scratch, "modules.json");

/** Runs a support script under plain Node and returns its output and every module it resolved. */
const traced = (script: string) => {
  const run = spawnSync(
    process.execPath,
    ["--import", join(support, "recordModules.ts"), join(support, script)],
    { encoding: "utf8", env: { ...process.env, GRATOS_RECORD_MODULES: modulesFile } },
  );
  const parsed: unknown = JSON.parse(readFileSync(modulesFile, "utf8"));
  const urls = Array.isArray(parsed) ? parsed.map(String) : [];
  return { run, urls };
};

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("gratos-server core", () => {
  it("never imports effect", () => {
    const { run, urls } = traced("useCore.ts");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ data: { count: 1 } });
    // The recording works: the entry, graphql and graphql-jit were resolved.
    expect(urls.some((url) => url.endsWith("/gratos-server/src/index.ts"))).toBe(true);
    expect(urls.some((url) => url.includes("/node_modules/graphql/"))).toBe(true);
    expect(urls.some((url) => url.includes("/node_modules/graphql-jit/"))).toBe(true);
    expect(urls.filter((url) => /\/effect@|\/node_modules\/effect\/|^effect$/.test(url))).toEqual(
      [],
    );
  });

  it("never loads graphql-jit from the core entry", () => {
    const { run, urls } = traced("importCore.ts");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("function");
    expect(urls.some((url) => url.endsWith("/gratos-server/src/index.ts"))).toBe(true);
    expect(urls.filter((url) => url.includes("graphql-jit"))).toEqual([]);
  });
});
