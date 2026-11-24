// { "strictSemanticNullability": true }
import { Effect, Stream } from "effect";

/** @gqlType */
export class User {
  /** No assertNonNull: the Effect layer checks the unwrapped value (marker). */
  /** @gqlField */
  name(): Effect.Effect<string> {
    return Effect.succeed("Ada");
  }

  /** Still wrapped in assertNonNull. */
  /** @gqlField */
  async email(): Promise<string> {
    return "ada@example.com";
  }
}

/** @gqlQueryField */
export function me(): Effect.Effect<User> {
  return Effect.succeed(new User());
}

/** The per-event resolve keeps assertNonNull. */
/** @gqlSubscriptionField */
export function names(): Stream.Stream<string> {
  return Stream.make("Ada");
}
