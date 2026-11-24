// { "strictSemanticNullability": true }
import { Effect } from "effect";
import type { GqlInfo, Int } from "../../../Types";

/**
 * @gqlDirective on FIELD_DEFINITION
 */
export function cost(args: { weight: Int }) {}

/** @gqlType */
export class User {
  /**
   * Markers merge with the user directive into one `extensions` object.
   * @gqlField
   * @gqlAnnotate cost(weight: 2)
   */
  name(info: GqlInfo): Effect.Effect<string> {
    return Effect.succeed(info.fieldName);
  }

  /**
   * The directive alone, unchanged.
   * @gqlField
   * @gqlAnnotate cost(weight: 1)
   */
  plain(): string {
    return "plain";
  }
}

/** @gqlQueryField */
export function me(): User {
  return new User();
}
