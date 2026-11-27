# wrappers/RenamedImportShadowedInFunctionBlockNoHint.invalid.ts

## Input

```ts title="wrappers/RenamedImportShadowedInFunctionBlockNoHint.invalid.ts"
import { Effect as Fx } from "effect";

export function build() {
  enum Fx {
    Effect = "effect",
  }

  /** @gqlType */
  type User = {
    /** @gqlField */
    name: Fx.Effect;
  };

  return undefined as User | undefined;
}

export const unused: Fx.Effect<string> | undefined = undefined;
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/RenamedImportShadowedInFunctionBlockNoHint.invalid.ts:11:11 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

11     name: Fx.Effect;
             ~~~~~~~~~
```