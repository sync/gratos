// incremental(): `@defer` and `@stream` (docs/plan.html M4b). Grats never emits these directives,
// so the plugin adds GraphQLDeferDirective and GraphQLStreamDirective to the schema at startup
// (onServer + replaceSchema). Once the schema has them, the core's default executor is
// `legacyExecuteIncrementally` (plain `execute()` throws on such a schema), and incremental
// results go out as multipart/mixed; deferSpec=20220824.
//
// - It claims (returns an executor for) a query only when the selected operation, or a fragment it
//   reaches, uses @defer or @stream: never because of another operation in the document, and
//   never a subscription (subscriptions always run through graphql-js `subscribe()`).
// - It rejects @defer and @stream on mutation operations with a validation error (400). graphql
//   17.1 would return the initial result while deferred mutation work is still pending, and a
//   `return()` would skip that work, so a write could outlive the shutdown drain or be dropped.
// - List it before jit(): graphql-jit inlines @defer. jit() also declines every operation that
//   uses @defer or @stream, so a deferred operation never reaches graphql-jit whatever the order.
import {
  GraphQLDeferDirective,
  GraphQLError,
  GraphQLSchema,
  GraphQLStreamDirective,
  Kind,
  legacyExecuteIncrementally,
  visit,
} from "graphql";
import type {
  DirectiveNode,
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationRule,
} from "graphql";

import type { Plugin } from "../core/types.ts";

const DEFER = GraphQLDeferDirective.name;
const STREAM = GraphQLStreamDirective.name;

const isIncrementalDirective = (directive: DirectiveNode): boolean =>
  directive.name.value === DEFER || directive.name.value === STREAM;

/**
 * True when the operation, or a fragment it reaches (through any depth of named fragments), uses
 * @defer or @stream. Other operations of the document, and fragments only they reach, do not
 * count.
 */
export const usesIncrementalDelivery = (
  document: DocumentNode,
  operation: OperationDefinitionNode,
): boolean => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const visited = new Set<string>();
  const walk = (selectionSet: SelectionSetNode): boolean => {
    for (const selection of selectionSet.selections) {
      if (selection.directives?.some(isIncrementalDirective) === true) {
        return true;
      }
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        const fragment = fragments.get(name);
        if (!visited.has(name) && fragment !== undefined) {
          visited.add(name);
          if (walk(fragment.selectionSet)) {
            return true;
          }
        }
      } else if (selection.selectionSet !== undefined && walk(selection.selectionSet)) {
        return true;
      }
    }
    return false;
  };
  return walk(operation.selectionSet);
};

/**
 * Rejects @defer and @stream on mutation operations, in the operation itself or in any fragment
 * it reaches (`getRecursivelyReferencedFragments`), whatever their `if` argument.
 */
export const NoIncrementalMutationsRule: ValidationRule = (context) => ({
  OperationDefinition: (operation) => {
    if (operation.operation !== "mutation") {
      return undefined;
    }
    const name = operation.name === undefined ? "" : ` "${operation.name.value}"`;
    const check = (selectionSet: SelectionSetNode): void => {
      visit(selectionSet, {
        Directive: (directive) => {
          if (isIncrementalDirective(directive)) {
            context.reportError(
              new GraphQLError(
                `@${directive.name.value} is not supported on mutations: remove it from mutation${name}.`,
                { nodes: [directive] },
              ),
            );
          }
        },
      });
    };
    check(operation.selectionSet);
    for (const fragment of context.getRecursivelyReferencedFragments(operation)) {
      check(fragment.selectionSet);
    }
    return undefined;
  },
});

/** The schema with @defer and @stream added (the same schema when it already has both). */
export const withIncrementalDirectives = (schema: GraphQLSchema): GraphQLSchema => {
  const missing = [GraphQLDeferDirective, GraphQLStreamDirective].filter(
    (directive) => schema.getDirective(directive.name) === undefined,
  );
  if (missing.length === 0) {
    return schema;
  }
  const config = schema.toConfig();
  return new GraphQLSchema({ ...config, directives: [...config.directives, ...missing] });
};

export const incremental = (): Plugin => {
  // Whether each operation uses @defer/@stream, per operationKey (one walk per cached document).
  const uses = new WeakMap<object, boolean>();
  return {
    name: "incremental",
    validationRules: [NoIncrementalMutationsRule],
    onServer: ({ schema, control }) => {
      const next = withIncrementalDirectives(schema);
      if (next !== schema) {
        control.replaceSchema(next);
      }
    },
    onExecute: ({ operation, document, operationKey }, args) => {
      // Subscriptions stay on subscribe(); mutations never get here with @defer (validation).
      if (operation.operation !== "query") {
        return undefined;
      }
      let used = uses.get(operationKey);
      if (used === undefined) {
        used = usesIncrementalDelivery(document, operation);
        uses.set(operationKey, used);
      }
      return used ? () => legacyExecuteIncrementally(args) : undefined;
    },
  };
};
