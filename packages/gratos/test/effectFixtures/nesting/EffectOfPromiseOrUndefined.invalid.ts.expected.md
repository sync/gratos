# nesting/EffectOfPromiseOrUndefined.invalid.ts

## Input

```ts title="nesting/EffectOfPromiseOrUndefined.invalid.ts"
import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect.Effect<undefined | (Promise<string>)> {
  return Effect.succeed(undefined);
}
```

## Output

### Error Report

```text
test/effectFixtures/nesting/EffectOfPromiseOrUndefined.invalid.ts:4:56 - error: Expected the success type of `Effect.Effect` not to be a `Promise`. Gratos runs the Effect and uses its success value as the field's value, so it would never await the Promise. Use `Effect.promise` or `Effect.tryPromise` to turn the Promise into the Effect itself.

4 export function greeting(): Effect.Effect<undefined | (Promise<string>)> {
                                                         ~~~~~~~~~~~~~~~
```