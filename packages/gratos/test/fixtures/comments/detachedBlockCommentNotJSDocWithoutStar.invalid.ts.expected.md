# comments/detachedBlockCommentNotJSDocWithoutStar.invalid.ts

## Input

```ts title="comments/detachedBlockCommentNotJSDocWithoutStar.invalid.ts"
/*
   @gqlType
*/
/**
 * Foo
 */
```

## Output

### Error Report

```text
src/tests/fixtures/comments/detachedBlockCommentNotJSDocWithoutStar.invalid.ts:2:4 - error: Unexpected Grats tag in non-JSDoc-style block comment. Grats only looks for tags in JSDoc-style block comments which start with `/**`. For more information see: https://grats.capt.dev/docs/getting-started/comment-syntax

2    @gqlType
     ~~~~~~~~
```