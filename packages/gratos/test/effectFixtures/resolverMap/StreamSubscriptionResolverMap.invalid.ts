// { "EXPERIMENTAL__emitResolverMap": true }
import { Stream } from "effect";
import type { Int } from "../../../Types";

/** @gqlSubscriptionField */
export function countdown(from: Int): Stream.Stream<Int> {
  return Stream.make(from, from - 1, 0);
}
