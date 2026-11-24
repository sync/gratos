import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(name: Effect.Effect<string>): string {
  return "hi";
}
