# wrappers/RenamedImportShadowedAcrossMergedAugmentationNoHint.invalid.ts

## Input

```ts title="wrappers/RenamedImportShadowedAcrossMergedAugmentationNoHint.invalid.ts"
import { Effect as Fx } from "effect";

declare module "./RenamedImportShadowedAcrossMergedAugmentationNoHint.invalid.ts" {
  namespace Fx {
    export type Effect<A> = A;
  }
}

declare module "./RenamedImportShadowedAcrossMergedAugmentationNoHint.invalid.ts" {
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
test/effectFixtures/wrappers/RenamedImportShadowedAcrossMergedAugmentationNoHint.invalid.ts:13:11 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

13     name: Fx.Effect<string>;
             ~~~~~~~~~
```