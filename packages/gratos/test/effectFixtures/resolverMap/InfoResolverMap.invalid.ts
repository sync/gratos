// { "EXPERIMENTAL__emitResolverMap": true }
import type { GqlInfo } from "../../../Types";

/**
 * A resolver that takes `GqlInfo` needs the `gratos: { jit: false }` marker, which a resolver map
 * cannot carry: a function, a method and a static method are each reported.
 */
/** @gqlQueryField */
export function path(info: GqlInfo): string {
  return info.fieldName;
}

/** @gqlType */
export class User {
  /** @gqlField */
  name(info: GqlInfo): string {
    return info.fieldName;
  }

  /** @gqlQueryField */
  static me(info: GqlInfo): User {
    return new User();
  }
}
