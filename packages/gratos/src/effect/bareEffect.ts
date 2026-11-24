// The bare-`Effect` hint (spec §4, default "Wrapper names"): a bare `Effect<…>` is not unwrapped,
// because only the qualified `Effect.Effect` counts. When the bare name is an import from
// `effect` or `effect/*`, the "unresolved type" error becomes a hint toward `Effect.Effect`.
//
// It reads only the import declaration that binds the name, never the imported module, so it
// works with third-party files read as empty (fast loading). Called from TypeContext before it
// resolves an unresolved type reference.
import {
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isStringLiteral,
  SymbolFlags,
} from "#typescript";
import type { EntityName, Node, Symbol as TsSymbol, TypeChecker } from "#typescript";

import { bareEffectType } from "./errors.ts";

/** `effect` itself or one of its subpath modules, such as `effect/Effect`. */
const isEffectModule = (specifier: string): boolean =>
  specifier === "effect" || specifier.startsWith("effect/");

/** The name a declaration imports: `Effect` in `import { Effect }` and `import { Effect as X }`. */
const importedName = (declaration: Node): string | null => {
  if (!isImportSpecifier(declaration)) {
    return null;
  }
  return (declaration.propertyName ?? declaration.name).text;
};

/** The module specifier of the import declaration that holds `declaration`, if any. */
const importModuleOf = (declaration: Node): string | null => {
  let node: Node | undefined = declaration;
  while (node !== undefined && !isImportDeclaration(node)) {
    node = node.parent;
  }
  return node !== undefined && isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
};

const isAlias = (symbol: TsSymbol): boolean => (symbol.flags & SymbolFlags.Alias) !== 0;

/**
 * The import specifier in the reference's own file that binds `name`.
 */
const importSpecifierBinding = (reference: Node, name: string): Node | undefined => {
  for (const statement of reference.getSourceFile().statements) {
    if (!isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !("elements" in bindings)) {
      continue;
    }
    const specifier = bindings.elements.find((element) => element.name.text === name);
    if (specifier !== undefined) {
      return specifier;
    }
  }
  return undefined;
};

const isEffectImportSpecifier = (declaration: Node): boolean => {
  if (importedName(declaration) !== "Effect") {
    return false;
  }
  const specifier = importModuleOf(declaration);
  return specifier !== null && isEffectModule(specifier);
};

/**
 * The hint for a type reference written as a bare `Effect` imported from `effect` (or
 * `effect/*`), or `null` for any other reference. The checker gives the alias the name resolves
 * to. A name it resolves to no declaration at all (such as the `Effect` namespace, which `effect`
 * re-exports with `export * as`) is looked up in the file's own imports instead.
 */
export const bareEffectHint = (checker: TypeChecker, typeName: EntityName): string | null => {
  if (!isIdentifier(typeName)) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(typeName);
  const declaration =
    symbol !== undefined && isAlias(symbol)
      ? symbol.declarations?.[0]
      : (symbol?.declarations?.length ?? 0) === 0
        ? importSpecifierBinding(typeName, typeName.text)
        : undefined;
  return declaration !== undefined && isEffectImportSpecifier(declaration)
    ? bareEffectType()
    : null;
};
