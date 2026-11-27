# wrappers/RenamedEffectImportHint.invalid.ts

## Input

```ts title="wrappers/RenamedEffectImportHint.invalid.ts"
// A renamed import of the Effect namespace is not detected as Effect: the error is a hint toward
// `Effect.Effect`, not upstream's "Expected a name identifier".
import { Effect as Fx } from "effect";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  return Fx.succeed("hi");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/RenamedEffectImportHint.invalid.ts:6:29 - error: Expected `Effect.Effect`, not `Fx.Effect`. Gratos only recognizes the qualified name with the namespace imported under its own name, so a renamed import is not unwrapped. Import the namespace without renaming it, with `import { Effect } from "effect"`, and write `Effect.Effect<A>`.

6 export function greeting(): Fx.Effect<string> {
                              ~~~~~~~~~~~~~~~~~
```