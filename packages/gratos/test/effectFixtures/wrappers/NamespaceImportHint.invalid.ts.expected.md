# wrappers/NamespaceImportHint.invalid.ts

## Input

```ts title="wrappers/NamespaceImportHint.invalid.ts"
// A namespace import of `effect/Effect` under another name gets the hint toward `Effect.Effect`.
import * as Fx from "effect/Effect";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  return Fx.succeed("hi");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/NamespaceImportHint.invalid.ts:5:29 - error: Expected `Effect.Effect`, not `Fx.Effect`. Gratos only recognizes the qualified name with the namespace imported under its own name, so a renamed import is not unwrapped. Import the namespace without renaming it, with `import { Effect } from "effect"`, and write `Effect.Effect<A>`.

5 export function greeting(): Fx.Effect<string> {
                              ~~~~~~~~~~~~~~~~~
```