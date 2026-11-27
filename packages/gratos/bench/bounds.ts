// The compiler bench's targets and bounds (docs/plan.html M3, amended by F3).
//
// The targets are the spec's, measured locally. CI allows +20%, because shared runners are noisy.
// Files loaded is the same on every machine: it is a required test (test/filesLoaded.test.ts).
// Cold build and peak RSS are reported numbers in CI (the informational bench job), never a gate.

/** Spec targets (local). */
export const TARGETS = { filesLoaded: 530, coldBuildMs: 900, peakRssMb: 380 } as const;
export const CI_TOLERANCE = 1.2;

export type Measure = keyof typeof TARGETS;
