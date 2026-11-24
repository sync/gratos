# field_definitions/ParameterPropertyFieldNoModifier.invalid.ts

## Input

```ts title="field_definitions/ParameterPropertyFieldNoModifier.invalid.ts"
/** @gqlType */
export default class SomeType {
  constructor(
    /** @gqlField */
    hello: string,
  ) {
    console.log(hello);
  }
}
```

## Output

### Error Report

```text
src/tests/fixtures/field_definitions/ParameterPropertyFieldNoModifier.invalid.ts:5:5 - error: Expected `@gqlField` constructor parameter to be a parameter property. This requires a modifier such as `public` or `readonly` before the parameter name.

Learn more: https://grats.capt.dev/docs/docblock-tags/fields#class-based-fields

5     hello: string,
      ~~~~~~~~~~~~~
```