import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.ts";

// The dev-loop tests run real processes, with several restarts each, and measure save-to-response
// time: the test files run one at a time so they never compete with each other for the CPU (turbo
// also runs this package's tests after the compiler's and the server's suites).
export default mergeConfig(
  shared,
  defineConfig({ test: { testTimeout: 60_000, fileParallelism: false } }),
);
