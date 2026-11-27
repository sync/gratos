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
