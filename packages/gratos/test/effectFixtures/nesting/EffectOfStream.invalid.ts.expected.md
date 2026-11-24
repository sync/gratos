# nesting/EffectOfStream.invalid.ts

## Input

```ts title="nesting/EffectOfStream.invalid.ts"
import { Effect, Stream } from "effect";

/** @gqlSubscriptionField */
export function greetings(): Effect.Effect<Stream.Stream<string>> {
  return Effect.succeed(Stream.make("hi"));
}
```

## Output

### Error Report

```text
test/effectFixtures/nesting/EffectOfStream.invalid.ts:4:44 - error: Expected `Stream.Stream` not to be wrapped in `Effect.Effect`. A subscription field returns the `Stream.Stream` itself; build it with `Stream.unwrap` if it needs an Effect to set up.

4 export function greetings(): Effect.Effect<Stream.Stream<string>> {
                                             ~~~~~~~~~~~~~~~~~~~~~
```