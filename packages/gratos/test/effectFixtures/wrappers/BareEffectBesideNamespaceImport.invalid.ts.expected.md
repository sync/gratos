# wrappers/BareEffectBesideNamespaceImport.invalid.ts

## Input

```ts title="wrappers/BareEffectBesideNamespaceImport.invalid.ts"
import * as Fx from "effect/Effect";

/** @gqlQueryField */
export function greeting(): Effect<string> {
  return Fx.succeed("hi");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/BareEffectBesideNamespaceImport.invalid.ts:4:29 - error: Unable to resolve type reference. In order to generate a GraphQL schema, Grats needs to determine which GraphQL type is being referenced. This requires being able to resolve type references to their `@gql` annotated declaration. However this reference could not be resolved. Is it possible that this type is not defined in this file?

4 export function greeting(): Effect<string> {
                              ~~~~~~
```