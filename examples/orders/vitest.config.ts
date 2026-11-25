import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.ts";

// The dev-loop tests run real processes, with several restarts each.
export default mergeConfig(shared, defineConfig({ test: { testTimeout: 60_000 } }));
