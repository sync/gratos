import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { packageName } from "../src/index.ts";

describe("@gratos/grats", () => {
  it.effect("runs an Effect test", () =>
    Effect.gen(function* () {
      const name = yield* Effect.succeed(packageName);
      expect(name).toBe("@gratos/grats");
    }),
  );
});
