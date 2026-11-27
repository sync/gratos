// Which dev-loop bounds apply (support/budget.ts, docs/plan.html F3): the latency budget only when
// CI is unset, the correctness bound everywhere. dev.test.ts asserts whatever this returns.
import { describe, expect, it } from "vitest";

import { CORRECTNESS_BOUND_MS, devLoopBounds, LATENCY_BUDGET_MS } from "./support/budget.ts";

describe("dev-loop bounds", () => {
  it("assert the 2 s latency budget and the 10 s correctness bound when CI is unset", () => {
    expect(LATENCY_BUDGET_MS).toBe(2000);
    expect(CORRECTNESS_BOUND_MS).toBe(10_000);
    expect(devLoopBounds({})).toEqual({
      latencyBudgetMs: 2000,
      correctnessBoundMs: 10_000,
      timingsFile: undefined,
    });
    expect(devLoopBounds({ CI: "" }).latencyBudgetMs).toBe(2000);
  });

  it("only report the latency in CI, whatever its budget is set to", () => {
    expect(devLoopBounds({ CI: "true", GRATOS_DEV_LATENCY_BUDGET_MS: "1" })).toEqual({
      latencyBudgetMs: undefined,
      correctnessBoundMs: 10_000,
      timingsFile: undefined,
    });
  });

  it("take both bounds and the timings file from the environment", () => {
    expect(
      devLoopBounds({
        GRATOS_DEV_LATENCY_BUDGET_MS: "1",
        GRATOS_DEV_CORRECTNESS_BOUND_MS: "2.5",
        GRATOS_DEV_TIMINGS_FILE: "/tmp/timings.json",
      }),
    ).toEqual({ latencyBudgetMs: 1, correctnessBoundMs: 2.5, timingsFile: "/tmp/timings.json" });
    expect(
      devLoopBounds({ CI: "true", GRATOS_DEV_CORRECTNESS_BOUND_MS: "1" }).correctnessBoundMs,
    ).toBe(1);
  });

  it.each(["0", "-1", "1e3", "abc", "Infinity", " 5"])("reject a bound of %j", (raw) => {
    expect(() => devLoopBounds({ GRATOS_DEV_CORRECTNESS_BOUND_MS: raw })).toThrow(
      /GRATOS_DEV_CORRECTNESS_BOUND_MS must be a positive number of milliseconds/,
    );
  });
});
