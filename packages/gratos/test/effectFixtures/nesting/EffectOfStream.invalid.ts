import { Effect, Stream } from "effect";

/** @gqlSubscriptionField */
export function greetings(): Effect.Effect<Stream.Stream<string>> {
  return Effect.succeed(Stream.make("hi"));
}
