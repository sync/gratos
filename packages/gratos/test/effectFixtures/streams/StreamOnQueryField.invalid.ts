import { Stream } from "effect";

/** @gqlQueryField */
export function greetings(): Stream.Stream<string> {
  return Stream.make("hi");
}
