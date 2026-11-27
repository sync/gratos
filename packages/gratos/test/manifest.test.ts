// The peers of the published manifest (docs/plan.html F7). pnpm packs a `catalog:` specifier as
// the catalog's exact version, so a `catalog:` peer would publish as one exact version and give
// apps a second copy of the library. Every peer is a literal caret range instead, and the
// workspace still installs the catalog's pin of it, as a devDependency (the canary moves that).
import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

const devDependencies = new Map<string, string>(Object.entries(packageJson.devDependencies));

describe("the published peers", () => {
  it.each(Object.entries(packageJson.peerDependencies))(
    "%s is a caret range, installed from the catalog in the workspace",
    (name, range) => {
      expect(range).toMatch(/^\^\d+\.\d+\.\d+$/);
      expect(devDependencies.get(name)).toBe("catalog:");
    },
  );
});
