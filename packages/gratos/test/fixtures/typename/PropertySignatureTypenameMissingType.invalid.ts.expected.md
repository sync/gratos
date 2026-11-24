# typename/PropertySignatureTypenameMissingType.invalid.ts

## Input

```ts title="typename/PropertySignatureTypenameMissingType.invalid.ts"
/** @gqlType */
export class User implements IPerson {
  __typename;
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
src/tests/fixtures/typename/PropertySignatureTypenameMissingType.invalid.ts:3:3 - error: Expected `__typename` property to have an initializer or a string literal type.  This is needed to ensure Grats can determine the type of this object during GraphQL execution.

3   __typename;
    ~~~~~~~~~~
```