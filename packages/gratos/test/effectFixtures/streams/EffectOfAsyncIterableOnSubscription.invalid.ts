// { "strictSemanticNullability": true }
import { Effect } from "effect";

/** An Effect is not a subscription source: `Stream.Stream` is. */
/** @gqlSubscriptionField */
export function greetings(): Effect.Effect<AsyncIterable<string>> {
  return Effect.succeed(
    (async function* () {
      yield "hi";
    })(),
  );
}
