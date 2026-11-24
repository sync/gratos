// Parity bar (b) of docs/plan.html: the same fixture suite, run on the TypeScript 5.9.2 facade.
//
// `#typescript` normally resolves to the TypeScript 7 port (src/ts/index.ts, package.json
// `imports`). Here it is aliased to src/ts/ts5.js, a pass-through to the `typescript-baseline`
// devDependency, so the same engine code and the same snapshots are checked on both TypeScripts.
// It runs after the default config (see the `test` script) because the integration fixtures
// write their generated schema.ts next to the fixture.
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "#typescript": fileURLToPath(new URL("src/ts/ts5.js", import.meta.url)) },
  },
  test: {
    name: "ts5",
    include: ["test/upstreamFixtures.test.ts", "test/facadeVersion.test.ts"],
    env: { GRATOS_FACADE: "ts5" },
    passWithNoTests: false,
    testTimeout: 60_000,
  },
});
