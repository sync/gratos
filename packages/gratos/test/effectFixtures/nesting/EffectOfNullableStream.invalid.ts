import { Effect, Stream } from "effect";

/** @gqlQueryField */
export function greetings(): Effect.Effect<Stream.Stream<string> | null> {
  return Effect.succeed(null);
}
