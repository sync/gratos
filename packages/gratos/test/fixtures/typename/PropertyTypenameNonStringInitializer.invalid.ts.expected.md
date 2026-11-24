# typename/PropertyTypenameNonStringInitializer.invalid.ts

## Input

```ts title="typename/PropertyTypenameNonStringInitializer.invalid.ts"
/** @gqlType */
export class User {
  __typename = 1 as const;
  /** @gqlField */
  name: string = "Alice";
}
```

## Output

### Error Report

```text
src/tests/fixtures/typename/PropertyTypenameNonStringInitializer.invalid.ts:3:16 - error: Expected `__typename` property initializer to be a string literal. For example: `__typename = "User" as const` or `__typename: "User";`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename = 1 as const;
                 ~
```