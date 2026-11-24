import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "**/src/generated/**",
    "packages/gratos/llm-docs/**",
    "packages/gratos/src/upstream/**",
    "packages/gratos/test/fixtures/**",
    "packages/gratos/test/integrationFixtures/**",
    ".agents/**",
  ],
});
