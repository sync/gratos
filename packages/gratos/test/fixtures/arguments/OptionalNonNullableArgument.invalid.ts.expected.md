# arguments/OptionalNonNullableArgument.invalid.ts

## Input

```ts title="arguments/OptionalNonNullableArgument.invalid.ts"
/** @gqlType */
export default class SomeType {
  /** @gqlField */
  hello({ greeting }: { greeting?: string }): string {
    return `${greeting ?? "Hello"} World!`;
  }
}
```

## Output

### Error Report

```text
src/tests/fixtures/arguments/OptionalNonNullableArgument.invalid.ts:4:33 - error: Unexpected optional argument that does not also accept `null`. Optional arguments in GraphQL may get passed an explicit `null` value by the GraphQL executor. This means optional arguments must be typed to also accept `null`. Consider adding `| null` to the end of the argument type.

4   hello({ greeting }: { greeting?: string }): string {
                                  ~
```