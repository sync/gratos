# nesting/ArrayOfEffect.invalid.ts

## Input

```ts title="nesting/ArrayOfEffect.invalid.ts"
import { Effect } from "effect";

/** @gqlQueryField */
export function greetings(): Array<Effect.Effect<string>> {
  return [Effect.succeed("hi")];
}
```

## Output

### Error Report

```text
test/effectFixtures/nesting/ArrayOfEffect.invalid.ts:4:36 - error: Expected `Effect.Effect` to be the outermost type of the resolver's return type. Gratos runs an Effect only when the resolver returns it directly, so it cannot be nested in a `Promise`, an array, a union or another type. Return a single `Effect.Effect<A>` instead, for example `Effect.Effect<ReadonlyArray<A>>` or `Effect.Effect<A | null>`.

4 export function greetings(): Array<Effect.Effect<string>> {
                                     ~~~~~~~~~~~~~~~~~~~~~
```