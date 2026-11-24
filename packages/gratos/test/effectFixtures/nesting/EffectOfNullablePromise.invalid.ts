import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<Promise<string> | null> {
  return Effect.succeed(null);
}
