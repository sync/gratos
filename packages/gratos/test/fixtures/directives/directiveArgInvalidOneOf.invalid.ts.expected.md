# directives/directiveArgInvalidOneOf.invalid.ts

## Input

```ts title="directives/directiveArgInvalidOneOf.invalid.ts"
/**
 * @gqlInput
 */
type MyInput = { a: string } | { b: string };
/**
 * This is my custom directive.
 * @gqlDirective on FIELD_DEFINITION
 */
export function customDirective(args: { foo: MyInput }) {}

/**
 * @gqlQueryField
 * @gqlAnnotate customDirective(foo: {a: "a", b: "b"})
 */
export function myQueryField(): string {
  return "myQueryField";
}
```

## Output

### Error Report

```text
GraphQL request:1:23 - error: Within OneOf Input Object type "MyInput", exactly one field must be specified, and the value for that field must be non-null.

1 @customDirective(foo: {a: "a", b: "b"})
                        ~~~~~~~~~~~~~~~~

  src/tests/fixtures/directives/directiveArgInvalidOneOf.invalid.ts:4:1
    4 type MyInput = { a: string } | { b: string };
      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    Input type defined here
```