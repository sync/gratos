// What the core knows about @defer and @stream (docs/plan.html M4b). A schema that declares
// either directive runs queries through `legacyExecuteIncrementally` (plain `execute()` throws on
// such a schema), and every document validated against it must pass `NoIncrementalMutationsRule`,
// whether or not `incremental()` is installed: graphql 17.1 would return the initial result of a
// deferred mutation while its deferred work is still pending, and a `return()` would skip that
// work, so a write could outlive the shutdown drain or be dropped.
import { GraphQLDeferDirective, GraphQLError, GraphQLStreamDirective, visit } from "graphql";
import type { DirectiveNode, GraphQLSchema, SelectionSetNode, ValidationRule } from "graphql";

const DEFER = GraphQLDeferDirective.name;
const STREAM = GraphQLStreamDirective.name;

/** True for a `@defer` or `@stream` directive. */
export const isIncrementalDirective = (directive: DirectiveNode): boolean =>
  directive.name.value === DEFER || directive.name.value === STREAM;

/** True when the schema declares @defer or @stream (incremental() adds them). */
export const hasIncrementalDirectives = (schema: GraphQLSchema): boolean =>
  schema.getDirective(DEFER) !== undefined || schema.getDirective(STREAM) !== undefined;

/**
 * Rejects @defer and @stream on mutation operations, in the operation itself or in any fragment
 * it reaches (`getRecursivelyReferencedFragments`), whatever their `if` argument. The core runs
 * it on every document validated against a schema that declares either directive.
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
