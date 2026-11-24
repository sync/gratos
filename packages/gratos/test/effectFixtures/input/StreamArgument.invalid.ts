import { Stream } from "effect";

/** @gqlQueryField */
export function greeting(args: { names: Stream.Stream<string> }): string {
  return "hi";
}
