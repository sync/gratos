// Peak RSS of a process tree (bench/run.ts), sampled with `ps` while the process runs.
//
// A sample counts only when `ps` exits 0 and its table holds the sampled process itself: a
// failed `ps`, or one taken after the process exited, says nothing about its memory and must not
// read as 0 kB. A run with no valid sample is an error, not a peak of 0.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
}

/** The command that prints every process as `pid ppid rss(kB)` lines (macOS and Linux). */
export const PS_COMMAND: ReadonlyArray<string> = ["ps", "-A", "-o", "pid=,ppid=,rss="];

/** The rows of `ps -o pid=,ppid=,rss=` output; lines that are not three numbers are skipped. */
export const parseProcessTable = (output: string): Array<ProcessRow> =>
  output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((fields) => fields.length === 3 && fields.every(Number.isFinite))
    .map(([pid = 0, ppid = 0, rssKb = 0]) => ({ pid, ppid, rssKb }));

/** Every process, from one run of `command`, or `null` when it fails to start or exits non-zero. */
export const processTable = (
  command: ReadonlyArray<string> = PS_COMMAND,
): Promise<Array<ProcessRow> | null> =>
  new Promise((resolvePromise) => {
    const [file = "ps", ...args] = command;
    const ps = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    ps.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    ps.on("error", () => resolvePromise(null));
    ps.on("close", (code) => resolvePromise(code === 0 ? parseProcessTable(output) : null));
  });

/** Total RSS (kB) of `root` and all its descendants, or `null` when `root` is not in the table. */
export const treeRssKb = (root: number, table: ReadonlyArray<ProcessRow>): number | null => {
  if (!table.some((row) => row.pid === root)) {
    return null;
  }
  const tree = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  return table.filter((row) => tree.has(row.pid)).reduce((sum, row) => sum + row.rssKb, 0);
};

export interface PeakRss {
  readonly peakRssKb: number;
  /** Samples whose `ps` succeeded and held the process. */
  readonly validSamples: number;
  /** Samples whose `ps` failed, or that no longer held the process. */
  readonly invalidSamples: number;
}

/**
 * Samples the RSS of `pid`'s process tree every `intervalMs` until `stopped` resolves, and
 * returns its peak over the valid samples.
 */
export const samplePeakRss = async (
  pid: number,
  stopped: Promise<unknown>,
  options: { readonly intervalMs: number; readonly command?: ReadonlyArray<string> },
): Promise<PeakRss> => {
  let running = true;
  void stopped.then(() => {
    running = false;
  });
  let peakRssKb = 0;
  let validSamples = 0;
  let invalidSamples = 0;
  while (running) {
    const table = await processTable(options.command);
    const rss = table === null ? null : treeRssKb(pid, table);
    if (rss === null) {
      invalidSamples += 1;
    } else {
      peakRssKb = Math.max(peakRssKb, rss);
      validSamples += 1;
    }
    await sleep(options.intervalMs);
  }
  return { peakRssKb, validSamples, invalidSamples };
};

/** The peak, or an error when no sample was valid (a peak of 0 kB would pass any bound). */
export const requireValidPeak = (peak: PeakRss): number => {
  if (peak.validSamples === 0) {
    throw new Error(
      `bench: no valid RSS sample of the gratos process tree (${peak.invalidSamples} failed or missed the process)`,
    );
  }
  return peak.peakRssKb;
};
