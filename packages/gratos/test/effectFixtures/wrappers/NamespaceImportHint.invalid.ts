// A namespace import of `effect/Effect` under another name gets the hint toward `Effect.Effect`.
import * as Fx from "effect/Effect";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  return Fx.succeed("hi");
}
