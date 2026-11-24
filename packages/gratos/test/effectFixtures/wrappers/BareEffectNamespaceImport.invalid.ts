import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect<string> {
  return Effect.succeed("hi");
}
