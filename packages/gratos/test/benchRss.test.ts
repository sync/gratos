// The bench's process-tree RSS sampler (bench/rss.ts): a failed `ps`, or a table without the
// sampled process, is not a sample, and a run without a valid sample fails instead of reporting
// a peak RSS of 0 (which would pass any bound).
import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import {
  parseProcessTable,
  processTable,
  requireValidPeak,
  samplePeakRss,
  treeRssKb,
} from "../bench/rss.ts";

/** A Node process that lives until killed, and the promise of its exit. */
const sleeper = () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  return { child, exited };
};

describe("bench RSS sampler", () => {
  it("reads a failed ps as no table, not as an empty one", async () => {
    expect(await processTable(["false"])).toBeNull();
    expect(await processTable(["/nonexistent/ps"])).toBeNull();
    const table = await processTable();
    expect(table?.some((row) => row.pid === process.pid)).toBe(true);
  });

  it("has no tree RSS for a process missing from the table", () => {
    const table = parseProcessTable(" 10 1 100\n 11 10 50\n 12 99 7\n");
    expect(treeRssKb(10, table)).toBe(150);
    expect(treeRssKb(42, table)).toBeNull();
  });

  it("fails a run whose every sample failed, instead of a peak of 0", async () => {
    const { child, exited } = sleeper();
    setTimeout(() => child.kill(), 100);
    const peak = await samplePeakRss(child.pid ?? -1, exited, {
      intervalMs: 5,
      command: ["false"],
    });
    expect(peak.validSamples).toBe(0);
    expect(peak.invalidSamples).toBeGreaterThan(0);
    expect(() => requireValidPeak(peak)).toThrow("no valid RSS sample");
  });

  it("takes the peak over valid samples of the live process", async () => {
    const { child, exited } = sleeper();
    setTimeout(() => child.kill(), 300);
    const peak = await samplePeakRss(child.pid ?? -1, exited, { intervalMs: 5 });
    expect(peak.validSamples).toBeGreaterThan(0);
    expect(requireValidPeak(peak)).toBeGreaterThan(1024);
  });
});
