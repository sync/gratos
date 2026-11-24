import { Effect } from "effect";

/** @gqlQueryField */
export function greetings(): Array<Effect.Effect<string>> {
  return [Effect.succeed("hi")];
}
