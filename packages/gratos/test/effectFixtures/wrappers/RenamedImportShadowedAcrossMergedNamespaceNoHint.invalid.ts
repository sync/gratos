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
