import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { dependsOn } from "../src/index.ts";

describe("orders-example", () => {
  it.effect("resolves workspace packages from source", () =>
    Effect.gen(function* () {
      const names = yield* Effect.succeed(dependsOn);
      expect(names).toEqual(["@gratos/grats", "@gratos/server"]);
    }),
  );
});
