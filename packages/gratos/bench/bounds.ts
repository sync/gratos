// The compiler bench's targets and bounds (docs/plan.html M3, amended by F3), and the GitHub
// workflow commands the informational bench job prints.
//
// The targets are the spec's, measured locally. CI allows +20%, because shared runners are noisy.
// Files loaded is the same on every machine: it is a required test (test/filesLoaded.test.ts).
// Cold build and peak RSS are reported numbers in CI (the bench job), never a gate: in warn-only
// mode a miss is a `::warning::` and exit 0. A crash still fails.

/** Spec targets (local). */
export const TARGETS = { filesLoaded: 530, coldBuildMs: 900, peakRssMb: 380 } as const;
export const CI_TOLERANCE = 1.2;
/** M6's save-to-first-good-response budget (2 s) +50%: the dev loop's CI bound, reported only. */
export const DEV_LOOP_CI_BOUND_MS = 3000;

export const MEASURES = ["filesLoaded", "coldBuildMs", "peakRssMb"] as const;
export type Measure = (typeof MEASURES)[number];

export interface Numbers {
  readonly filesLoaded: number;
  readonly coldBuildMs: number;
  readonly peakRssMb: number;
}

const isMeasure = (name: string): name is Measure => MEASURES.some((measure) => measure === name);

/**
 * The bounds: the targets, +20% in CI, then each `<measure>=<number>` override as given (how a
 * run with a lowered bound is shown). An unknown measure or a value that is not a positive number
 * throws.
 */
export const boundsFor = (isCi: boolean, overrides: ReadonlyArray<string> = []): Numbers => {
  const scale = isCi ? CI_TOLERANCE : 1;
  const bounds = {
    filesLoaded: TARGETS.filesLoaded * scale,
    coldBuildMs: TARGETS.coldBuildMs * scale,
    peakRssMb: TARGETS.peakRssMb * scale,
  };
  for (const override of overrides) {
    const match = /^(\w+)=(\d+(?:\.\d+)?)$/.exec(override);
    const name = match?.[1];
    const value = Number(match?.[2]);
    if (name === undefined || !isMeasure(name) || !(value > 0)) {
      throw new Error(
        `bench: --bound takes <measure>=<positive number> with a measure among ${MEASURES.join(", ")}, got ${JSON.stringify(override)}`,
      );
    }
    bounds[name] = value;
  }
  return bounds;
};

export interface Miss {
  readonly measure: string;
  readonly value: number;
  readonly bound: number;
}

/** Every measure above its bound. */
export const missesOf = (measured: Numbers, bounds: Numbers): ReadonlyArray<Miss> =>
  MEASURES.flatMap((measure) =>
    measured[measure] > bounds[measure]
      ? [{ measure, value: measured[measure], bound: bounds[measure] }]
      : [],
  );

/** A workflow command's message, escaped as the runner expects (`%`, CR and LF). */
const escapeData = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** A `::warning::` workflow command for one miss: an annotation on the run, not a failure. */
export const warningCommand = (subject: string, miss: Miss): string =>
  `::warning title=bench::${escapeData(
    `${subject}: ${miss.measure} ${miss.value} is above the bound ${miss.bound}`,
  )}`;

/** The exit code of a finished bench: a miss fails it, unless it only warns. */
export const exitCodeFor = (misses: ReadonlyArray<Miss>, warnOnly: boolean): number =>
  misses.length > 0 && !warnOnly ? 1 : 0;
