// Gratos' codegen deltas over upstream Grats, called from the vendored codegen:
//
// - "methodResolvers" (spec §8): every method field gets an explicit `resolve`, because
//   graphql-jit does not call function-valued properties (isDefaultResolverSignature).
// - "jitMarker": a field whose resolver takes a `GqlInfo` parameter gets
//   `extensions: { gratos: { jit: false } }`, for the server's jit() plugin.
// - "effectSemanticNonNull": a semantically non-null field whose resolver returns `Effect.Effect`
//   gets `extensions: { gratos: { semanticNonNull: true } }` instead of `assertNonNull`, which
//   would only ever see the (never null) Effect object. The Effect layer checks the value.
// - "effectResolvers": a field backed by a same-name `Effect.Effect` property or getter gets an
//   explicit `resolve` (`return source.name;`) instead of graphql-js' default resolver. The
//   Effect layer (docs/plan.html M5) wraps each field's resolve to run the Effect it returns and,
//   with the `semanticNonNull` marker, check its success value; a field without a resolve would
//   hand the unrun Effect to graphql-js.
//
// The markers merge into the one `extensions` object upstream emits for directives
// (`{ grats: { directives } }`), so no field ever gets a second `extensions` property.
//
// withUpstreamCodegen is an internal switch, not a config option: it turns the deltas off so the
// parity test can compare generated code with grats@0.0.36 byte for byte.
import type { GraphQLField } from "graphql";

import type { ResolverDefinition } from "../upstream/metadata.ts";
import { SEMANTIC_NON_NULL_DIRECTIVE } from "../upstream/publicDirectives.ts";
import "./astExtensions.ts";

export type CodegenDelta =
  | "methodResolvers"
  | "jitMarker"
  | "effectSemanticNonNull"
  | "effectResolvers";

export const ALL_CODEGEN_DELTAS: ReadonlySet<CodegenDelta> = new Set([
  "methodResolvers",
  "jitMarker",
  "effectSemanticNonNull",
  "effectResolvers",
]);

let enabledDeltas: ReadonlySet<CodegenDelta> = ALL_CODEGEN_DELTAS;

/** Whether a codegen delta is on (they all are, except inside withCodegenDeltas). */
export const isCodegenDeltaEnabled = (delta: CodegenDelta): boolean => enabledDeltas.has(delta);

/**
 * Internal, for tests: runs synchronous `f` (codegen is synchronous) with only `deltas` on.
 * @internal
 */
export const withCodegenDeltas = <A>(deltas: ReadonlySet<CodegenDelta>, f: () => A): A => {
  const previous = enabledDeltas;
  enabledDeltas = deltas;
  try {
    return f();
  } finally {
    enabledDeltas = previous;
  }
};

/**
 * Internal, for the parity test: runs `f` with every Gratos codegen delta off, so codegen emits
 * exactly what upstream Grats emits.
 * @internal
 */
export const withUpstreamCodegen = <A>(f: () => A): A => withCodegenDeltas(new Set(), f);

/** Whether codegen must give a method field an explicit resolve (spec §8). */
export const alwaysResolveMethods = (): boolean => isCodegenDeltaEnabled("methodResolvers");

/**
 * Whether a method field's explicit resolve calls the method with `?.`: the method is optional,
 * so a valid source may omit it. graphql-js' default resolver, which upstream uses for such a
 * field, then resolves to `null`; a plain call would throw instead.
 */
export const optionalMethodCall = (field: GraphQLField<unknown, unknown> | undefined): boolean =>
  alwaysResolveMethods() && field?.astNode?.optionalMethod === true;

/**
 * Whether codegen must give a field an explicit resolve although its resolver signature is
 * graphql-js' default (a same-name property or getter): it returns `Effect.Effect`.
 */
export const alwaysResolveEffect = (field: GraphQLField<unknown, unknown> | undefined): boolean =>
  isCodegenDeltaEnabled("effectResolvers") && field?.astNode?.returnsEffect === true;

/**
 * Whether the field's semantic non-null check belongs to the Effect layer rather than to a
 * generated `assertNonNull` (its resolver returns `Effect.Effect`).
 *
 * Never for a subscription's per-event `resolve(payload)`: it receives each event, not the value
 * of an Effect, so it keeps upstream's `assertNonNull` whatever the source is annotated with.
 */
export const isEffectSemanticNonNull = (
  field: GraphQLField<unknown, unknown>,
  subscriptionEvent = false,
): boolean =>
  !subscriptionEvent &&
  isCodegenDeltaEnabled("effectSemanticNonNull") &&
  field.astNode?.returnsEffect === true;

export interface GratosMarkers {
  readonly jit?: false;
  readonly semanticNonNull?: true;
}

/**
 * The `gratos` markers for a field with a resolve method, or `null` when it has none.
 * `semanticNonNull` is set where upstream would emit `assertNonNull` around an Effect.
 */
export const gratosFieldMarkers = (
  field: GraphQLField<unknown, unknown>,
  resolver: ResolverDefinition | undefined,
  isSubscription: boolean,
): GratosMarkers | null => {
  const hasSemanticNonNull =
    field.astNode?.directives?.some(
      (directive) => directive.name.value === SEMANTIC_NON_NULL_DIRECTIVE,
    ) ?? false;
  const usesInfo =
    isCodegenDeltaEnabled("jitMarker") &&
    resolver !== undefined &&
    resolver.kind !== "property" &&
    (resolver.arguments ?? []).some((argument) => argument.kind === "information");
  const semanticNonNull = hasSemanticNonNull && isEffectSemanticNonNull(field, isSubscription);
  if (!usesInfo && !semanticNonNull) {
    return null;
  }
  if (usesInfo && semanticNonNull) {
    return { jit: false, semanticNonNull: true };
  }
  return usesInfo ? { jit: false } : { semanticNonNull: true };
};
