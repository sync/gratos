# typename/PropertyTypenameNoInitializer.invalid.ts

## Input

```ts title="typename/PropertyTypenameNoInitializer.invalid.ts"
/** @gqlType */
export class User {
  __typename: string;
  /** @gqlField */
  name: string = "Alice";
}
```

## Output

### Error Report

```text
src/tests/fixtures/typename/PropertyTypenameNoInitializer.invalid.ts:3:15 - error: Expected `__typename` property signature to specify the typename as a string literal string type. For example `__typename: "User";`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename: string;
                ~~~~~~
```