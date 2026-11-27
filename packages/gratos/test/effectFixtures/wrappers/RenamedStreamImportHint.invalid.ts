// A renamed import of the Stream namespace gets the hint toward `Stream.Stream`.
import { Stream as S } from "effect";

/** @gqlSubscriptionField */
export function names(): S.Stream<string> {
  return S.make("Ada");
}
