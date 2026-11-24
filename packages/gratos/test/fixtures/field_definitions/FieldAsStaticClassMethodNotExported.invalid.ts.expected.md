# field_definitions/FieldAsStaticClassMethodNotExported.invalid.ts

## Input

```ts title="field_definitions/FieldAsStaticClassMethodNotExported.invalid.ts"
/** @gqlType */
class User {
  /** @gqlField */
  name: string;

  /** @gqlField */
  static getUser(_: Query): User {
    return new User();
  }
}

/** @gqlType */
type Query = unknown;
```

## Output

### Error Report

```text
src/tests/fixtures/field_definitions/FieldAsStaticClassMethodNotExported.invalid.ts:2:7 - error: Expected `@gqlField` static method's class to be exported. Grats needs to import resolvers into its generated schema module, so the resolver class must be an exported.

2 class User {
        ~~~~

  src/tests/fixtures/field_definitions/FieldAsStaticClassMethodNotExported.invalid.ts:6:7
    6   /** @gqlField */
            ~~~~~~~~~~
    Field defined here
```