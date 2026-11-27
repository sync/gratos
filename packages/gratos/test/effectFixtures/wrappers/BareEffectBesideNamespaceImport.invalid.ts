import * as Fx from "effect/Effect";

/** @gqlQueryField */
export function greeting(): Effect<string> {
  return Fx.succeed("hi");
}
