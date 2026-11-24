# wrappers/EffectMissingTypeArgument.invalid.ts

## Input

```ts title="wrappers/EffectMissingTypeArgument.invalid.ts"
import type { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect {
  throw new Error("not called");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/EffectMissingTypeArgument.invalid.ts:4:29 - error: Expected `Effect.Effect` to have type arguments. Gratos needs to be able to see its success type in order to generate a GraphQL schema.

4 export function greeting(): Effect.Effect {
                              ~~~~~~~~~~~~~
```