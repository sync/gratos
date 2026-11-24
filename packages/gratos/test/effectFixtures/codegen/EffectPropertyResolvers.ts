// { "strictSemanticNullability": true }
import { Effect } from "effect";

/**
 * Same-name Effect-backed properties and getters get an explicit resolve, so the Effect layer
 * can run the Effect (and check its value when the field is semantically non-null).
 */
/** @gqlType */
export class User {
  /** @gqlField */
  name: Effect.Effect<string> = Effect.succeed("Ada");

  /** @gqlField */
  get email(): Effect.Effect<string> {
    return Effect.succeed("ada@example.com");
  }

  /** Nullable: no marker, but still an explicit resolve. */
  /** @gqlField */
  nickname: Effect.Effect<string | null> = Effect.succeed(null);

  /** A plain property keeps graphql-js' default resolver. */
  /** @gqlField */
  id: string = "u-1";
}

/** @gqlType */
export type Post = {
  /** @gqlField */
  title: Effect.Effect<string>;
};

/** @gqlQueryField */
export function me(): User {
  return new User();
}

/** @gqlQueryField */
export function post(): Post {
  return { title: Effect.succeed("Hello") };
}
