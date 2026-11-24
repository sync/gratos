# user_error/TypeErrorWithTypeCheckingEnabled.invalid.ts5.ts

## Input

```ts title="user_error/TypeErrorWithTypeCheckingEnabled.invalid.ts5.ts"
// {"reportTypeScriptTypeErrors": true}
/** @gqlType */
class Foo {
  /** @gqlField */
  someField(): string {
    return 10;
  }
}
```

## Output

### Error Report

```text
test/ts7Fixtures/user_error/TypeErrorWithTypeCheckingEnabled.invalid.ts5.ts:6:5 - error TS2322: Type 'number' is not assignable to type 'string'.

6     return 10;
      ~~~~~~
```