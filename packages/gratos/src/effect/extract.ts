// Effect-aware extraction (spec §4), called from two hook points in the vendored Extractor:
// `typeReference` (before upstream's expectNameIdentifier, which rejects every qualified name)
// and `recordDerivedContext`.
import {
  isIdentifier,
  isLiteralTypeNode,
  isMethodDeclaration,
  isMethodSignature,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
} from "#typescript";
import type { Node, TypeNode, TypeReferenceNode } from "#typescript";
import type { TypeNode as GraphQLTypeNode } from "graphql";

import { questionTokenOf } from "../ts/compat.ts";
import type { GraphQLConstructor } from "../upstream/GraphQLConstructor.ts";
import type { ResolverSignature } from "../upstream/resolverSignature.ts";
import "./astExtensions.ts";
import {
  effectDerivedContext,
  effectInInputPosition,
  effectNotOutermost,
  effectWrapperMissingTypeArg,
  promiseInsideEffect,
  streamInsideEffect,
} from "./errors.ts";
import {
  effectWrapperOf,
  effectWrapperOfName,
  isOutermostType,
  stripParentheses,
} from "./wrappers.ts";

/** The parts of upstream's Extractor that the hooks use. */
export interface EffectExtractor {
  readonly gql: GraphQLConstructor;
  report(node: Node, message: string): null;
  collectType(node: TypeNode, ctx: { kind: "OUTPUT" | "INPUT" }): GraphQLTypeNode | null;
}

const isPromiseReference = (type: TypeNode): type is TypeReferenceNode =>
  isTypeReferenceNode(type) && isIdentifier(type.typeName) && type.typeName.text === "Promise";

/** Whether a union member only makes the type nullable (`null` or `undefined`). */
const isNullish = (type: TypeNode): boolean =>
  type.kind === SyntaxKind.UndefinedKeyword ||
  (isLiteralTypeNode(type) && type.literal.kind === SyntaxKind.NullKeyword);

/**
 * The types an Effect can succeed with, parentheses removed: every non-nullish member of a
 * union (`Promise<A> | null` holds a `Promise<A>`), or else the type itself.
 */
const successBranches = (success: TypeNode): ReadonlyArray<TypeNode> => {
  const type = stripParentheses(success);
  return isUnionTypeNode(type)
    ? type.types.flatMap((member) => (isNullish(member) ? [] : successBranches(member)))
    : [type];
};

/**
 * The GraphQL type for an `Effect.Effect` or `Stream.Stream` reference, `null` after reporting a
 * diagnostic, or `undefined` when the reference is neither (upstream handles it).
 *
 * - `Effect.Effect<A, E, R>` becomes the type of `A`, as `Promise<A>` does. It must be the field's
 *   outermost type, and `A` must not be a `Promise` or a `Stream.Stream`, nor a nullable union
 *   holding one.
 * - `Stream.Stream<A, E, R>` becomes an async iterable of `A`, as `AsyncIterable<A>` does, marked
 *   as an Effect stream so it is rejected outside `Subscription`.
 * - Neither is a valid input type.
 */
export const effectTypeReference = (
  extractor: EffectExtractor,
  node: TypeReferenceNode,
  ctx: { kind: "OUTPUT" | "INPUT" },
): GraphQLTypeNode | null | undefined => {
  const wrapper = effectWrapperOfName(node.typeName);
  if (wrapper === null) {
    return undefined;
  }
  if (ctx.kind === "INPUT") {
    return extractor.report(node, effectInInputPosition(wrapper));
  }
  if (wrapper === "Effect" && !isOutermostType(node)) {
    return extractor.report(node, effectNotOutermost());
  }
  const typeArgument = node.typeArguments?.[0];
  if (typeArgument === undefined) {
    return extractor.report(node, effectWrapperMissingTypeArg(wrapper));
  }
  if (wrapper === "Effect") {
    // Checked on each success branch: `Effect.Effect<Promise<A> | null>` must not slip through
    // upstream's nullable-union handling as a nullable `A`.
    for (const success of successBranches(typeArgument)) {
      if (effectWrapperOf(success) === "Stream") {
        return extractor.report(success, streamInsideEffect());
      }
      if (isPromiseReference(success)) {
        return extractor.report(success, promiseInsideEffect());
      }
    }
    return extractor.collectType(typeArgument, ctx);
  }
  const element = extractor.collectType(typeArgument, ctx);
  if (element === null) {
    return null;
  }
  const listType = extractor.gql.listType(node, element);
  listType.isAsyncIterable = true;
  listType.isEffectStream = true;
  return extractor.gql.nonNullType(node, listType);
};

/**
 * Reports a derived context function that returns `Effect.Effect` or `Stream.Stream`, directly
 * or inside a `Promise`: the generated schema calls (and awaits) derived context functions, so
 * the resolver would receive the unrun Effect. Returns whether it reported.
 */
export const rejectEffectDerivedContext = (
  extractor: EffectExtractor,
  returnType: TypeNode,
): boolean => {
  const direct = stripParentheses(returnType);
  const awaited =
    isPromiseReference(direct) && direct.typeArguments?.[0] !== undefined
      ? stripParentheses(direct.typeArguments[0])
      : direct;
  const wrapper = effectWrapperOf(awaited);
  if (wrapper === null) {
    return false;
  }
  extractor.report(awaited, effectDerivedContext(wrapper));
  return true;
};

/**
 * Whether a field is backed by an optional method (`name?(): T`), which a valid source may omit.
 * The vendored GraphQLConstructor records it on the field as `optionalMethod`.
 */
export const isOptionalMethod = (node: Node, resolver: ResolverSignature): boolean =>
  resolver.kind === "method" &&
  (isMethodDeclaration(node) || isMethodSignature(node)) &&
  questionTokenOf(node) !== undefined;
