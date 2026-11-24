// The Schema decoder for the `grats` config (src/effect/config.ts) agrees with upstream's spec
// and validator: the same options, the same defaults, and on every config parser fixture the
// same accepted config or a rejection.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  decodeGratsConfig,
  DEFAULT_GRATS_CONFIG,
  GratsConfigInput,
  GratsConfigSchema,
} from "../src/effect/config.ts";
import { GratsConfigSpec } from "../src/upstream/configSpec.ts";
import { validateGratsOptions } from "../src/upstream/gratsConfig.ts";

const fixturesDir = join(import.meta.dirname, "configParserFixtures");
const fixtures = readdirSync(fixturesDir).filter((file) => file.endsWith(".json"));

/** Upstream's validator on a raw `grats` value, with its console warnings captured. */
const upstream = (grats: unknown) => {
  const warnings: Array<string> = [];
  const warn = vi.spyOn(globalThis.console, "warn").mockImplementation((message: string) => {
    warnings.push(message);
  });
  try {
    const result = validateGratsOptions({ options: {}, raw: { grats }, errors: [], fileNames: [] });
    return { result, warnings };
  } finally {
    warn.mockRestore();
  }
};

describe("grats config schema", () => {
  it("has exactly upstream's options", () => {
    const specKeys = Object.keys(GratsConfigSpec.properties).toSorted();
    expect(Object.keys(GratsConfigInput.fields).toSorted()).toEqual(specKeys);
    expect(Object.keys(GratsConfigSchema.fields).toSorted()).toEqual(specKeys);
  });

  it("has upstream's defaults", () => {
    const parsed = upstream({}).result;
    expect(parsed.kind).toBe("OK");
    expect(parsed.kind === "OK" ? parsed.value.raw.grats : null).toEqual(DEFAULT_GRATS_CONFIG);
  });

  for (const fixture of fixtures) {
    it(`agrees with upstream's validator on ${fixture}`, () => {
      const text = readFileSync(join(fixturesDir, fixture), "utf8");
      const ours = decodeGratsConfig(JSON.stringify({ grats: JSON.parse(text) }));
      const theirs = upstream(JSON.parse(text));
      if (theirs.result.kind === "ERROR") {
        expect(Result.isFailure(ours)).toBe(true);
        return;
      }
      expect(Result.isSuccess(ours)).toBe(true);
      if (Result.isSuccess(ours)) {
        expect(ours.success.config).toEqual(theirs.result.value.raw.grats);
        expect(ours.success.warnings).toEqual(
          theirs.warnings.map((warning) => warning.replace(/^Grats:/, "Gratos:")),
        );
      }
    });
  }

  it("reads JSON with comments and trailing commas, and only the top-level grats key", () => {
    const decoded = decodeGratsConfig(`{
      // a comment
      "extends": "./base.json",
      "compilerOptions": { "strict": true, },
      "grats": { "nullableByDefault": false, "schemaHeader": ["# a", "# b"], },
    }`);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.config.nullableByDefault).toBe(false);
      expect(decoded.success.config.schemaHeader).toBe("# a\n# b");
      expect(decoded.success.config.graphqlSchema).toBe("./schema.graphql");
    }
  });
});
