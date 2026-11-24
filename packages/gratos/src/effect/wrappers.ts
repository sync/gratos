// Wrapper detection (spec §4): which TypeScript type references are Effect's `Effect.Effect` and
// `Stream.Stream`.
//
// Detection is syntactic, as Fig. 3 of the spec reads: only the qualified names `Effect.Effect`
// and `Stream.Stream` count. A user type named `Effect` stays a normal type, and a bare
// `Effect<…>` imported from `effect` gets a hint instead (see bareEffect.ts).
//
// Documented limitation: a renamed namespace import, such as `import { Effect as Fx } from
// "effect"` with `Fx.Effect<A>`, is not detected. It is reported as upstream reports any other
// qualified name.
import { Predicate } from "effect";

import {
  isIdentifier,
  isParenthesizedTypeNode,
  isTypeReferenceNode,
  SyntaxKind,
} from "#typescript";
import type { EntityName, Node, TypeNode, TypeReferenceNode } from "#typescript";

export type EffectWrapper = "Effect" | "Stream";

/** `Effect.Effect` or `Stream.Stream`, as written in diagnostics. */
export const wrapperName = (wrapper: EffectWrapper): string => `${wrapper}.${wrapper}`;

/** The wrapper a type name spells (`Effect.Effect` or `Stream.Stream`), if any. */
export const effectWrapperOfName = (typeName: EntityName): EffectWrapper | null => {
  if (isIdentifier(typeName) || !isIdentifier(typeName.left)) {
    return null;
  }
  const namespace = typeName.left.text;
  if (namespace !== typeName.right.text) {
    return null;
  }
  return namespace === "Effect" || namespace === "Stream" ? namespace : null;
};

/** The type with any parentheses around it removed. */
export const stripParentheses = (type: TypeNode): TypeNode =>
  isParenthesizedTypeNode(type) ? stripParentheses(type.type) : type;

/** The wrapper a type node is, after removing parentheses, if any. */
export const effectWrapperOf = (type: TypeNode | undefined): EffectWrapper | null => {
  if (type === undefined) {
    return null;
  }
  const inner = stripParentheses(type);
  return isTypeReferenceNode(inner) ? effectWrapperOfName(inner.typeName) : null;
};

/** The declarations whose declared type is a resolver's (or property's) return type. */
const RETURN_TYPE_OWNERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.Parameter,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
]);

/**
 * Whether a wrapper reference is the outermost type of a field: the declared type of a method,
 * function, property or parameter property, with only parentheses around it. Anything else
 * (a type argument, an array element, a union member) nests it.
 */
export const isOutermostType = (reference: TypeReferenceNode): boolean => {
  let node: Node = reference;
  while (isParenthesizedTypeNode(node.parent)) {
    node = node.parent;
  }
  return RETURN_TYPE_OWNERS.has(node.parent.kind);
};

/** Whether a field's TypeScript declaration returns `Effect.Effect` directly. */
export const returnsEffect = (declaration: Node): boolean => {
  if (!RETURN_TYPE_OWNERS.has(declaration.kind) || !Predicate.hasProperty(declaration, "type")) {
    return false;
  }
  const type = declaration.type;
  return isTypeNode(type) && effectWrapperOf(type) === "Effect";
};

const isTypeNode = (value: unknown): value is TypeNode => Predicate.hasProperty(value, "kind");
