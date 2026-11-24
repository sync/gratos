// Gratos metadata on graphql-js AST nodes, in the style of upstream's
// src/upstream/GraphQLAstExtensions.ts: properties survive the engine's immutable AST updates,
// where a side table keyed by node would not.
import type {} from "graphql";

declare module "graphql" {
  export interface ListTypeNode {
    /**
     * Gratos metadata: the list type was written as Effect's `Stream.Stream`. Such a list is also
     * `isAsyncIterable`, and validateEffectStreams rejects it outside `Subscription`.
     */
    isEffectStream?: boolean;
  }
  export interface FieldDefinitionNode {
    /**
     * Gratos metadata: the field's resolver (or property) returns `Effect.Effect` directly. Its
     * generated resolve method gets the `semanticNonNull` marker instead of `assertNonNull`.
     */
    returnsEffect?: boolean;
    /**
     * Gratos metadata: the field is an optional method (`name?(): T`). A source may omit it, so
     * its explicit resolve calls it with `?.`, as graphql-js' default resolver tolerated.
     */
    optionalMethod?: boolean;
  }
}
