import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { dependsOn, serverCore } from "../src/index.ts";

describe("orders-example", () => {
  it.effect("resolves workspace packages from source", () =>
    Effect.gen(function* () {
      const names = yield* Effect.succeed(dependsOn);
      expect(names).toEqual(["@dblechoc/gratos", "@dblechoc/gratos-server"]);
      expect(typeof serverCore).toBe("function");
    }),
  );
});
