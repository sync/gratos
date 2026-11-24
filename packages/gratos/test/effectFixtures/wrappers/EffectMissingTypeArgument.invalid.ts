import type { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect {
  throw new Error("not called");
}
