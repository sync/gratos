// { "EXPERIMENTAL__emitResolverMap": true }
import { Effect } from "effect";

/** @gqlInterface */
export interface Node {
  /** @gqlField */
  id: string;
}

/**
 * An interface field defined as a function is added to every implementation: it is reported
 * once.
 */
/** @gqlField */
export function greeting(_: Node): Effect.Effect<string> {
  return Effect.succeed("hello");
}

/** @gqlType */
export class User implements Node {
  __typename = "User" as const;
  /** @gqlField */
  id: string = "u-1";
}

/** @gqlType */
export class Post implements Node {
  __typename = "Post" as const;
  /** @gqlField */
  id: string = "p-1";
}
