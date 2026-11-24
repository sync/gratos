import { Effect } from "effect";

/** @gqlQueryField */
export function greetings(): ReadonlyArray<Effect.Effect<string>> {
  return [Effect.succeed("hi")];
}
