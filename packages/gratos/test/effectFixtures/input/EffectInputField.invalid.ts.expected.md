# input/EffectInputField.invalid.ts

## Input

```ts title="input/EffectInputField.invalid.ts"
import { Effect } from "effect";

/** @gqlInput */
export type GreetingInput = {
  name: Effect.Effect<string>;
};
```

## Output

### Error Report

```text
test/effectFixtures/input/EffectInputField.invalid.ts:5:9 - error: `Effect.Effect` is not a valid input type. Arguments and input fields are plain values: resolve the value before passing it in.

5   name: Effect.Effect<string>;
          ~~~~~~~~~~~~~~~~~~~~~
```