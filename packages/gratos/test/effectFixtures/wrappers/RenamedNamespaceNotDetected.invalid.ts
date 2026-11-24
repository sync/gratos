// Documented limitation: a renamed namespace import is not detected as Effect.
import { Effect as Fx } from "effect";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  return Fx.succeed("hi");
}
