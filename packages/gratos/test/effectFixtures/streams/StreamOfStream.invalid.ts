import { Stream } from "effect";

/** Each event would be a Stream, which GraphQL cannot iterate. */
/** @gqlSubscriptionField */
export function names(): Stream.Stream<Stream.Stream<string>> {
  return Stream.make(Stream.make("Ada"));
}
