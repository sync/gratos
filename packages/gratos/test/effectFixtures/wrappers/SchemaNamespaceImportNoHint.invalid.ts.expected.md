# wrappers/SchemaNamespaceImportNoHint.invalid.ts

## Input

```ts title="wrappers/SchemaNamespaceImportNoHint.invalid.ts"
// Only `effect/Effect` and `effect/Stream` bind a wrapper: a namespace import of another `effect/*`
// module keeps upstream's error, with no Effect hint.
import * as S from "effect/Schema";

/** @gqlQueryField */
export function greeting(): S.Schema<string> {
  throw new Error("not called");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/SchemaNamespaceImportNoHint.invalid.ts:6:29 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

6 export function greeting(): S.Schema<string> {
                              ~~~~~~~~
```