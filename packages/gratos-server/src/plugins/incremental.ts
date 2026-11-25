// incremental(): `@defer` and `@stream` (docs/plan.html M4b). Grats never emits these directives,
// so the plugin adds GraphQLDeferDirective and GraphQLStreamDirective to the schema at startup
// (onServer + replaceSchema). Once the schema has them, the core's default executor is
// `legacyExecuteIncrementally` (plain `execute()` throws on such a schema), and incremental
// results go out as multipart/mixed; deferSpec=20220824.
//
// - It claims (returns an executor for) a query only when the selected operation, or a fragment it
//   reaches, uses @defer or @stream: never because of another operation in the document, and
//   never a subscription (subscriptions always run through graphql-js `subscribe()`).
// - @defer and @stream on mutation operations get a validation error (400): the core runs
//   NoIncrementalMutationsRule on every schema that declares either directive, so the rule holds
//   even for a schema that already had them without this plugin.
// - List it before jit(): graphql-jit inlines @defer. jit() also declines every operation that
//   uses @defer or @stream, so a deferred operation never reaches graphql-jit whatever the order.
import {
  GraphQLDeferDirective,
  GraphQLSchema,
  GraphQLStreamDirective,
  Kind,
  legacyExecuteIncrementally,
} from "graphql";
import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from "graphql";

import { isIncrementalDirective } from "../core/incremental.ts";
import type { Plugin } from "../core/types.ts";

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
