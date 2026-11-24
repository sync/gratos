import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<Promise<string>> {
  return Effect.succeed(Promise.resolve("hi"));
}
