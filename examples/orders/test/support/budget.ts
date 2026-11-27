// The dev loop's time bounds (docs/plan.html M6, amended by F3): behaviour is required, latency
// is reported.
//
// - The correctness bound (10 s) is asserted everywhere: a save that is never answered, or only
//   after a stall, fails the required check.
// - The latency budget (2 s save-to-first-good-response) is asserted only when CI is unset. A
//   shared runner missed it twice in one run with no code change, so in CI the latency is
//   measured and reported by the informational bench job instead (.github/workflows/ci.yml):
//   dev.test.ts writes its timings to the file named by GRATOS_DEV_TIMINGS_FILE.
//
// Both can be overridden through the environment, which is how the split itself is checked:
// GRATOS_DEV_LATENCY_BUDGET_MS and GRATOS_DEV_CORRECTNESS_BOUND_MS.

export const LATENCY_BUDGET_MS = 2000;
export const CORRECTNESS_BOUND_MS = 10_000;

export interface DevLoopBounds {
  /** Save-to-first-good-response, asserted; `undefined` in CI, where it is only reported. */
  readonly latencyBudgetMs: number | undefined;
  /** Save-to-first-good-response, asserted everywhere. */
  readonly correctnessBoundMs: number;
  /** Where to write the timings, if anywhere. */
  readonly timingsFile: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

const milliseconds = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (!isSet(raw)) {
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !(value > 0)) {
    throw new Error(
      `${name} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
};

export const devLoopBounds = (env: Env): DevLoopBounds => ({
  latencyBudgetMs: isSet(env["CI"])
    ? undefined
    : milliseconds(env, "GRATOS_DEV_LATENCY_BUDGET_MS", LATENCY_BUDGET_MS),
  correctnessBoundMs: milliseconds(env, "GRATOS_DEV_CORRECTNESS_BOUND_MS", CORRECTNESS_BOUND_MS),
  timingsFile: isSet(env["GRATOS_DEV_TIMINGS_FILE"]) ? env["GRATOS_DEV_TIMINGS_FILE"] : undefined,
});

/** One measured save-to-first-good-response. */
export interface DevLoopTiming {
  readonly name: string;
  readonly ms: number;
}

/** The file the bench job reads (packages/gratos/bench/report.ts). */
export const timingsReport = (timings: ReadonlyArray<DevLoopTiming>): string =>
  `${JSON.stringify({ timings }, null, 2)}\n`;
