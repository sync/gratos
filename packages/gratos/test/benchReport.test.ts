// The informational bench job (docs/plan.html F3): the bounds bench/run.ts applies, its warn-only
// mode (a miss is a `::warning::` and exit 0, a crash still fails), and the job summary that
// bench/report.ts writes. Bounds are lowered to 1 ms rather than waiting for a slow build, so no
// check depends on how fast this machine is.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { boundsFor, exitCodeFor, missesOf, warningCommand } from "../bench/bounds.ts";
import { summarize } from "../bench/summary.ts";
import type { BuildResult, DevTimings } from "../bench/summary.ts";
import { scratchProject, smokeCopy } from "./support/scratch.ts";
import type { ScratchProject } from "./support/scratch.ts";

const benchDir = join(import.meta.dirname, "..", "bench");

const projects: Array<ScratchProject> = [];
afterEach(() => {
  for (const project of projects.splice(0)) {
    project.remove();
  }
});

/** Runs a bench script in a fresh process, with CI unset unless `env` sets it. */
const runScript = (script: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [join(benchDir, script), ...args], {
    encoding: "utf8",
    // A fixed peak RSS: this required test checks bounds and exit codes, never `ps` timing.
    env: {
      ...process.env,
      CI: "",
      GITHUB_STEP_SUMMARY: "",
      GRATOS_BENCH_FIXED_RSS_KB: "204800",
      ...env,
    },
    timeout: 50_000,
  });

const measured = { filesLoaded: 100, coldBuildMs: 700, peakRssMb: 300 };

describe("bench bounds", () => {
  it("are the spec targets locally and +20% in CI: 1,080 ms cold build, 456 MB peak RSS", () => {
    expect(boundsFor(false)).toEqual({ filesLoaded: 530, coldBuildMs: 900, peakRssMb: 380 });
    expect(boundsFor(true)).toEqual({ filesLoaded: 636, coldBuildMs: 1080, peakRssMb: 456 });
  });

  it("take an override per measure, and reject an unknown measure or a bad value", () => {
    expect(boundsFor(true, ["coldBuildMs=1"])).toEqual({
      filesLoaded: 636,
      coldBuildMs: 1,
      peakRssMb: 456,
    });
    for (const bad of ["speed=1", "coldBuildMs=0", "coldBuildMs=-1", "coldBuildMs", "x=1e3"]) {
      expect(() => boundsFor(false, [bad])).toThrow(/--bound takes <measure>=<positive number>/);
    }
  });

  it("fail a run on a miss, except in warn-only mode", () => {
    const misses = missesOf(measured, boundsFor(false, ["peakRssMb=299"]));
    expect(misses).toEqual([{ measure: "peakRssMb", value: 300, bound: 299 }]);
    expect(exitCodeFor(misses, false)).toBe(1);
    expect(exitCodeFor(misses, true)).toBe(0);
    expect(exitCodeFor(missesOf(measured, boundsFor(false)), false)).toBe(0);
  });

  it("print a miss as a workflow warning, escaped", () => {
    expect(warningCommand("p", { measure: "coldBuildMs", value: 1200, bound: 1080 })).toBe(
      "::warning title=bench::p: coldBuildMs 1200 is above the bound 1080",
    );
    expect(warningCommand("50%\nnext", { measure: "m", value: 2, bound: 1 })).toBe(
      "::warning title=bench::50%25%0Anext: m 2 is above the bound 1",
    );
  });
});

describe("bench/run.ts", () => {
  it("warns and exits 0 on a miss with --warn-only, exits 1 without it, and fails on a crash", () => {
    const project = smokeCopy("bench-warn");
    projects.push(project);
    const out = project.path("result.json");
    const common = ["--project", project.path("tsconfig.json"), "--runs", "1"];
    common.push("--baseline", project.path("no-baseline.json"));

    const warned = runScript("run.ts", [
      ...common,
      "--bound",
      "coldBuildMs=1",
      "--warn-only",
      "--out",
      out,
    ]);
    expect(warned.stderr).toContain("bench: outside the spec bounds: coldBuildMs");
    expect(warned.stdout).toMatch(
      /^::warning title=bench::.*: coldBuildMs \d+ is above the bound 1$/m,
    );
    expect(warned.status).toBe(0);
    const result: unknown = JSON.parse(readFileSync(out, "utf8"));
    expect(result).toMatchObject({
      bounds: { coldBuildMs: 1 },
      withinBounds: { coldBuildMs: false },
    });

    const failed = runScript("run.ts", [...common, "--bound", "coldBuildMs=1"]);
    expect(failed.stdout).not.toContain("::warning");
    expect(failed.status).toBe(1);

    const crashed = runScript("run.ts", [
      "--project",
      project.path("missing/tsconfig.json"),
      "--runs",
      "1",
      "--warn-only",
    ]);
    expect(crashed.status).not.toBe(0);
    expect(crashed.status).not.toBeNull();
  });
});

describe("bench/run.ts against a baseline", () => {
  it("gives percent deltas locally, and none in CI, which is judged on its own bounds", () => {
    const project = smokeCopy("bench-baseline");
    projects.push(project);
    const baseline = project.path("baseline.json");
    const runner = { platform: "other", cpu: "other", cores: 1, memoryGb: 1, node: "v0" };
    writeFileSync(
      baseline,
      JSON.stringify({ runner, filesLoaded: 100, coldBuildMs: 100, peakRssMb: 100 }),
    );
    const args = ["--project", project.path("tsconfig.json"), "--runs", "1", "--warn-only"];
    /** Runs the bench with `ci` as CI, and returns the path of its result. */
    const run = (ci: string): string => {
      const out = project.path(`result-${ci === "" ? "local" : "ci"}.json`);
      const done = runScript("run.ts", [...args, "--baseline", baseline, "--out", out], { CI: ci });
      expect(done.status, done.stderr).toBe(0);
      return out;
    };
    const local = run("");
    const ci = run("true");
    expect(JSON.parse(readFileSync(local, "utf8"))).toMatchObject({
      versusBaseline: { sameRunnerClass: false, coldBuildMs: expect.stringMatching(/%$/) },
    });
    expect(JSON.parse(readFileSync(ci, "utf8"))).toMatchObject({ versusBaseline: null });
  });
});

const build = (project: string, coldBuildMs: number): BuildResult => ({
  project,
  measured: { filesLoaded: 363, coldBuildMs, peakRssMb: 320 },
  bounds: { filesLoaded: 636, coldBuildMs: 1080, peakRssMb: 456 },
});
const dev: DevTimings = {
  timings: [
    { name: "edit → new field", ms: 900 },
    { name: "fix → recovered", ms: 3200 },
  ],
};

describe("the bench summary", () => {
  it("shows each number against its bound, and warns on the dev loop's misses", () => {
    const summary = summarize(
      [
        { ok: true, value: build("synthetic (300 models)", 750) },
        { ok: true, value: build("examples/orders/src/tsconfig.json", 1200) },
      ],
      { ok: true, value: dev },
      3000,
    );
    expect(summary.markdown).toContain(
      "| synthetic (300 models) | 750 (bound 1080) | 320 (bound 456) | 363 |",
    );
    expect(summary.markdown).toContain(
      "| examples/orders/src/tsconfig.json | **1200** ⚠️ (bound 1080) | 320 (bound 456) | 363 |",
    );
    expect(summary.markdown).toContain("| edit → new field | 900 (bound 3000) |");
    expect(summary.markdown).toContain("| fix → recovered | **3200** ⚠️ (bound 3000) |");
    expect(summary.warnings).toEqual([
      "::warning title=bench::dev loop: fix → recovered 3200 is above the bound 3000",
    ]);
    expect(summary.complete).toBe(true);
  });

  it("names an input it could not read, and is incomplete", () => {
    const summary = summarize(
      [{ ok: true, value: build("synthetic (300 models)", 750) }],
      { ok: false, file: "dev.json", reason: "ENOENT" },
      3000,
    );
    expect(summary.markdown).toContain("| `dev.json` | not measured |");
    expect(summary.markdown).toContain("`dev.json` was not read: ENOENT");
    expect(summary.warnings).toEqual([]);
    expect(summary.complete).toBe(false);
  });
});

describe("bench/report.ts", () => {
  it("appends the summary to GITHUB_STEP_SUMMARY, warns on a lowered bound and exits 0", () => {
    const project = scratchProject("bench-report");
    projects.push(project);
    project.write(
      "build.json",
      JSON.stringify({ ...build("synthetic (300 models)", 750), runs: [] }),
    );
    project.write("dev.json", JSON.stringify(dev));
    const summaryFile = project.path("summary.md");
    writeFileSync(summaryFile, "earlier step\n");

    const reported = runScript(
      "report.ts",
      [
        "--build",
        project.path("build.json"),
        "--dev",
        project.path("dev.json"),
        "--dev-bound-ms",
        "1",
      ],
      { GITHUB_STEP_SUMMARY: summaryFile },
    );
    expect(reported.stdout.trim().split("\n")).toEqual([
      "::warning title=bench::dev loop: edit → new field 900 is above the bound 1",
      "::warning title=bench::dev loop: fix → recovered 3200 is above the bound 1",
    ]);
    expect(reported.status).toBe(0);
    const written = readFileSync(summaryFile, "utf8");
    expect(written.startsWith("earlier step\n## Bench (informational)\n")).toBe(true);
    expect(written).toContain("| synthetic (300 models) | 750 (bound 1080) |");
  });

  it("fails when an input is missing, after saying which", () => {
    const project = scratchProject("bench-report-missing");
    projects.push(project);
    project.write("build.json", JSON.stringify(build("synthetic (300 models)", 750)));

    const reported = runScript("report.ts", [
      "--build",
      project.path("build.json"),
      "--dev",
      project.path("dev.json"),
    ]);
    expect(reported.stdout).toContain(`| \`${project.path("dev.json")}\` | not measured |`);
    expect(reported.status).toBe(1);
  });
});
