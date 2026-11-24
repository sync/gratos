# streams/EffectOnSubscription.invalid.ts

## Input

```ts title="streams/EffectOnSubscription.invalid.ts"
import { Effect } from "effect";

/** @gqlSubscriptionField */
export function greeting(): Effect.Effect<string> {
  return Effect.succeed("hi");
}
```

## Output

### Error Report

```text
test/effectFixtures/streams/EffectOnSubscription.invalid.ts:4:43 - error: Expected fields on `Subscription` to return an `AsyncIterable` or an Effect `Stream.Stream`. Fields on `Subscription` model a subscription, which is a stream of events. Grats expects fields on `Subscription` to return an `AsyncIterable` or a `Stream.Stream` which can be used to model this stream.

4 export function greeting(): Effect.Effect<string> {
                                            ~~~~~~
```