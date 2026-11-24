// TypeScript 5.9.2's JSDoc lookup (src/compiler/utilities.ts and utilitiesPublic.ts), ported to
// TypeScript 7 nodes. TypeScript 7 ships its own getJSDocTags, but it does not check
// canHaveJSDoc and walks parents differently (for example it returns a property's tags for the
// property's type node), so the engine would see tags on more nodes than on TypeScript 5.
import {
  isBinaryExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isJSDoc,
  isJSDocOverloadTag,
  isJSDocParameterTag,
  isJSDocSatisfiesTag,
  isJSDocTemplateTag,
  isJSDocTypeTag,
  isModuleDeclaration,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVariableStatement,
  isVoidExpression,
  NodeFlags,
  SyntaxKind,
} from "typescript/unstable/ast";
import type {
  BinaryExpression,
  ElementAccessExpression,
  JSDoc,
  JSDocTag,
  Node,
  ParameterDeclaration,
  PropertyAccessExpression,
  TypeParameterDeclaration,
} from "typescript/unstable/ast";

const JSDOC_HOST_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.BinaryExpression,
  SyntaxKind.Block,
  SyntaxKind.BreakStatement,
  SyntaxKind.CallSignature,
  SyntaxKind.CaseClause,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.ConstructorType,
  SyntaxKind.ConstructSignature,
  SyntaxKind.ContinueStatement,
  SyntaxKind.DebuggerStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.EmptyStatement,
  SyntaxKind.EndOfFile,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.EnumMember,
  SyntaxKind.ExportAssignment,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.ExportSpecifier,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.FunctionType,
  SyntaxKind.GetAccessor,
  SyntaxKind.Identifier,
  SyntaxKind.IfStatement,
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.IndexSignature,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.JSDocSignature,
  SyntaxKind.LabeledStatement,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.NamedTupleMember,
  SyntaxKind.NamespaceExportDeclaration,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.Parameter,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
  SyntaxKind.ReturnStatement,
  SyntaxKind.SemicolonClassElement,
  SyntaxKind.SetAccessor,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SwitchStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.TypeParameter,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.VariableStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.WithStatement,
]);

const VARIABLE_LIKE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BindingElement,
  SyntaxKind.EnumMember,
  SyntaxKind.Parameter,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.VariableDeclaration,
]);

const canHaveJSDoc = (node: Node): boolean => JSDOC_HOST_KINDS.has(node.kind);

const jsDocNodesOf = (node: Node): ReadonlyArray<JSDoc> =>
  canHaveJSDoc(node) ? (node.jsDoc ?? []).filter(isJSDoc) : [];

/** A child node by property name, for the handful of node shapes this port inspects. */
const childOf = (node: Node, key: "initializer" | "body" | "name"): Node | undefined => {
  const value: unknown = Reflect.get(node, key);
  return value !== null && typeof value === "object" && "kind" in value
    ? (value as Node)
    : undefined;
};

const ownsJSDocTag = (hostNode: Node, tag: JSDocTag): boolean =>
  !(isJSDocTypeTag(tag) || isJSDocSatisfiesTag(tag)) ||
  !isJSDoc(tag.parent) ||
  !isParenthesizedExpression(tag.parent.parent) ||
  tag.parent.parent === hostNode;

/** As TypeScript 5: the last comment contributes itself (all tags owned) or its owned tags. */
const filterOwnedJSDocTags = (
  hostNode: Node,
  comments: ReadonlyArray<JSDoc>,
): Array<JSDoc | JSDocTag> => {
  const lastJSDoc = comments.at(-1);
  return comments.flatMap((jsDoc): Array<JSDoc | JSDocTag> => {
    const tags = [...(jsDoc.tags ?? [])];
    if (jsDoc === lastJSDoc) {
      const owned = tags.filter((tag) => ownsJSDocTag(hostNode, tag));
      return owned.length === tags.length ? [jsDoc] : owned;
    }
    return tags.filter(isJSDocOverloadTag);
  });
};

const isAssignmentExpression = (node: Node): node is BinaryExpression =>
  isBinaryExpression(node) &&
  node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
  node.operatorToken.kind <= SyntaxKind.LastAssignment;

const singleVariableOfVariableStatement = (node: Node): Node | undefined =>
  isVariableStatement(node) ? node.declarationList.declarations[0] : undefined;

const singleInitializerOfVariableStatementOrPropertyDeclaration = (
  node: Node,
): Node | undefined => {
  switch (node.kind) {
    case SyntaxKind.VariableStatement: {
      const variable = singleVariableOfVariableStatement(node);
      return variable === undefined ? undefined : childOf(variable, "initializer");
    }
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertyAssignment:
      return childOf(node, "initializer");
    default:
      return undefined;
  }
};

const nestedModuleDeclaration = (node: Node): Node | undefined => {
  if (!isModuleDeclaration(node)) {
    return undefined;
  }
  const body = childOf(node, "body");
  return body?.kind === SyntaxKind.ModuleDeclaration ? body : undefined;
};

// ---- getAssignmentDeclarationKind for binary expressions, as TypeScript 5.9.2 ----

const skipParentheses = (node: Node): Node => {
  let current = node;
  while (isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
};

const isStringOrNumericLiteralLike = (node: Node): boolean =>
  node.kind === SyntaxKind.StringLiteral ||
  node.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
  isNumericLiteral(node);

const isSignedNumericLiteral = (node: Node): boolean =>
  isPrefixUnaryExpression(node) &&
  (node.operator === SyntaxKind.PlusToken || node.operator === SyntaxKind.MinusToken) &&
  isNumericLiteral(node.operand);

const isLiteralLikeElementAccess = (node: Node): node is ElementAccessExpression =>
  isElementAccessExpression(node) && isStringOrNumericLiteralLike(node.argumentExpression);

const isEntityNameExpression = (node: Node): boolean =>
  isIdentifier(node) ||
  (isPropertyAccessExpression(node) &&
    isIdentifier(node.name) &&
    isEntityNameExpression(node.expression));

const isBindableStaticElementAccessExpression = (
  node: Node,
  excludeThisKeyword: boolean,
): boolean =>
  isLiteralLikeElementAccess(node) &&
  ((!excludeThisKeyword && node.expression.kind === SyntaxKind.ThisKeyword) ||
    isEntityNameExpression(node.expression) ||
    isBindableStaticAccessExpression(node.expression, true));

const isBindableStaticAccessExpression = (node: Node, excludeThisKeyword = false): boolean =>
  (isPropertyAccessExpression(node) &&
    ((!excludeThisKeyword && node.expression.kind === SyntaxKind.ThisKeyword) ||
      (isIdentifier(node.name) && isBindableStaticNameExpression(node.expression, true)))) ||
  isBindableStaticElementAccessExpression(node, excludeThisKeyword);

const isBindableStaticNameExpression = (node: Node, excludeThisKeyword: boolean): boolean =>
  isEntityNameExpression(node) || isBindableStaticAccessExpression(node, excludeThisKeyword);

const elementOrPropertyAccessName = (node: Node): string | undefined => {
  let name: Node | undefined;
  if (isPropertyAccessExpression(node)) {
    name = node.name;
  } else if (isElementAccessExpression(node)) {
    name = skipParentheses(node.argumentExpression);
  }
  if (name === undefined) {
    return undefined;
  }
  if (isIdentifier(name)) {
    return name.text;
  }
  if (isStringOrNumericLiteralLike(name)) {
    const text: unknown = Reflect.get(name, "text");
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
};

const isDynamicElementAccess = (node: ElementAccessExpression): boolean => {
  const argument = skipParentheses(node.argumentExpression);
  return !isStringOrNumericLiteralLike(argument) && !isSignedNumericLiteral(argument);
};

const isVoidZero = (node: Node): boolean =>
  isVoidExpression(node) && isNumericLiteral(node.expression) && node.expression.text === "0";

const rightMostAssignedExpression = (node: Node): Node => {
  let current = node;
  while (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    current = current.right;
  }
  return current;
};

const initializerOfBinaryExpression = (expression: BinaryExpression): Node => {
  let current = expression;
  while (isBinaryExpression(current.right)) {
    current = current.right;
  }
  return current.right;
};

/** TypeScript 5's AssignmentDeclarationKind values that this port tells apart. */
const AssignmentDeclarationKind = {
  None: 0,
  ExportsProperty: 1,
  ModuleExports: 2,
  PrototypeProperty: 3,
  ThisProperty: 4,
  Property: 5,
  Prototype: 6,
} as const;
type AssignmentDeclarationKind =
  (typeof AssignmentDeclarationKind)[keyof typeof AssignmentDeclarationKind];

const propertyAccessAssignmentKind = (
  left: PropertyAccessExpression | ElementAccessExpression,
): AssignmentDeclarationKind => {
  if (left.expression.kind === SyntaxKind.ThisKeyword) {
    return AssignmentDeclarationKind.ThisProperty;
  }
  if (
    (isPropertyAccessExpression(left) || isLiteralLikeElementAccess(left)) &&
    isIdentifier(left.expression) &&
    left.expression.text === "module" &&
    elementOrPropertyAccessName(left) === "exports"
  ) {
    return AssignmentDeclarationKind.ModuleExports;
  }
  if (!isBindableStaticNameExpression(left.expression, true)) {
    return AssignmentDeclarationKind.None;
  }
  if (
    isBindableStaticAccessExpression(left.expression) &&
    elementOrPropertyAccessName(left.expression) === "prototype"
  ) {
    return AssignmentDeclarationKind.PrototypeProperty;
  }
  let nextToLast: Node = left;
  while (
    (isPropertyAccessExpression(nextToLast) || isElementAccessExpression(nextToLast)) &&
    !isIdentifier(nextToLast.expression)
  ) {
    nextToLast = nextToLast.expression;
  }
  const id =
    isPropertyAccessExpression(nextToLast) || isElementAccessExpression(nextToLast)
      ? nextToLast.expression
      : undefined;
  if (
    id !== undefined &&
    isIdentifier(id) &&
    (id.text === "exports" ||
      (id.text === "module" && elementOrPropertyAccessName(nextToLast) === "exports")) &&
    isBindableStaticAccessExpression(left)
  ) {
    return AssignmentDeclarationKind.ExportsProperty;
  }
  if (
    isBindableStaticNameExpression(left, true) ||
    (isElementAccessExpression(left) && isDynamicElementAccess(left))
  ) {
    return AssignmentDeclarationKind.Property;
  }
  return AssignmentDeclarationKind.None;
};

/**
 * TypeScript 5's getAssignmentDeclarationKind for a binary expression: an assignment to a
 * property access is a declaration; an assignment to a bare identifier is not. Outside JS files
 * only property assignments count.
 */
const assignmentDeclarationKind = (expression: BinaryExpression): AssignmentDeclarationKind => {
  const left = expression.left;
  let kind: AssignmentDeclarationKind = AssignmentDeclarationKind.None;
  if (
    expression.operatorToken.kind === SyntaxKind.EqualsToken &&
    (isPropertyAccessExpression(left) || isElementAccessExpression(left)) &&
    !isVoidZero(rightMostAssignedExpression(expression))
  ) {
    kind =
      isBindableStaticNameExpression(left.expression, true) &&
      elementOrPropertyAccessName(left) === "prototype" &&
      isObjectLiteralExpression(initializerOfBinaryExpression(expression))
        ? AssignmentDeclarationKind.Prototype
        : propertyAccessAssignmentKind(left);
  }
  return kind === AssignmentDeclarationKind.Property ||
    (expression.flags & NodeFlags.JavaScriptFile) !== 0
    ? kind
    : AssignmentDeclarationKind.None;
};

/** `x.y = x.y || function () {}`: the function, which takes the statement's JSDoc. */
const sourceOfDefaultedAssignment = (node: Node): Node | undefined =>
  isExpressionStatement(node) &&
  isBinaryExpression(node.expression) &&
  assignmentDeclarationKind(node.expression) !== AssignmentDeclarationKind.None &&
  isBinaryExpression(node.expression.right) &&
  (node.expression.right.operatorToken.kind === SyntaxKind.BarBarToken ||
    node.expression.right.operatorToken.kind === SyntaxKind.QuestionQuestionToken)
    ? node.expression.right.right
    : undefined;

const nextJSDocCommentLocation = (node: Node): Node | undefined => {
  const parent = node.parent;
  if (
    parent.kind === SyntaxKind.PropertyAssignment ||
    parent.kind === SyntaxKind.ExportAssignment ||
    parent.kind === SyntaxKind.PropertyDeclaration ||
    (parent.kind === SyntaxKind.ExpressionStatement &&
      node.kind === SyntaxKind.PropertyAccessExpression) ||
    parent.kind === SyntaxKind.ReturnStatement ||
    nestedModuleDeclaration(parent) !== undefined ||
    isAssignmentExpression(node)
  ) {
    return parent;
  }
  const grandparent = parent.parent as Node | undefined;
  if (
    grandparent !== undefined &&
    (singleVariableOfVariableStatement(grandparent) === node || isAssignmentExpression(parent))
  ) {
    return grandparent;
  }
  const greatGrandparent = grandparent?.parent;
  if (
    greatGrandparent !== undefined &&
    (singleVariableOfVariableStatement(greatGrandparent) !== undefined ||
      singleInitializerOfVariableStatementOrPropertyDeclaration(greatGrandparent) === node ||
      sourceOfDefaultedAssignment(greatGrandparent) !== undefined)
  ) {
    return greatGrandparent;
  }
  return undefined;
};

const parameterTags = (param: ParameterDeclaration): Array<JSDocTag> => {
  const name = param.name;
  const parentTags = getJSDocTags(param.parent);
  if (isIdentifier(name)) {
    return parentTags.filter(
      (tag) => isJSDocParameterTag(tag) && isIdentifier(tag.name) && tag.name.text === name.text,
    );
  }
  const parameters: ReadonlyArray<Node> = Reflect.get(param.parent, "parameters") ?? [];
  const index = parameters.indexOf(param);
  const tag = parentTags.filter(isJSDocParameterTag)[index];
  return index > -1 && tag !== undefined ? [tag] : [];
};

const typeParameterTags = (param: TypeParameterDeclaration): Array<JSDocTag> => {
  const name = param.name.text;
  return getJSDocTags(param.parent).filter(
    (tag) =>
      isJSDocTemplateTag(tag) &&
      [...tag.typeParameters].some((typeParameter) => typeParameter.name.text === name),
  );
};

/** TypeScript 5's getJSDocCommentsAndTags: JSDoc comments and tags that apply to `hostNode`. */
export const getJSDocCommentsAndTags = (hostNode: Node): Array<JSDoc | JSDocTag> => {
  const result: Array<JSDoc | JSDocTag> = [];
  if (VARIABLE_LIKE_KINDS.has(hostNode.kind)) {
    const initializer = childOf(hostNode, "initializer");
    if (initializer !== undefined) {
      const initializerJSDoc = jsDocNodesOf(initializer);
      if (initializerJSDoc.length > 0) {
        result.push(...filterOwnedJSDocTags(hostNode, initializerJSDoc));
      }
    }
  }
  let node: Node | undefined = hostNode;
  while (node?.parent !== undefined) {
    const jsDoc = jsDocNodesOf(node);
    if (jsDoc.length > 0) {
      result.push(...filterOwnedJSDocTags(hostNode, jsDoc));
    }
    if (node.kind === SyntaxKind.Parameter) {
      result.push(...parameterTags(node as ParameterDeclaration));
      break;
    }
    if (node.kind === SyntaxKind.TypeParameter) {
      result.push(...typeParameterTags(node as TypeParameterDeclaration));
      break;
    }
    node = nextJSDocCommentLocation(node);
  }
  return result;
};

const tagsCache = new WeakMap<Node, ReadonlyArray<JSDocTag>>();

/** TypeScript 5's getJSDocTags, cached per node as TypeScript 5 caches it on the node. */
export const getJSDocTags = (node: Node): ReadonlyArray<JSDocTag> => {
  if (!canHaveJSDoc(node)) {
    return [];
  }
  const cached = tagsCache.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const tags = getJSDocCommentsAndTags(node).flatMap((entry) =>
    isJSDoc(entry) ? [...(entry.tags ?? [])] : [entry],
  );
  tagsCache.set(node, tags);
  return tags;
};
