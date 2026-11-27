// The renamed-import hint (docs/plan.html F2): only the qualified names `Effect.Effect` and
// `Stream.Stream` count (spec §4), so `Fx.Effect<A>` after `import { Effect as Fx } from "effect"`
// is not unwrapped. Instead of upstream's "Expected a name identifier", it gets a hint toward the
// qualified name. Detecting the renamed namespace is declined: it would change approved default 1.
//
// It reads only the file's own import declarations, never the imported module, so it works with
// third-party files read as empty (fast loading). Called from effectTypeReference, before
// upstream reports the qualified name.
import { isIdentifier, isImportDeclaration, isStringLiteral, SyntaxKind } from "#typescript";
import type { EntityName, ImportDeclaration } from "#typescript";

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
  if (!isWrapper(wrapper) || alias === wrapper) {
    return null;
  }
  const bound = typeName
    .getSourceFile()
    .statements.some(
      (statement) => isImportDeclaration(statement) && bindsWrapper(statement, alias, wrapper),
    );
  return bound ? renamedWrapperImport(alias, wrapper) : null;
};
