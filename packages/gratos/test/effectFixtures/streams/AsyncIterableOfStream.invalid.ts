import { Stream } from "effect";

/** Each event would be a Stream, which GraphQL cannot iterate. */
/** @gqlSubscriptionField */
export async function* names(): AsyncIterable<Stream.Stream<string>> {
  yield Stream.make("Ada");
}
