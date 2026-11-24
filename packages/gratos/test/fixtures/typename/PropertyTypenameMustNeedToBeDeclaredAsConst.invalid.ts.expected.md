# typename/PropertyTypenameMustNeedToBeDeclaredAsConst.invalid.ts

## Input

```ts title="typename/PropertyTypenameMustNeedToBeDeclaredAsConst.invalid.ts"
/** @gqlType */
export class User {
  __typename = "User";
  /** @gqlField */
  name: string = "Alice";
}
```

## Output

### Error Report

```text
src/tests/fixtures/typename/PropertyTypenameMustNeedToBeDeclaredAsConst.invalid.ts:3:16 - error: Expected `__typename` property initializer to be an expression with a const assertion. For example: `__typename = "User" as const` or `__typename: "User";`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename = "User";
                 ~~~~~~
```