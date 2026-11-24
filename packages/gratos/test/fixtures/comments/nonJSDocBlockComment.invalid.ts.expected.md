# comments/nonJSDocBlockComment.invalid.ts

## Input

```ts title="comments/nonJSDocBlockComment.invalid.ts"
// Oops! Forgot to use two asterisks for the JSDoc block comment.

/* @gqlType */
class Composer {}
```

## Output

### Error Report

```text
src/tests/fixtures/comments/nonJSDocBlockComment.invalid.ts:3:4 - error: Unexpected Grats tag in non-JSDoc-style block comment. Grats only looks for tags in JSDoc-style block comments which start with `/**`. For more information see: https://grats.capt.dev/docs/getting-started/comment-syntax

3 /* @gqlType */
     ~~~~~~~~
```