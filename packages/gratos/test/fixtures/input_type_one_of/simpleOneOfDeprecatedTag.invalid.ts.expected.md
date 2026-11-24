# input_type_one_of/simpleOneOfDeprecatedTag.invalid.ts

## Input

```ts title="input_type_one_of/simpleOneOfDeprecatedTag.invalid.ts"
/**
 * @gqlInput
 * @oneOf
 */
export type Greeting = { firstName: string } | { lastName: string };
```

## Output

### Error Report

```text
src/tests/fixtures/input_type_one_of/simpleOneOfDeprecatedTag.invalid.ts:3:4 - error: The `@oneOf` tag has been deprecated. Grats will now automatically add the `@oneOf` directive if you define your input type as a TypeScript union. You can remove the `@oneOf` tag.

3  * @oneOf
     ~~~~~~
4  */
  ~
```