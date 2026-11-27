# wrappers/UserNamespaceNoHint.invalid.ts

## Input

```ts title="wrappers/UserNamespaceNoHint.invalid.ts"
// A namespace of your own with an `Effect` member is not Effect's: it keeps upstream's error, with
// no Effect hint.
declare namespace Fx {
  type Effect<A> = { value: A };
}

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  throw new Error("not called");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/UserNamespaceNoHint.invalid.ts:8:29 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

8 export function greeting(): Fx.Effect<string> {
                              ~~~~~~~~~
```