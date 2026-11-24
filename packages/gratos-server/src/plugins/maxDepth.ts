// maxDepth(limit): refuses an operation whose selection (following fragments) is nested deeper
// than `limit` fields, with a 400 before anything runs. The depth is computed once per operation
// (`operationKey`). It never claims an operation.
import { Kind } from "graphql";
import type { DocumentNode, FragmentDefinitionNode, SelectionSetNode } from "graphql";

import { gqlError } from "../core/errors.ts";
import type { Plugin } from "../core/types.ts";

/** The deepest field nesting of a selection set (a leaf field at the root has depth 1). */
export const selectionDepth = (document: DocumentNode, selectionSet: SelectionSetNode): number => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const depthOf = (set: SelectionSetNode, seen: ReadonlySet<string>): number => {
    let deepest = 0;
    for (const selection of set.selections) {
      switch (selection.kind) {
        case Kind.FIELD:
          deepest = Math.max(
            deepest,
            1 + (selection.selectionSet === undefined ? 0 : depthOf(selection.selectionSet, seen)),
          );
          break;
        case Kind.INLINE_FRAGMENT:
          deepest = Math.max(deepest, depthOf(selection.selectionSet, seen));
          break;
        case Kind.FRAGMENT_SPREAD: {
          const fragment = fragments.get(selection.name.value);
          if (fragment !== undefined && !seen.has(fragment.name.value)) {
            deepest = Math.max(
              deepest,
              depthOf(fragment.selectionSet, new Set([...seen, fragment.name.value])),
            );
          }
          break;
        }
      }
    }
    return deepest;
  };
  return depthOf(selectionSet, new Set());
};

export const maxDepth = (limit: number): Plugin => {
  const depths = new WeakMap<object, number>();
  return {
    name: "maxDepth",
    onExecute: ({ operation, document, operationKey }) => {
      let depth = depths.get(operationKey);
      if (depth === undefined) {
        depth = selectionDepth(document, operation.selectionSet);
        depths.set(operationKey, depth);
      }
      if (depth > limit) {
        throw gqlError(
          `The operation is nested ${depth} levels deep; the limit is ${limit}.`,
          400,
          {
            code: "MAX_DEPTH_EXCEEDED",
          },
        );
      }
      return undefined;
    },
  };
};
