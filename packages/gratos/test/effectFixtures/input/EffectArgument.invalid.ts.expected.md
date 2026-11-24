# input/EffectArgument.invalid.ts

## Input

```ts title="input/EffectArgument.invalid.ts"
import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(name: Effect.Effect<string>): string {
  return "hi";
}
```

## Output

### Error Report

```text
test/effectFixtures/input/EffectArgument.invalid.ts:4:32 - error: `Effect.Effect` is not a valid input type. Arguments and input fields are plain values: resolve the value before passing it in.

4 export function greeting(name: Effect.Effect<string>): string {
                                 ~~~~~~~~~~~~~~~~~~~~~
```