# nesting/EffectOfPromise.invalid.ts

## Input

```ts title="nesting/EffectOfPromise.invalid.ts"
import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<Promise<string>> {
  return Effect.succeed(Promise.resolve("hi"));
}
```

## Output

### Error Report

```text
test/effectFixtures/nesting/EffectOfPromise.invalid.ts:4:43 - error: Expected the success type of `Effect.Effect` not to be a `Promise`. Gratos runs the Effect and uses its success value as the field's value, so it would never await the Promise. Use `Effect.promise` or `Effect.tryPromise` to turn the Promise into the Effect itself.

4 export function greeting(): Effect.Effect<Promise<string>> {
                                            ~~~~~~~~~~~~~~~
```