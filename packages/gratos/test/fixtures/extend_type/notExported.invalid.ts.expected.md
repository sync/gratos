# extend_type/notExported.invalid.ts

## Input

```ts title="extend_type/notExported.invalid.ts"
/** @gqlType */
class SomeType {
  // No fields
}

/** @gqlField */
function greeting(_: Query): string {
  return `Hello World`;
}
```

## Output

### Error Report

```text
src/tests/fixtures/extend_type/notExported.invalid.ts:7:10 - error: Expected a `@gqlField` function to be a named export. Grats needs to import resolver functions into its generated schema module, so the resolver function must be a named export.

7 function greeting(_: Query): string {
           ~~~~~~~~
```