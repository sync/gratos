// The subscription-throughput bench (bench/subscriptions.ts) still runs: each variant delivers
// every event, in both modes, through the app's own server. Its numbers are not checked here (a
// shared CI runner is too noisy for them); `pnpm bench:subscriptions` reports them.
import { describe, expect, it } from "vitest";

import { measure } from "../bench/subscriptions.ts";

describe("bench:subscriptions", () => {
  it.each([
    ["effect", "burst"],
    ["plain", "burst"],
    ["effect", "paced"],
    ["plain", "paced"],
  ] as const)("delivers every event (%s source, %s)", async (variant, mode) => {
    const run = await measure(variant, mode, 50);
    expect(run).toMatchObject({ variant, mode, events: 50 });
    expect(run.eventsPerSecond).toBeGreaterThan(0);
  });
});
