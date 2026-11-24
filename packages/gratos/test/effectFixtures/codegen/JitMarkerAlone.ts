// { "strictSemanticNullability": true }
import { Effect } from "effect";
import type { GqlInfo } from "../../../Types";

/** @gqlType */
export class User {
  /** Both markers, no directive: the merge creates the `extensions` object. */
  /** @gqlField */
  name(info: GqlInfo): Effect.Effect<string> {
    return Effect.succeed(info.fieldName);
  }

  /** The jit marker only. */
  /** @gqlField */
  path(info: GqlInfo): string {
    return info.fieldName;
  }

  /** The semanticNonNull marker only. */
  /** @gqlField */
  greeting(): Effect.Effect<string> {
    return Effect.succeed("hi");
  }
}

/** @gqlQueryField */
export function me(info: GqlInfo): User {
  return new User();
}
