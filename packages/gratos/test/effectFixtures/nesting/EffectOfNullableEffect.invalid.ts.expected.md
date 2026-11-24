# nesting/EffectOfNullableEffect.invalid.ts

## Input

```ts title="nesting/EffectOfNullableEffect.invalid.ts"
import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<Effect.Effect<string> | null> {
  return Effect.succeed(null);
}
```

## Output

### Error Report

```text
test/effectFixtures/nesting/EffectOfNullableEffect.invalid.ts:4:43 - error: Expected `Effect.Effect` to be the outermost type of the resolver's return type. Gratos runs an Effect only when the resolver returns it directly, so it cannot be nested in a `Promise`, an array, a union or another type. Return a single `Effect.Effect<A>` instead, for example `Effect.Effect<ReadonlyArray<A>>` or `Effect.Effect<A | null>`.

4 export function greeting(): Effect.Effect<Effect.Effect<string> | null> {
                                            ~~~~~~~~~~~~~~~~~~~~~
```