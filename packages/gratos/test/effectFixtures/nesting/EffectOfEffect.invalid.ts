import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<Effect.Effect<string>> {
  return Effect.succeed(Effect.succeed("hi"));
}
