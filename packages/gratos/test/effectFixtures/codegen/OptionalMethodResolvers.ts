/** @gqlType */
export interface User {
  /**
   * An optional method: a source may omit it, so its resolve calls it with `?.`. As with
   * graphql-js' default resolver, an omitted method resolves to `null` without an error.
   */
  /** @gqlField */
  nickname?(): string | null;

  /** An optional method with arguments. */
  /** @gqlField */
  greeting?(args: { name: string }): string | null;

  /** A required method keeps a plain call. */
  /** @gqlField */
  id(): string;
}

/** @gqlQueryField */
export function me(): User {
  return { id: () => "1" };
}
