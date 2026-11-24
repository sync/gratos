# wrappers/BareEffectNamespaceImport.invalid.ts

## Input

```ts title="wrappers/BareEffectNamespaceImport.invalid.ts"
import { Effect } from "effect";

/** @gqlQueryField */
export function greeting(): Effect<string> {
  return Effect.succeed("hi");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/BareEffectNamespaceImport.invalid.ts:4:29 - error: Expected `Effect.Effect`, not a bare `Effect`. Gratos only recognizes the qualified name, so `Effect<A>` imported from `effect` is not unwrapped. Import the module with `import { Effect } from "effect"` and write `Effect.Effect<A>`.

4 export function greeting(): Effect<string> {
                              ~~~~~~
```