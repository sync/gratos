import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<Effect.Effect<string> | null> {
  return Effect.succeed(null);
}
