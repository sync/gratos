import { Stream } from "effect";

/** @gqlType */
export class User {
  /** @gqlField */
  greetings(): Stream.Stream<string> {
    return Stream.make("hi");
  }
}
