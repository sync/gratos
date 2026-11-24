# wrappers/BareEffectImportedFromEffect.invalid.ts

## Input

```ts title="wrappers/BareEffectImportedFromEffect.invalid.ts"
import type { Effect } from "effect/Effect";

/** @gqlQueryField */
export function greeting(): Effect<string> {
  throw new Error("not called");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/BareEffectImportedFromEffect.invalid.ts:4:29 - error: Expected `Effect.Effect`, not a bare `Effect`. Gratos only recognizes the qualified name, so `Effect<A>` imported from `effect` is not unwrapped. Import the module with `import { Effect } from "effect"` and write `Effect.Effect<A>`.

4 export function greeting(): Effect<string> {
                              ~~~~~~
```