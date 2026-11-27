# wrappers/RenamedImportShadowedByEnumNoHint.invalid.ts

## Input

```ts title="wrappers/RenamedImportShadowedByEnumNoHint.invalid.ts"
import { Effect as Fx } from "effect";

export namespace Local {
  enum Fx {
    Effect = "effect",
  }

  /** @gqlType */
  export type User = {
    /** @gqlField */
    name: Fx.Effect;
  };
}

export const unused: Fx.Effect<string> | undefined = undefined;
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/RenamedImportShadowedByEnumNoHint.invalid.ts:11:11 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

11     name: Fx.Effect;
             ~~~~~~~~~
```