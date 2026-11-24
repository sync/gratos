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
    "packages/gratos/test/configParserFixtures/**",
    ".agents/**",
  ],
  overrides: [
    {
      // The TypeScript facade implements TypeScript 5's API over TypeScript 7 nodes. Node fields
      // that exist on one version only (jsDoc, postfixToken, name, initializer…) are read by name,
      // and a few TypeScript 7 factory parameters are typed narrower than the nodes accept. These
      // rules are off for that boundary only; everything else in src/ts stays fully linted.
      files: ["packages/gratos/src/ts/**"],
      rules: {
        "quality/no-reflect-get": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "quality/no-unsafe-dictionary-type": "off",
        "quality/no-unknown-returns": "off",
      },
    },
  ],
});
