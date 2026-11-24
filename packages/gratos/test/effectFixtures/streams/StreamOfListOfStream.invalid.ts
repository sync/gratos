import { Stream } from "effect";

/** A Stream nested anywhere in the event type is rejected. */
/** @gqlSubscriptionField */
export function names(): Stream.Stream<ReadonlyArray<Stream.Stream<string>>> {
  return Stream.make([Stream.make("Ada")]);
}
