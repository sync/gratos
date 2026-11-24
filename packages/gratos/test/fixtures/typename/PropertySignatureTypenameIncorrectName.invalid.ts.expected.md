# typename/PropertySignatureTypenameIncorrectName.invalid.ts

## Input

```ts title="typename/PropertySignatureTypenameIncorrectName.invalid.ts"
/** @gqlType */
export class User implements IPerson {
  __typename: "Group";
  /** @gqlField */
  name: string;
}

/** @gqlInterface */
export interface IPerson {
  /** @gqlField */
  name: string;
}
```

## Output

### Error Report

```text
src/tests/fixtures/typename/PropertySignatureTypenameIncorrectName.invalid.ts:3:15 - error: Expected `__typename` property to be `"User"`. This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename: "Group";
                ~~~~~~~
```