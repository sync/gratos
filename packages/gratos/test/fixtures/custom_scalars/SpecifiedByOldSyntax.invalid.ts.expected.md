# custom_scalars/SpecifiedByOldSyntax.invalid.ts

## Input

```ts title="custom_scalars/SpecifiedByOldSyntax.invalid.ts"
/**
 * @gqlScalar
 * @specifiedBy https://tools.ietf.org/html/rfc4122
 */
export type UUID = string;
```

## Output

### Error Report

```text
src/tests/fixtures/custom_scalars/SpecifiedByOldSyntax.invalid.ts:3:4 - error: The `@specifiedBy` tag has been deprecated in favor of `@gqlAnnotate`. Use `@gqlAnnotate specifiedBy(url: "http://example.com")` instead.

3  * @specifiedBy https://tools.ietf.org/html/rfc4122
     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
4  */
  ~
```