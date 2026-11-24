// Helpers for the few engine call sites where TypeScript 7 nodes differ from TypeScript 5's.
//
// They import the facade as `#typescript`, so the same code runs on both implementations: the
// TypeScript 7 port at runtime, and TypeScript 5.9.2 in the parity run. The engine calls them
// instead of reading `comment` on JSDoc nodes and instead of `node.getChildren()`.
import {
  createScanner,
  forEachChild,
  forEachLeadingCommentRange,
  isTokenKind,
  ScriptTarget,
  SyntaxKind,
} from "#typescript";
import type {
  JSDocComment,
  LanguageVariant,
  Node,
  NodeArray,
  QuestionToken,
  SourceFile,
} from "#typescript";

type JSDocCommentValue = string | NodeArray<JSDocComment> | undefined;

/**
 * The `comment` of a JSDoc node or tag, shaped as TypeScript 5 shapes it: `undefined` when
 * empty, a string when it is plain text, and the node array only when it contains links.
 * TypeScript 7 always produces a node array.
 */
export const jsDocComment = (node: { readonly comment?: JSDocCommentValue }): JSDocCommentValue => {
  const comment = node.comment;
  if (comment === undefined || typeof comment === "string") {
    return comment;
  }
  if (comment.length === 0) {
    return undefined;
  }
  let text = "";
  for (let i = 0; i < comment.length; i++) {
    const part = comment[i];
    if (part?.kind !== SyntaxKind.JSDocText) {
      return comment;
    }
    text += part.text;
  }
  return text;
};

/**
 * Where a JSDoc comment's text starts (its `/**`). TypeScript 5's JSDoc node starts there;
 * TypeScript 7's starts at its host's full start, before the leading trivia.
 */
export const jsDocCommentStart = (jsDoc: Node): number =>
  forEachLeadingCommentRange(jsDoc.getSourceFile().text, jsDoc.pos, (pos, end) =>
    end === jsDoc.end ? pos : undefined,
  ) ?? jsDoc.pos;

/**
 * The `?` of a property or method declaration or signature. TypeScript 7 stores it as
 * `postfixToken` (which can also be a `!`); TypeScript 5 as `questionToken`.
 */
export const questionTokenOf = (node: {
  readonly questionToken?: QuestionToken | undefined;
}): QuestionToken | undefined => {
  if (node.questionToken !== undefined) {
    return node.questionToken;
  }
  const postfix: { readonly kind?: unknown } | undefined = Reflect.get(node, "postfixToken");
  // The kind check makes it a QuestionToken.
  return postfix?.kind === SyntaxKind.QuestionToken ? (postfix as QuestionToken) : undefined;
};

/** A token synthesized from the scanner, as TypeScript 5's services create for getChildren. */
interface SyntheticToken {
  readonly kind: SyntaxKind;
  readonly pos: number;
  readonly end: number;
  readonly parent: Node;
}
/** A child as getChildren returns it: a node, a synthesized token, or a SyntaxList. */
type Child = Node | SyntheticToken | SyntaxList;
interface SyntaxList {
  readonly kind: SyntaxKind.SyntaxList;
  readonly pos: number;
  readonly end: number;
  readonly parent: Node;
  readonly children: ReadonlyArray<Child>;
}

const scanner = createScanner(ScriptTarget.Latest, /* skipTrivia */ true);

const isJSDocCommentContainingNode = (node: Node): boolean =>
  node.kind === SyntaxKind.JSDoc ||
  node.kind === SyntaxKind.JSDocText ||
  node.kind === SyntaxKind.JSDocLink ||
  node.kind === SyntaxKind.JSDocLinkCode ||
  node.kind === SyntaxKind.JSDocLinkPlain ||
  node.kind === SyntaxKind.JSDocTypeLiteral ||
  node.kind === SyntaxKind.JSDocSignature ||
  (node.kind >= SyntaxKind.FirstJSDocTagNode && node.kind <= SyntaxKind.LastJSDocTagNode);

const addSyntheticNodes = (
  children: Array<Child>,
  start: number,
  end: number,
  parent: Node,
): void => {
  let pos = start;
  scanner.resetTokenState(pos);
  while (pos < end) {
    const token = scanner.scan();
    const textPos = scanner.getTokenEnd();
    // An identifier in trivia only happens in TypeScript 5's tabstop nodes, which the engine
    // never sees; TypeScript 5 skips or fails on it. Skip it.
    if (textPos <= end && token !== SyntaxKind.Identifier) {
      children.push({ kind: token, pos, end: textPos, parent });
    }
    pos = textPos;
    if (token === SyntaxKind.EndOfFileToken) {
      break;
    }
  }
};

const createSyntaxList = (nodes: NodeArray<Node>, parent: Node): SyntaxList => {
  const children: Array<Child> = [];
  let pos = nodes.pos;
  for (const node of nodes) {
    addSyntheticNodes(children, pos, node.pos, parent);
    children.push(node);
    pos = node.end;
  }
  addSyntheticNodes(children, pos, nodes.end, parent);
  return { kind: SyntaxKind.SyntaxList, pos: nodes.pos, end: nodes.end, parent, children };
};

const isSyntaxList = (child: Child): child is SyntaxList => child.kind === SyntaxKind.SyntaxList;

/**
 * TypeScript 5's `node.getChildren(sourceFile)` (services/services.ts createChildren): the
 * node's children with the tokens between them synthesized by the scanner. TypeScript 7 nodes
 * have no getChildren. Synthesized tokens and syntax lists carry only `kind`, `pos`, `end` and
 * `parent`, which is all a token walk reads; they are typed as nodes, as TypeScript 5 types them.
 */
export const getChildren = (node: Node, sourceFile: SourceFile): Array<Node> => {
  const children = childrenOf(node, sourceFile);
  return children as Array<Node>;
};

const childrenOf = (child: Child, sourceFile: SourceFile): ReadonlyArray<Child> => {
  if (isSyntaxList(child)) {
    return child.children;
  }
  if (!("getSourceFile" in child)) {
    return [];
  }
  const node: Node = child;
  const children: Array<Child> = [];
  if (isJSDocCommentContainingNode(node)) {
    forEachChild(node, (each) => {
      children.push(each);
    });
    return children;
  }
  const languageVariant: LanguageVariant = sourceFile.languageVariant;
  scanner.setText(sourceFile.text);
  scanner.setLanguageVariant(languageVariant);
  let pos = node.pos;
  const processNode = (each: Node): void => {
    addSyntheticNodes(children, pos, each.pos, node);
    children.push(each);
    pos = each.end;
  };
  const processNodes = (nodes: NodeArray<Node>): void => {
    addSyntheticNodes(children, pos, nodes.pos, node);
    children.push(createSyntaxList(nodes, node));
    pos = nodes.end;
  };
  const jsDoc: ReadonlyArray<Node> | undefined = Reflect.get(node, "jsDoc");
  for (const each of jsDoc ?? []) {
    processNode(each);
  }
  pos = node.pos;
  forEachChild(node, processNode, processNodes);
  addSyntheticNodes(children, pos, node.end, node);
  scanner.setText(undefined);
  return children;
};

export { isTokenKind };
