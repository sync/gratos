// `pnpm --filter @dblechoc/gratos bench`: cold build of a synthetic 300-model project with the
// `gratos` CLI, compared with the committed baseline (bench/baseline.json at the repo root).
//
// It writes the fixture to bench/.fixture/ (gitignored): 300 @gqlType classes with Promise
// fields and @gqlQueryField functions, each importing effect, @effect/platform-node and graphql,
// so fast loading really blanks third-party files. It then runs the CLI in fresh Node processes
// (each spawns its own tsgo, so every run is a cold build) and records, per docs/plan.html M3:
//
// - files loaded: the program's source files, with third-party files read as empty;
// - cold build ms: wall time of one `gratos` process, from spawn to exit;
// - peak RSS: sampled over the whole process tree (Node plus the tsgo child), because the Go
//   child is not counted in Node's maxRSS (bench/rss.ts). Each run needs at least one valid
//   sample: one whose `ps` succeeded and held the CLI process.
//
// `--record` writes the result as the new baseline, with the runner class it was measured on.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { getParsedCommandLineOfConfigFile } from "../src/ts/program.ts";
import { closeDefaultSessions } from "../src/ts/session.ts";

import { requireValidPeak, samplePeakRss } from "./rss.ts";

const MODEL_COUNT = 300;
const RUNS = 5;
/** Spec targets (local). CI allows +20%, because shared runners are noisy. */
const TARGETS = { filesLoaded: 530, coldBuildMs: 900, peakRssMb: 380 } as const;
const CI_TOLERANCE = 1.2;
const SAMPLE_INTERVAL_MS = 5;

const packageDir = join(import.meta.dirname, "..");
const baselinePath = join(packageDir, "..", "..", "bench", "baseline.json");
const fixtureDir = join(import.meta.dirname, ".fixture");
const modelsDir = join(fixtureDir, "models");

const model = (index: number): string => {
  const next = index + 1 < MODEL_COUNT ? `Model${index + 1}` : null;
  return `import type { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import type { GraphQLResolveInfo } from "graphql";
import type { Int } from "@dblechoc/gratos";
${next === null ? "" : `import { ${next} } from "./${next}.ts";\n`}
/** Model number ${index}. */
/** @gqlType */
export class Model${index} {
  /** @gqlField */
  id: string;
  /** @gqlField */
  rank: Int;
  /** @gqlField */
  active: boolean;

  constructor(id: string, rank: Int) {
    this.id = id;
    this.rank = rank;
    this.active = rank % 2 === 0;
  }

  /** @gqlField */
  async label(): Promise<string> {
    return \`model-\${this.id}\`;
  }
${
  next === null
    ? ""
    : `
  /** @gqlField */
  async next(): Promise<${next}> {
    return new ${next}(\`\${this.id}+\`, this.rank + 1);
  }
`
}}

/** @gqlQueryField */
export async function model${index}(): Promise<Model${index}> {
  return new Model${index}("${index}", ${index});
}

export const load${index} = Effect.succeed(new Model${index}("${index}", ${index}));
export type Runtime${index} = typeof NodeRuntime;
export type Info${index} = GraphQLResolveInfo;
`;
};

const writeFixture = (): void => {
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          lib: ["es2022"],
          module: "nodenext",
          moduleResolution: "nodenext",
          types: ["node"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
        include: ["models/**/*.ts"],
        grats: { importModuleSpecifierEnding: ".ts", schemaHeader: null, tsSchemaHeader: null },
      },
      null,
      2,
    )}\n`,
  );
  for (let index = 0; index < MODEL_COUNT; index++) {
    writeFileSync(join(modelsDir, `Model${index}.ts`), model(index));
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
    [join(packageDir, "src", "cli.ts"), "--tsconfig", join(fixtureDir, "tsconfig.json")],
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
  const peak = await samplePeakRss(child.pid, exited, { intervalMs: SAMPLE_INTERVAL_MS });
  const { code, ms } = await exited;
  if (code !== 0) {
    throw new Error(`gratos failed on the bench fixture:\n${stderr}`);
  }
  return {
    ms,
    peakRssKb: requireValidPeak(peak),
    samples: peak.validSamples,
    invalidSamples: peak.invalidSamples,
  };
};

const fileStats = () => {
  const parsed = getParsedCommandLineOfConfigFile(join(fixtureDir, "tsconfig.json"));
  const { session, project } = parsed.program;
  const programFiles = project.program.getSourceFileNames();
  const stats = {
    /** The spec's "files loaded": every source file in the program. */
    filesLoaded: programFiles.length,
    libFiles: programFiles.filter(
      (fileName) => project.program.getSourceFileMetadata(fileName)?.isDefaultLibrary,
    ).length,
    filesRead: session.filesRead.size,
    blankedFiles: programFiles.filter((fileName) => session.blanked.has(fileName)).length,
    fullyLoadedFiles: programFiles.filter((fileName) => !session.blanked.has(fileName)).length,
  };
  closeDefaultSessions();
  return stats;
};

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const Baseline = Schema.Struct({
  runner: Schema.Struct({
    platform: Schema.String,
    cpu: Schema.String,
    cores: Schema.Number,
    memoryGb: Schema.Number,
    node: Schema.String,
  }),
  filesLoaded: Schema.Number,
  coldBuildMs: Schema.Number,
  peakRssMb: Schema.Number,
});

const runner = {
  platform: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  cores: cpus().length,
  memoryGb: Math.round(totalmem() / 2 ** 30),
  node: process.version,
};

writeFixture();
// One warm-up run (OS file cache, Node compile cache), not counted.
await coldBuild();
const builds: Array<Awaited<ReturnType<typeof coldBuild>>> = [];
for (let run = 0; run < RUNS; run++) {
  builds.push(await coldBuild());
}
const files = fileStats();
const measured = {
  filesLoaded: files.filesLoaded,
  coldBuildMs: Math.round(median(builds.map((build) => build.ms))),
  peakRssMb: Math.round(median(builds.map((build) => build.peakRssKb)) / 1024),
};

const isCi = process.env["CI"] !== undefined && process.env["CI"] !== "";
const bounds = Object.fromEntries(
  Object.entries(TARGETS).map(([key, target]) => [key, isCi ? target * CI_TOLERANCE : target]),
);
const baseline = existsSync(baselinePath)
  ? Schema.decodeUnknownSync(Baseline)(JSON.parse(readFileSync(baselinePath, "utf8")))
  : null;
const versus = (key: keyof typeof measured) =>
  baseline === null ? null : `${Math.round((measured[key] / baseline[key] - 1) * 100)}%`;

const result = {
  models: MODEL_COUNT,
  measured,
  targets: TARGETS,
  bounds,
  withinBounds: {
    filesLoaded: measured.filesLoaded <= (bounds["filesLoaded"] ?? 0),
    coldBuildMs: measured.coldBuildMs <= (bounds["coldBuildMs"] ?? 0),
    peakRssMb: measured.peakRssMb <= (bounds["peakRssMb"] ?? 0),
  },
  versusBaseline:
    baseline === null
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
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (process.argv.includes("--record")) {
  writeFileSync(baselinePath, `${JSON.stringify({ runner, ...measured }, null, 2)}\n`);
  process.stderr.write(`bench: recorded ${baselinePath}\n`);
}
const misses = Object.entries(result.withinBounds).filter(([, within]) => !within);
if (misses.length > 0) {
  process.stderr.write(
    `bench: outside the spec bounds: ${misses.map(([key]) => key).join(", ")}\n`,
  );
  process.exitCode = 1;
}
