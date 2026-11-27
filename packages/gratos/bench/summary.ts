// The bench job's summary (docs/plan.html F3): the compiler's cold build and peak RSS from
// bench/run.ts, and the dev loop's save-to-first-good-response from examples/orders'
// dev.test.ts, each against the plan's CI bound. Pure, so test/benchReport.test.ts checks it;
// bench/report.ts reads the files and prints it.
import { Schema } from "effect";

import { warningCommand } from "./bounds.ts";
import type { Miss } from "./bounds.ts";

const Numbers = Schema.Struct({
  filesLoaded: Schema.Number,
  coldBuildMs: Schema.Number,
  peakRssMb: Schema.Number,
});

/** What bench/run.ts writes with `--out` (the fields the summary reads). */
export const BuildResult = Schema.Struct({
  project: Schema.String,
  measured: Numbers,
  bounds: Numbers,
});
export type BuildResult = typeof BuildResult.Type;

/** What examples/orders/test/dev.test.ts writes to GRATOS_DEV_TIMINGS_FILE. */
export const DevTimings = Schema.Struct({
  timings: Schema.Array(Schema.Struct({ name: Schema.String, ms: Schema.Number })),
});
export type DevTimings = typeof DevTimings.Type;

/** An input that could not be read: its step crashed, or wrote something else. */
export interface Missing {
  readonly file: string;
  readonly reason: string;
}

export type Input<A> =
  | { readonly ok: true; readonly value: A }
  | ({ readonly ok: false } & Missing);

/** Every dev-loop timing above the bound. */
export const devMisses = (dev: DevTimings, boundMs: number): ReadonlyArray<Miss> =>
  dev.timings.flatMap((timing) =>
    timing.ms > boundMs ? [{ measure: timing.name, value: timing.ms, bound: boundMs }] : [],
  );

const cell = (value: number, bound: number): string =>
  value > bound ? `**${value}** ⚠️ (bound ${bound})` : `${value} (bound ${bound})`;

const missingRow = (missing: Missing, columns: number): string =>
  `| \`${missing.file}\` | ${["not measured", ...Array.from({ length: columns - 2 }, () => "")].join(" | ")} |`;

export interface Summary {
  /** The Markdown for the job summary. */
  readonly markdown: string;
  /** `::warning::` commands for the dev loop (bench/run.ts prints the compiler's own). */
  readonly warnings: ReadonlyArray<string>;
  /** False when an input is missing: the report then fails its step. */
  readonly complete: boolean;
}

export const summarize = (
  builds: ReadonlyArray<Input<BuildResult>>,
  dev: Input<DevTimings>,
  devBoundMs: number,
): Summary => {
  const lines = [
    "## Bench (informational)",
    "",
    "Measured on this runner, against the plan's CI bounds. A number above its bound is a",
    "warning, never a failed check: the `ci` check does not wait for this job.",
    "",
    "### Compiler: cold build and peak RSS",
    "",
    "| Project | Cold build (ms) | Peak RSS (MB) | Files loaded |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const build of builds) {
    lines.push(
      build.ok
        ? `| ${build.value.project} | ${cell(build.value.measured.coldBuildMs, build.value.bounds.coldBuildMs)} | ${cell(build.value.measured.peakRssMb, build.value.bounds.peakRssMb)} | ${build.value.measured.filesLoaded} |`
        : missingRow(build, 4),
    );
  }
  lines.push(
    "",
    "### Dev loop: save to first good response (examples/orders)",
    "",
    "| Step | ms |",
    "| --- | ---: |",
  );
  if (dev.ok) {
    for (const timing of dev.value.timings) {
      lines.push(`| ${timing.name} | ${cell(timing.ms, devBoundMs)} |`);
    }
  } else {
    lines.push(missingRow(dev, 2));
  }
  const missing = [...builds, dev].filter((input) => !input.ok);
  for (const input of missing) {
    if (!input.ok) {
      lines.push("", `\`${input.file}\` was not read: ${input.reason}`);
    }
  }
  return {
    markdown: `${lines.join("\n")}\n`,
    warnings: dev.ok
      ? devMisses(dev.value, devBoundMs).map((miss) => warningCommand("dev loop", miss))
      : [],
    complete: missing.length === 0,
  };
};
