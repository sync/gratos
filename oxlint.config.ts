import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "**/src/generated/**",
    "packages/grats/llm-docs/**",
    "packages/grats/src/upstream/**",
    "packages/grats/test/fixtures/**",
    "packages/grats/test/integrationFixtures/**",
    ".agents/**",
  ],
});
