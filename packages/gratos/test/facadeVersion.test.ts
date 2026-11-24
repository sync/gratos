// Which `#typescript` implementation a run uses: TypeScript 7 by default, TypeScript 5.9.2 in the
// parity run (vitest.parity.config.ts sets GRATOS_FACADE=ts5). The engine sees the same facade.
import { describe, expect, it } from "vitest";

import { version } from "#typescript";

describe("the #typescript facade", () => {
  it("is the implementation this run asked for", () => {
    expect(version).toBe(process.env["GRATOS_FACADE"] === "ts5" ? "5.9.2" : "7.0.2");
  });
});
