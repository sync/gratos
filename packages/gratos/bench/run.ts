// `pnpm --filter gratos bench`: cold build of a synthetic 300-model project with the
// `gratos` CLI, compared with the committed baseline (bench/baseline.json at the repo root).
//
// It writes the fixture (bench/fixture.ts) to bench/.fixture/ (gitignored). It then runs the CLI in fresh Node processes
// (each spawns its own tsgo, so every run is a cold build) and records, per docs/plan.html M3:
//
// - files loaded: the program's source files, with third-party files read as empty;
// - cold build ms: wall time of one `gratos` process, from spawn to exit;
// - peak RSS: sampled over the whole process tree (Node plus the tsgo child), because the Go
//   child is not counted in Node's maxRSS (bench/rss.ts). Each run needs at least one valid
//   sample: one whose `ps` succeeded and held the CLI process.
//
// `--record` writes the result as the new baseline, with the runner class it was measured on.
//
// `--project <tsconfig>` measures an existing project instead of the synthetic fixture (M7:
// `pnpm --filter orders-example bench:compiler` for examples/orders), against the same spec
// targets, with its own baseline file (`--baseline <path>`, relative to the working directory).
//
// A number above its bound (bench/bounds.ts: the targets, +20% when CI is set) exits 1. With
// `--warn-only` (the informational bench job in .github/workflows/ci.yml) it prints a
// `::warning::` instead and exits 0; a crash still fails. `--out <path>` also writes the result to
// a file (for bench/report.ts), `--bound <measure>=<n>` replaces one bound (how a run with a
// lowered bound is shown), and `--runs <n>` sets the number of measured runs (default 5).
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { boundsFor, exitCodeFor, missesOf, TARGETS, warningCommand } from "./bounds.ts";
import { fileStats, MODEL_COUNT, readBaseline, syntheticFixtureFiles } from "./fixture.ts";
import { requireValidPeak, samplePeakRss } from "./rss.ts";
import type { PeakRss } from "./rss.ts";

const SAMPLE_INTERVAL_MS = 5;

const { values: flags } = parseArgs({
  options: {
    record: { type: "boolean", default: false },
    project: { type: "string" },
    baseline: { type: "string" },
    "warn-only": { type: "boolean", default: false },
    out: { type: "string" },
    bound: { type: "string", multiple: true, default: [] },
    runs: { type: "string", default: "5" },
  },
});

const runs = Number(flags.runs);
if (!Number.isSafeInteger(runs) || runs < 1) {
  throw new Error(`bench: --runs takes a positive integer, got ${JSON.stringify(flags.runs)}`);
}
const isCi = process.env["CI"] !== undefined && process.env["CI"] !== "";

/**
 * GRATOS_BENCH_FIXED_RSS_KB: a fixed peak instead of `ps` samples, for the required test of this
 * script's bounds and exit codes (test/benchReport.test.ts), which must not depend on `ps`
 * catching a short build. The bench job never sets it, so it samples for real.
 */
const fixedPeakRssKbOf = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  const kb = Number(value);
  if (!Number.isInteger(kb) || kb <= 0) {
    throw new Error(`bench: GRATOS_BENCH_FIXED_RSS_KB must be a positive integer, got ${value}`);
  }
  return kb;
};
const fixedPeakRssKb = fixedPeakRssKbOf(process.env["GRATOS_BENCH_FIXED_RSS_KB"]);
// Checked before any build, so a bad flag fails at once.
const bounds = boundsFor(isCi, flags.bound);

const packageDir = join(import.meta.dirname, "..");
const baselinePath =
  flags.baseline === undefined
    ? join(packageDir, "..", "..", "bench", "baseline.json")
    : resolve(flags.baseline);
const fixtureDir = join(import.meta.dirname, ".fixture");
/** The tsconfig measured: the project's, or the synthetic fixture's. */
const tsconfigPath =
  flags.project === undefined ? join(fixtureDir, "tsconfig.json") : resolve(flags.project);

const writeFixture = (): void => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const file of syntheticFixtureFiles()) {
    const path = join(fixtureDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
};

/**
 * One cold build: wall time, and the peak RSS of the process tree sampled while it runs. A run
 * with no valid RSS sample (every `ps` failed, or none held the CLI process) fails the bench.
 */
const coldBuild = async (): Promise<{
  ms: number;
  peakRssKb: number;
  samples: number;
  invalidSamples: number;
}> => {
  const start = performance.now();
  const child = spawn(
    process.execPath,
    [join(packageDir, "src", "cli.ts"), "--tsconfig", tsconfigPath],
    { cwd: packageDir, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; ms: number }>((resolvePromise) => {
    child.on("exit", (code) => resolvePromise({ code, ms: performance.now() - start }));
  });
  if (child.pid === undefined) {
    throw new Error("bench: could not start gratos");
  }
  const peak: PeakRss =
    fixedPeakRssKb === undefined
      ? await samplePeakRss(child.pid, exited, { intervalMs: SAMPLE_INTERVAL_MS })
      : { peakRssKb: fixedPeakRssKb, validSamples: 1, invalidSamples: 0 };
  const { code, ms } = await exited;
  if (code !== 0) {
    throw new Error(`gratos failed on ${tsconfigPath}:\n${stderr}`);
  }
  return {
    ms,
    peakRssKb: requireValidPeak(peak),
    samples: peak.validSamples,
    invalidSamples: peak.invalidSamples,
  };
};

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const runner = {
  platform: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  cores: cpus().length,
  memoryGb: Math.round(totalmem() / 2 ** 30),
  node: process.version,
};

if (flags.project === undefined) {
  writeFixture();
}
// One warm-up run (OS file cache, Node compile cache), not counted.
await coldBuild();
const builds: Array<Awaited<ReturnType<typeof coldBuild>>> = [];
for (let run = 0; run < runs; run++) {
  builds.push(await coldBuild());
}
const files = fileStats(tsconfigPath);
const measured = {
  filesLoaded: files.filesLoaded,
  coldBuildMs: Math.round(median(builds.map((build) => build.ms))),
  peakRssMb: Math.round(median(builds.map((build) => build.peakRssKb)) / 1024),
};

const baseline = existsSync(baselinePath) ? readBaseline(baselinePath) : null;
const versus = (key: keyof typeof measured) =>
  baseline === null ? null : `${Math.round((measured[key] / baseline[key] - 1) * 100)}%`;

const misses = missesOf(measured, bounds);
const result = {
  project:
    flags.project === undefined
      ? `synthetic (${MODEL_COUNT} models)`
      : relative(process.cwd(), tsconfigPath),
  measured,
  targets: TARGETS,
  bounds,
  withinBounds: {
    filesLoaded: measured.filesLoaded <= bounds.filesLoaded,
    coldBuildMs: measured.coldBuildMs <= bounds.coldBuildMs,
    peakRssMb: measured.peakRssMb <= bounds.peakRssMb,
  },
  // Percent deltas against a baseline recorded on another runner class say nothing, and CI is
  // judged on its own bounds (docs/plan.html F3): no deltas in CI.
  versusBaseline:
    baseline === null || isCi
      ? null
      : {
          sameRunnerClass: JSON.stringify(baseline.runner) === JSON.stringify(runner),
          filesLoaded: versus("filesLoaded"),
          coldBuildMs: versus("coldBuildMs"),
          peakRssMb: versus("peakRssMb"),
        },
  runs: builds.map((build) => ({
    ms: Math.round(build.ms),
    peakRssMb: Math.round(build.peakRssKb / 1024),
    samples: build.samples,
    invalidSamples: build.invalidSamples,
  })),
  files,
  runner,
};
const report = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(report);
if (flags.out !== undefined) {
  writeFileSync(resolve(flags.out), report);
}

if (flags.record) {
  writeFileSync(baselinePath, `${JSON.stringify({ runner, ...measured }, null, 2)}\n`);
  process.stderr.write(`bench: recorded ${baselinePath}\n`);
}
if (misses.length > 0) {
  process.stderr.write(
    `bench: outside the spec bounds: ${misses.map((miss) => miss.measure).join(", ")}\n`,
  );
  if (flags["warn-only"]) {
    // Workflow commands are read from stdout.
    for (const miss of misses) {
      process.stdout.write(`${warningCommand(result.project, miss)}\n`);
    }
  }
}
process.exitCode = exitCodeFor(misses, flags["warn-only"]);
