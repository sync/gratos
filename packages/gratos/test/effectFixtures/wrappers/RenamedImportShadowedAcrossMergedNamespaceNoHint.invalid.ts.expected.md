# wrappers/RenamedImportShadowedAcrossMergedNamespaceNoHint.invalid.ts

## Input

```ts title="wrappers/RenamedImportShadowedAcrossMergedNamespaceNoHint.invalid.ts"
import { Effect as Fx } from "effect";

export namespace Local {
  export namespace Fx {
    export type Effect<A> = A;
  }
}

export namespace Local {
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
test/effectFixtures/wrappers/RenamedImportShadowedAcrossMergedNamespaceNoHint.invalid.ts:13:11 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

13     name: Fx.Effect<string>;
             ~~~~~~~~~
```