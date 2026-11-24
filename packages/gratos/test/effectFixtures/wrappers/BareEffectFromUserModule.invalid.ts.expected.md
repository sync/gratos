# wrappers/BareEffectFromUserModule.invalid.ts

## Input

```ts title="wrappers/BareEffectFromUserModule.invalid.ts"
// A bare `Effect` that is not imported from `effect` gets upstream's unresolved-type error, not
// the Effect hint.
type Effect<A> = { value: A };

/** @gqlQueryField */
export function greeting(): Effect<string> {
  throw new Error("not called");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/BareEffectFromUserModule.invalid.ts:6:29 - error: Unable to resolve type reference. In order to generate a GraphQL schema, Grats needs to determine which GraphQL type is being referenced. This requires being able to resolve type references to their `@gql` annotated declaration. However this reference could not be resolved. Is it possible that this type is not defined in this file?

6 export function greeting(): Effect<string> {
                              ~~~~~~
```