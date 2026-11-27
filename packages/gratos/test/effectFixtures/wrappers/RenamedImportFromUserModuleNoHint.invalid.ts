// An `Effect` imported under another name from a module of your own is not Effect's: it keeps
// upstream's error, with no Effect hint.
import { Effect as Fx } from "./effects";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  throw new Error("not called");
}
