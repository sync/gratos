import { Effect } from "effect";
import type { Int } from "../../../Types";

class NotFound {
  readonly _tag = "NotFound";
}

/** @gqlType */
export class User {
  /** @gqlField */
  name(): Effect.Effect<string> {
    return Effect.succeed("Ada");
  }

  /** @gqlField */
  age: Effect.Effect<Int, NotFound>;

  /** @gqlField */
  orders(userId: string, first: Int): Effect.Effect<ReadonlyArray<string>, NotFound, never> {
    return Effect.succeed([userId].slice(0, first));
  }

  /** @gqlField */
  nickname(): Effect.Effect<string | null> {
    return Effect.succeed(null);
  }
}

/** @gqlQueryField */
export function me(): Effect.Effect<User> {
  return Effect.succeed(new User());
}
