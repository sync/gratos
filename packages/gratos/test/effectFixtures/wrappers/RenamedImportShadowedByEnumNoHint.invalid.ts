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
