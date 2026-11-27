// Files loaded on the bench's synthetic 300-model fixture (docs/plan.html M3, made a test by F3).
// The count is the same on every machine, so it belongs in the required check, not in the timing
// bench. It runs on TypeScript 7 only: the parity run (vitest.parity.config.ts) swaps in the
// TypeScript 5.9.2 facade, which loads files differently, and does not include this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TARGETS } from "../bench/bounds.ts";
import {
  fileStats,
  readBaseline,
  SYNTHETIC_BASELINE,
  syntheticFixtureFiles,
} from "../bench/fixture.ts";
import { scratchProject } from "./support/scratch.ts";
import type { ScratchProject } from "./support/scratch.ts";

describe("files loaded on the synthetic 300-model fixture", () => {
  let project: ScratchProject | undefined;
  let filesLoaded = 0;

  beforeAll(() => {
    project = scratchProject("files-loaded");
    for (const file of syntheticFixtureFiles()) {
      project.write(file.path, file.content);
    }
    filesLoaded = fileStats(project.path("tsconfig.json")).filesLoaded;
  });

  afterAll(() => {
    project?.remove();
  });

  it(`stays within the plan's bound (≤ ${TARGETS.filesLoaded} files, third-party files read as empty)`, () => {
    expect(filesLoaded).toBeLessThanOrEqual(TARGETS.filesLoaded);
  });

  it("matches the baseline recorded in bench/baseline.json", () => {
    // A dependency upgrade can change it: re-record with `pnpm --filter @dblechoc/gratos bench
    // --record` (which also records the timings of the machine it runs on).
    expect(filesLoaded).toBe(readBaseline(SYNTHETIC_BASELINE).filesLoaded);
  });
});
