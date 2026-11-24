import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<undefined | (Promise<string>)> {
  return Effect.succeed(undefined);
}
