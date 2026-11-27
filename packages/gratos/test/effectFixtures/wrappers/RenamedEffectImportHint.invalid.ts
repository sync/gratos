// A renamed import of the Effect namespace is not detected as Effect: the error is a hint toward
// `Effect.Effect`, not upstream's "Expected a name identifier".
import { Effect as Fx } from "effect";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  return Fx.succeed("hi");
}
