# wrappers/RenamedNamespaceNotDetected.invalid.ts

## Input

```ts title="wrappers/RenamedNamespaceNotDetected.invalid.ts"
// Documented limitation: a renamed namespace import is not detected as Effect.
import { Effect as Fx } from "effect";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  return Fx.succeed("hi");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/RenamedNamespaceNotDetected.invalid.ts:5:29 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

5 export function greeting(): Fx.Effect<string> {
                              ~~~~~~~~~
```