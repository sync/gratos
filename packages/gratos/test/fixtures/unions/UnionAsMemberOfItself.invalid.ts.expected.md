# unions/UnionAsMemberOfItself.invalid.ts

## Input

```ts title="unions/UnionAsMemberOfItself.invalid.ts"
/** @gqlType */
export default class SomeType {
  /** @gqlField */
  me: Actor;
}

/** @gqlType */
class User {
  __typename = "User";
  /** @gqlField */
  name: string;
}

/** @gqlType */
class Entity {
  __typename = "Entity";
  /** @gqlField */
  description: string;
}

/** @gqlUnion */
type Actor = User | Entity | Actor;
```

## Output

### Error Report

```text
src/tests/fixtures/unions/UnionAsMemberOfItself.invalid.ts:9:16 - error: Expected `__typename` property initializer to be an expression with a const assertion. For example: `__typename = "User" as const` or `__typename: "User";`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

9   __typename = "User";
                 ~~~~~~

src/tests/fixtures/unions/UnionAsMemberOfItself.invalid.ts:16:16 - error: Expected `__typename` property initializer to be an expression with a const assertion. For example: `__typename = "Entity" as const` or `__typename: "Entity";`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

16   __typename = "Entity";
                  ~~~~~~~~
```