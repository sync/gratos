# wrappers/RenamedImportShadowedNoHint.invalid.ts

## Input

```ts title="wrappers/RenamedImportShadowedNoHint.invalid.ts"
import { Effect as Fx } from "effect";

export namespace Local {
  namespace Fx {
    export type Effect<A> = A;
  }

  /** @gqlType */
  export type User = {
    /** @gqlField */
    name: Fx.Effect<string>;
  };
}

export const unused: Fx.Effect<string> | undefined = undefined;
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/RenamedImportShadowedNoHint.invalid.ts:11:11 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

11     name: Fx.Effect<string>;
             ~~~~~~~~~
```