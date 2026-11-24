# resolverMap/EffectFieldResolverMap.invalid.ts

## Input

```ts title="resolverMap/EffectFieldResolverMap.invalid.ts"
// { "EXPERIMENTAL__emitResolverMap": true }
import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<string> {
  return Effect.succeed("hello");
}
```

## Output

### Error Report

```text
test/effectFixtures/resolverMap/EffectFieldResolverMap.invalid.ts:5:43 - error: Expected no `Effect.Effect` field when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no generated `resolve` or `gratos` extensions for the Gratos Effect layer to run the Effect with. Turn off `EXPERIMENTAL__emitResolverMap`, or return the value or a `Promise` of it.

5 export function greeting(): Effect.Effect<string> {
                                            ~~~~~~
```