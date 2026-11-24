# typename/PropertyTypenameDoesNotMatchClassName.invalid.ts

## Input

```ts title="typename/PropertyTypenameDoesNotMatchClassName.invalid.ts"
/** @gqlType */
export class User {
  __typename = "Group" as const;
  /** @gqlField */
  name: string = "Alice";
}
```

## Output

### Error Report

```text
src/tests/fixtures/typename/PropertyTypenameDoesNotMatchClassName.invalid.ts:3:16 - error: Expected `__typename` property initializer to be `"User"`, found `"Group"`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename = "Group" as const;
                 ~~~~~~~
```