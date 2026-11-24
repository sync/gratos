import { Effect } from "effect";

/** @gqlQueryField */
export function greetings(): Effect.Effect<string>[] {
  return [Effect.succeed("hi")];
}
