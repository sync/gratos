# streams/EffectOfAsyncIterableOnSubscription.invalid.ts

## Input

```ts title="streams/EffectOfAsyncIterableOnSubscription.invalid.ts"
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
```

## Output

### Error Report

```text
test/effectFixtures/streams/EffectOfAsyncIterableOnSubscription.invalid.ts:6:44 - error: Expected a field on `Subscription` not to return `Effect.Effect`. An Effect is not a subscription source: a subscription's events come from a `Stream.Stream`. Return the `Stream.Stream` instead, and build it with `Stream.unwrap` if it needs an Effect to set up.

6 export function greetings(): Effect.Effect<AsyncIterable<string>> {
                                             ~~~~~~~~~~~~~~~~~~~~~
```