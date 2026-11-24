import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    resolve: {
      alias: [
        // graphql 16 resolves to its ESM build (index.mjs) under vite, but the engine's deep
        // imports ("graphql/language/parser.js") would load the CJS build: two GraphQLError
        // classes, so instanceof checks fail. Keep every graphql import on the ESM build.
        { find: /^graphql\/(.+)\.js$/, replacement: "graphql/$1.mjs" },
      ],
    },
    test: { testTimeout: 60_000 },
  }),
);
