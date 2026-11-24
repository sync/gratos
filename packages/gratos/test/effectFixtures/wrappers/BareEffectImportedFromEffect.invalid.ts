import type { Effect } from "effect/Effect";

/** @gqlQueryField */
export function greeting(): Effect<string> {
  throw new Error("not called");
}
