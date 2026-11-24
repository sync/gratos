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
test/effectFixtures/streams/EffectOnSubscription.invalid.ts:4:43 - error: Expected a field on `Subscription` not to return `Effect.Effect`. An Effect is not a subscription source: a subscription's events come from a `Stream.Stream`. Return the `Stream.Stream` instead, and build it with `Stream.unwrap` if it needs an Effect to set up.

4 export function greeting(): Effect.Effect<string> {
                                            ~~~~~~
```