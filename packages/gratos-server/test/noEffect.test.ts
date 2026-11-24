// The core and its plugins never import `effect`, directly or transitively (docs/plan.html M4a):
// the package entry, run under plain Node with every plugin installed, resolves no module from
// the effect package. The Effect layer is planned as a separate entry (M5).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const support = join(import.meta.dirname, "support");
const scratch = mkdtempSync(join(tmpdir(), "gratos-server-modules-"));
const modulesFile = join(scratch, "modules.json");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("@dblechoc/gratos-server core", () => {
  it("never imports effect", () => {
    const run = spawnSync(
      process.execPath,
      ["--import", join(support, "recordModules.ts"), join(support, "useCore.ts")],
      { encoding: "utf8", env: { ...process.env, GRATOS_RECORD_MODULES: modulesFile } },
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ data: { count: 1 } });
    const parsed: unknown = JSON.parse(readFileSync(modulesFile, "utf8"));
    const urls = Array.isArray(parsed) ? parsed.map(String) : [];
    // The recording works: the entry, graphql and graphql-jit were resolved.
    expect(urls.some((url) => url.endsWith("/gratos-server/src/index.ts"))).toBe(true);
    expect(urls.some((url) => url.includes("/graphql@17.1.0/"))).toBe(true);
    expect(urls.some((url) => url.includes("/graphql-jit@0.10.1"))).toBe(true);
    expect(urls.filter((url) => /\/effect@|\/node_modules\/effect\/|^effect$/.test(url))).toEqual(
      [],
    );
  });
});
