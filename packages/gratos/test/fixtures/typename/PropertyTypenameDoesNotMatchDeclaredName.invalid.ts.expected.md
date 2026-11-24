# typename/PropertyTypenameDoesNotMatchDeclaredName.invalid.ts

## Input

```ts title="typename/PropertyTypenameDoesNotMatchDeclaredName.invalid.ts"
/** @gqlType User */
export class UserModel {
  __typename = "UserModel" as const;
  /** @gqlField */
  name: string = "Alice";
}
```

## Output

### Error Report

```text
src/tests/fixtures/typename/PropertyTypenameDoesNotMatchDeclaredName.invalid.ts:3:16 - error: Expected `__typename` property initializer to be `"User"`, found `"UserModel"`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename = "UserModel" as const;
                 ~~~~~~~~~~~
```