# comments/invalidTagInLinecomment.invalid.ts

## Input

```ts title="comments/invalidTagInLinecomment.invalid.ts"
// @gqlTyp
export default class Composer {
  url(): string {
    return `/composer/`;
  }
}
```

## Output

### Error Report

```text
src/tests/fixtures/comments/invalidTagInLinecomment.invalid.ts:1:4 - error: `@gqlTyp` is not a valid Grats tag. Valid tags are: `@gqlType`, `@gqlField`, `@gqlScalar`, `@gqlInterface`, `@gqlEnum`, `@gqlUnion`, `@gqlInput`, `@gqlDirective`, `@gqlAnnotate`, `@gqlQueryField`, `@gqlMutationField`, `@gqlSubscriptionField`.

1 // @gqlTyp
     ~~~~~~~
src/tests/fixtures/comments/invalidTagInLinecomment.invalid.ts:1:4 - error: Unexpected Grats tag in line (`//`) comment. Grats looks for tags in JSDoc-style block comments. e.g. `/** @gqlType */`. For more information see: https://grats.capt.dev/docs/getting-started/comment-syntax

1 // @gqlTyp
     ~~~~~~~
```