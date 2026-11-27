// The renamed-import hint (docs/plan.html F2): only the qualified names `Effect.Effect` and
// `Stream.Stream` count (spec §4), so `Fx.Effect<A>` after `import { Effect as Fx } from "effect"`
// is not unwrapped. Instead of upstream's "Expected a name identifier", it gets a hint toward the
// qualified name. Detecting the renamed namespace is declined: it would change approved default 1.
//
// It reads only the file's own import declarations, never the imported module, so it works with
// third-party files read as empty (fast loading). Called from effectTypeReference, before
// upstream reports the qualified name.
import {
  isEnumDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isSourceFile,
  isStringLiteral,
  SyntaxKind,
} from "#typescript";
import type { EntityName, ImportDeclaration, Node, Statement } from "#typescript";

import { renamedWrapperImport } from "./errors.ts";
import type { EffectWrapper } from "./wrappers.ts";

const isWrapper = (name: string): name is EffectWrapper => name === "Effect" || name === "Stream";

/**
 * Whether `declaration` binds `alias` to the `wrapper` namespace under another name:
 * `import { Effect as Fx } from "effect"`, or `import * as Fx from "effect/Effect"` (only the
 * wrapper's own module: `import * as S from "effect/Schema"` binds no wrapper).
 */
const bindsWrapper = (
  declaration: ImportDeclaration,
  alias: string,
  wrapper: EffectWrapper,
): boolean => {
  const bindings = declaration.importClause?.namedBindings;
  if (bindings === undefined || !isStringLiteral(declaration.moduleSpecifier)) {
    return false;
  }
  const module = declaration.moduleSpecifier.text;
  // By kind: on TypeScript 7 a NamespaceImport also has an `elements` property.
  if (bindings.kind === SyntaxKind.NamespaceImport) {
    return bindings.name.text === alias && module === `effect/${wrapper}`;
  }
  return (
    module === "effect" &&
    bindings.elements.some(
      (element) => element.name.text === alias && element.propertyName?.text === wrapper,
    )
  );
};

/** Whether `statements` declare `alias` as a name `alias.X` can resolve through in a type. */
const declares = (statements: ReadonlyArray<Statement>, alias: string): boolean =>
  statements.some(
    (statement) =>
      (isModuleDeclaration(statement) ||
        isImportEqualsDeclaration(statement) ||
        isEnumDeclaration(statement)) &&
      isIdentifier(statement.name) &&
      statement.name.text === alias,
  );

/**
 * The statements of every block of the namespace `path` among `statements`. A namespace may be
 * declared in several blocks, which TypeScript merges, and a dotted `namespace A.B {}` nests one
 * declaration in another.
 */
const namespaceBodies = (
  statements: ReadonlyArray<Statement>,
  path: ReadonlyArray<string>,
): Array<ReadonlyArray<Statement>> => {
  const [head, ...rest] = path;
  if (head === undefined) {
    return [statements];
  }
  const bodies: Array<ReadonlyArray<Statement>> = [];
  for (const statement of statements) {
    if (
      !isModuleDeclaration(statement) ||
      !isIdentifier(statement.name) ||
      statement.name.text !== head
    ) {
      continue;
    }
    const { body } = statement;
    if (body !== undefined && isModuleBlock(body)) {
      bodies.push(...namespaceBodies(body.statements, rest));
    } else if (body !== undefined && isModuleDeclaration(body)) {
      bodies.push(...namespaceBodies([body], rest));
    }
  }
  return bodies;
};

/**
 * Whether a namespace enclosing `node` declares `alias` itself (`namespace Fx {}`,
 * `import Fx = …` or `enum Fx {}`), in any of its merged blocks, so `Fx` there is not the file's
 * import. Only a namespace can shadow a file-level name this way: a top-level declaration of the
 * same name would conflict with the import. Conservative: a declaration in another block of the
 * same namespace counts whether or not it is exported, so a doubtful name gets upstream's error,
 * never a wrong hint. Namespaces merge across files only in scripts, and a file with imports is a
 * module.
 */
const isShadowed = (node: Node, alias: string): boolean => {
  const path: Array<string> = [];
  for (let current = node.parent; !isSourceFile(current); current = current.parent) {
    if (isModuleDeclaration(current) && isIdentifier(current.name)) {
      path.unshift(current.name.text);
    }
  }
  const { statements } = node.getSourceFile();
  for (let depth = path.length; depth > 0; depth--) {
    if (namespaceBodies(statements, path.slice(0, depth)).some((body) => declares(body, alias))) {
      return true;
    }
  }
  return false;
};

/**
 * The hint for a type name written as `Alias.Effect` (or `Alias.Stream`), where the file's own
 * imports bind `Alias` to that namespace of `effect` under another name, or `null` for any other
 * name.
 */
export const renamedWrapperHint = (typeName: EntityName): string | null => {
  if (isIdentifier(typeName) || !isIdentifier(typeName.left)) {
    return null;
  }
  const alias = typeName.left.text;
  const wrapper = typeName.right.text;
  if (!isWrapper(wrapper) || alias === wrapper || isShadowed(typeName, alias)) {
    return null;
  }
  const bound = typeName
    .getSourceFile()
    .statements.some(
      (statement) => isImportDeclaration(statement) && bindsWrapper(statement, alias, wrapper),
    );
  return bound ? renamedWrapperImport(alias, wrapper) : null;
};
