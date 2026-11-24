# nesting/EffectOfNullableStream.invalid.ts

## Input

```ts title="nesting/EffectOfNullableStream.invalid.ts"
import { Effect, Stream } from "effect";

/** @gqlQueryField */
export function greetings(): Effect.Effect<Stream.Stream<string> | null> {
  return Effect.succeed(null);
}
```

## Output

### Error Report

```text
test/effectFixtures/nesting/EffectOfNullableStream.invalid.ts:4:44 - error: Expected `Stream.Stream` not to be wrapped in `Effect.Effect`. A subscription field returns the `Stream.Stream` itself; build it with `Stream.unwrap` if it needs an Effect to set up.

4 export function greetings(): Effect.Effect<Stream.Stream<string> | null> {
                                             ~~~~~~~~~~~~~~~~~~~~~
```