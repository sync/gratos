// The TypeScript 7 implementation of the `#typescript` facade.
//
// The vendored engine imports `* as ts from "#typescript"` and is typechecked against TypeScript
// 5.9.2's declarations (see tsconfig.json `paths`). At runtime `#typescript` resolves here
// (package.json `imports`), so every value the engine reads from `ts` is exported below under its
// TypeScript 5 name, implemented on `typescript/unstable/*`. This folder is the only importer of
// the TypeScript 7 API. The parity run swaps in ./ts5.ts, a pass-through to TypeScript 5.9.2.
import { version as typescriptVersion } from "typescript";
import {
  createScanner as createScanner7,
  forEachLeadingCommentRange,
  forEachTrailingCommentRange,
  getShebang,
  getTextOfJSDocComment,
  isArrowFunction,
  isClassExpression,
  isFunctionExpression,
  isIdentifier,
  isTokenKind,
  LanguageVariant,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  SyntaxKind as Ts7SyntaxKind,
} from "typescript/unstable/ast";
import type { DeclarationName, Node, NodeArray, Scanner } from "typescript/unstable/ast";
import {
  isMethodSignatureDeclaration,
  isParameterDeclaration,
  isPropertySignatureDeclaration,
} from "typescript/unstable/ast/is";
import { DiagnosticCategory, ModuleKind, SymbolFlags } from "typescript/unstable/sync";

// The node guards the engine calls (TypeScript 7 has the same names and semantics).
export {
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrayTypeNode,
  isArrowFunction,
  isAsExpression,
  isBindingElement,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSourceFile,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableStatement,
} from "typescript/unstable/ast/is";
export { formatDiagnosticsWithColorAndContext } from "./diagnostics.ts";
export { factory } from "./factory.ts";
export { getJSDocCommentsAndTags, getJSDocTags } from "./jsdoc.ts";
export { createPrinter, createSourceFile } from "./printer.ts";
export {
  createCompilerHost,
  createProgram,
  findConfigFile,
  getParsedCommandLineOfConfigFile,
  getPreEmitDiagnostics,
  sys,
} from "./program.ts";
export {
  DiagnosticCategory,
  forEachLeadingCommentRange,
  forEachTrailingCommentRange,
  getShebang,
  getTextOfJSDocComment,
  isTokenKind,
  LanguageVariant,
  ModuleKind,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  SymbolFlags,
};

export const version: string = typescriptVersion;

/** TypeScript 7's SyntaxKind plus the TypeScript 5 aliases it dropped. */
export const SyntaxKind = {
  ...Ts7SyntaxKind,
  EndOfFileToken: Ts7SyntaxKind.EndOfFile,
  JSDocComment: Ts7SyntaxKind.JSDoc,
  JSDocTag: Ts7SyntaxKind.JSDocUnknownTag,
};

/** TypeScript 5's ListFormat, for the one format the engine prints. */
export const ListFormat = { MultiLine: 1 } as const;
export const NewLineKind = { CarriageReturnLineFeed: 0, LineFeed: 1 } as const;
/** TypeScript 5's ModuleResolutionKind values, which TypeScript 7 keeps but does not export. */
export const ModuleResolutionKind = {
  Classic: 1,
  Node10: 2,
  Node16: 3,
  NodeNext: 99,
  Bundler: 100,
} as const;

// TypeScript 7 renamed these guards.
export const isPropertySignature = isPropertySignatureDeclaration;
export const isMethodSignature = isMethodSignatureDeclaration;
export const isParameter = isParameterDeclaration;

const DECLARATION_STATEMENT_KINDS: ReadonlySet<Ts7SyntaxKind> = new Set([
  Ts7SyntaxKind.FunctionDeclaration,
  Ts7SyntaxKind.MissingDeclaration,
  Ts7SyntaxKind.ClassDeclaration,
  Ts7SyntaxKind.InterfaceDeclaration,
  Ts7SyntaxKind.TypeAliasDeclaration,
  Ts7SyntaxKind.EnumDeclaration,
  Ts7SyntaxKind.ModuleDeclaration,
  Ts7SyntaxKind.ImportDeclaration,
  Ts7SyntaxKind.ImportEqualsDeclaration,
  Ts7SyntaxKind.ExportDeclaration,
  Ts7SyntaxKind.ExportAssignment,
  Ts7SyntaxKind.NamespaceExportDeclaration,
]);
/** TypeScript 5's isDeclarationStatement (isDeclarationStatementKind). */
export const isDeclarationStatement = (node: Node): boolean =>
  DECLARATION_STATEMENT_KINDS.has(node.kind);

/** TypeScript 5's forEachChild(node, cbNode, cbNodes); TypeScript 7 has it as a node method. */
export const forEachChild = <T>(
  node: Node,
  cbNode: (node: Node) => T,
  cbNodes?: (nodes: NodeArray<Node>) => T,
): T | undefined => node.forEachChild(cbNode, cbNodes);

const nameProperty = (node: Node): DeclarationName | undefined => {
  const name: unknown = Reflect.get(node, "name");
  return name !== null && typeof name === "object" && "kind" in name
    ? (name as DeclarationName)
    : undefined;
};

/**
 * TypeScript 5's getNameOfDeclaration, for TypeScript files: JSDoc typedefs and JS-style
 * assignment declarations (`exports.x = …`) cannot occur in them.
 */
export const getNameOfDeclaration = (
  declaration: Node | undefined,
): DeclarationName | undefined => {
  if (declaration === undefined) {
    return undefined;
  }
  if (isIdentifier(declaration)) {
    return declaration;
  }
  if (declaration.kind === Ts7SyntaxKind.ExportAssignment) {
    const expression: unknown = Reflect.get(declaration, "expression");
    return expression !== null && typeof expression === "object" && isIdentifier(expression as Node)
      ? (expression as DeclarationName)
      : undefined;
  }
  const name = nameProperty(declaration);
  if (name !== undefined) {
    return name;
  }
  if (
    isFunctionExpression(declaration) ||
    isArrowFunction(declaration) ||
    isClassExpression(declaration)
  ) {
    // getAssignedName: the name the expression is assigned to.
    const parent = declaration.parent;
    switch (parent.kind) {
      case Ts7SyntaxKind.VariableDeclaration:
      case Ts7SyntaxKind.PropertyAssignment:
      case Ts7SyntaxKind.PropertyDeclaration:
      case Ts7SyntaxKind.BindingElement:
        return nameProperty(parent);
      default:
        return undefined;
    }
  }
  return undefined;
};

/** TypeScript 5's createScanner(languageVersion, skipTrivia, languageVariant, text, onError, start, length). */
export const createScanner = (
  _languageVersion: ScriptTarget,
  skipTrivia: boolean,
  languageVariant?: LanguageVariant,
  textInitial?: string,
  _onError?: unknown,
  start?: number,
  length?: number,
): Scanner => createScanner7(skipTrivia, languageVariant, textInitial, start, length);
