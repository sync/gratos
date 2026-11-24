# user_error/WrongCaseGqlTag.invalid.ts

## Input

```ts title="user_error/WrongCaseGqlTag.invalid.ts"
/** @GQLField */
function field() {}
```

## Output

### Error Report

```text
src/tests/fixtures/user_error/WrongCaseGqlTag.invalid.ts:1:6 - error: Incorrect casing for Grats tag `@GQLField`. Use `@gqlField` instead.

1 /** @GQLField */
       ~~~~~~~~
```