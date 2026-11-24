# typename/PropertyTypenameMustNeedToBeDeclaredAsExactlyConst.invalid.ts

## Input

```ts title="typename/PropertyTypenameMustNeedToBeDeclaredAsExactlyConst.invalid.ts"
/** @gqlType */
export class User {
  __typename = "User" as Foo;
  /** @gqlField */
  name: string = "Alice";
}

type Foo = string;
```

## Output

### Error Report

```text
src/tests/fixtures/typename/PropertyTypenameMustNeedToBeDeclaredAsExactlyConst.invalid.ts:3:26 - error: Expected `__typename` property type name to be "const". For example: `__typename = "User" as const` or `__typename: "User";`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename = "User" as Foo;
                           ~~~
```