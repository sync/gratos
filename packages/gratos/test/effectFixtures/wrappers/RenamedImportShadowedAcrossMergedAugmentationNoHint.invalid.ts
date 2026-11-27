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
