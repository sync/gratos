// { "EXPERIMENTAL__emitResolverMap": true }
import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<string> {
  return Effect.succeed("hello");
}
