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
