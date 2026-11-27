// Only `effect/Effect` and `effect/Stream` bind a wrapper: a namespace import of another `effect/*`
// module keeps upstream's error, with no Effect hint.
import * as S from "effect/Schema";

/** @gqlQueryField */
export function greeting(): S.Schema<string> {
  throw new Error("not called");
}
