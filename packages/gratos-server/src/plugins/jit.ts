// jit({ after: 3 }): runs an operation through graphql-jit once it has been used `after` times
// (docs/plan.html M4a). It declines, so graphql-js runs the operation, when:
// - the operation is a subscription (graphql-jit 0.10.1 passes wrong arguments to subscription
//   source resolvers);
// - a variable's type contains a @oneOf input, directly or nested (graphql-jit 0.10.1 accepts
//   empty, null-valued and multi-field oneOf inputs that graphql-js rejects);
// - the selection, including the fragments it reaches, touches a field marked
//   `extensions: { gratos: { jit: false } }` (Grats marks every resolver that takes a GqlInfo,
//   since graphql-jit's info has no getAbortSignal()), or a field `isSafe` rejects. Abstract types
//   are checked on every possible concrete type.
// The use count and the compiled query live per operation (`operationKey`), so a document holding
// a mutation and a query never shares a compilation.
import {
  getNamedType,
  isAbstractType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  Kind,
  typeFromAST,
} from "graphql";
import type {
  DocumentNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLField,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
} from "graphql";
import { compileQuery, isCompiledQuery } from "graphql-jit";
import type { CompiledQuery } from "graphql-jit";

import type { Plugin } from "../core/types.ts";

/** A field and the type it is read on. */
export type FieldPredicate = (
  field: GraphQLField<unknown, unknown>,
  parentType: GraphQLObjectType | GraphQLInterfaceType,
) => boolean;

export interface JitOptions {
  /** The use on which an operation switches to graphql-jit. Default 3. */
  readonly after?: number;
  /** Extra check for hand-written schemas: return false for fields that must stay on graphql-js. */
  readonly isSafe?: FieldPredicate;
}

type JitState =
  | { readonly _tag: "counting"; uses: number }
  | { readonly _tag: "declined" }
  | { readonly _tag: "compiled"; readonly query: CompiledQuery };

/** True when the field carries `extensions.gratos.jit === false`. */
export const isJitDisabled = (field: GraphQLField<unknown, unknown>): boolean => {
  const gratos: unknown = field.extensions["gratos"];
  return typeof gratos === "object" && gratos !== null && "jit" in gratos && gratos.jit === false;
};

const containsOneOf = (
  type: GraphQLInputObjectType,
  visited: Set<GraphQLInputObjectType>,
): boolean => {
  if (visited.has(type)) {
    return false;
  }
  visited.add(type);
  if (type.isOneOf) {
    return true;
  }
  for (const field of Object.values(type.getFields())) {
    const named = getNamedType(field.type);
    if (isInputObjectType(named) && containsOneOf(named, visited)) {
      return true;
    }
  }
  return false;
};

/** True when a variable's type contains a @oneOf input object, directly or nested. */
export const usesOneOfVariable = (
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
): boolean => {
  const visited = new Set<GraphQLInputObjectType>();
  for (const definition of operation.variableDefinitions ?? []) {
    const type = typeFromAST(schema, definition.type);
    const named = type === undefined ? undefined : getNamedType(type);
    if (named !== undefined && isInputObjectType(named) && containsOneOf(named, visited)) {
      return true;
    }
  }
  return false;
};

/** The concrete and interface types a selection on `type` can read fields from. */
const typesToCheck = (
  schema: GraphQLSchema,
  type: GraphQLCompositeType,
): ReadonlyArray<GraphQLObjectType | GraphQLInterfaceType> => {
  if (isObjectType(type)) {
    return [type];
  }
  const possible = isAbstractType(type) ? schema.getPossibleTypes(type) : [];
  return isInterfaceType(type) ? [type, ...possible] : possible;
};

/**
 * True when every field the operation selects (through reachable fragments, on every possible
 * concrete type of an abstract type) is safe to run on graphql-jit.
 */
export const isSelectionSafe = (
  schema: GraphQLSchema,
  document: DocumentNode,
  operation: OperationDefinitionNode,
  isSafe: FieldPredicate,
): boolean => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const visitedFragments = new Set<string>();
  const checked = new Set<string>();

  const walk = (selectionSet: SelectionSetNode, parent: GraphQLCompositeType): boolean => {
    for (const selection of selectionSet.selections) {
      switch (selection.kind) {
        case Kind.FIELD: {
          const name = selection.name.value;
          if (name.startsWith("__")) {
            continue;
          }
          for (const type of typesToCheck(schema, parent)) {
            const field = type.getFields()[name];
            if (field === undefined) {
              continue;
            }
            const key = `${type.name}.${name}`;
            if (!checked.has(key)) {
              checked.add(key);
              if (isJitDisabled(field) || !isSafe(field, type)) {
                return false;
              }
            }
            const child = getNamedType(field.type);
            if (
              selection.selectionSet !== undefined &&
              (isObjectType(child) || isAbstractType(child)) &&
              !walk(selection.selectionSet, child)
            ) {
              return false;
            }
          }
          break;
        }
        case Kind.INLINE_FRAGMENT: {
          const condition =
            selection.typeCondition === undefined
              ? parent
              : schema.getType(selection.typeCondition.name.value);
          if (
            condition !== undefined &&
            (isObjectType(condition) || isAbstractType(condition)) &&
            !walk(selection.selectionSet, condition)
          ) {
            return false;
          }
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const name = selection.name.value;
          if (visitedFragments.has(name)) {
            continue;
          }
          visitedFragments.add(name);
          const fragment = fragments.get(name);
          const condition =
            fragment === undefined ? undefined : schema.getType(fragment.typeCondition.name.value);
          if (
            fragment !== undefined &&
            condition !== undefined &&
            (isObjectType(condition) || isAbstractType(condition)) &&
            !walk(fragment.selectionSet, condition)
          ) {
            return false;
          }
          break;
        }
      }
    }
    return true;
  };

  const root = schema.getRootType(operation.operation);
  return root !== undefined && root !== null && walk(operation.selectionSet, root);
};

export const jit = (options: JitOptions = {}): Plugin => {
  const after = Math.max(1, options.after ?? 3);
  const isSafe: FieldPredicate = options.isSafe ?? (() => true);
  const states = new WeakMap<object, JitState>();
  return {
    name: "jit",
    onExecute: ({ operation, document, operationName, operationKey, phase }, args) => {
      let state = states.get(operationKey);
      if (state === undefined) {
        state =
          operation.operation === "subscription"
            ? { _tag: "declined" }
            : { _tag: "counting", uses: 0 };
        states.set(operationKey, state);
      }
      if (state._tag === "counting") {
        state.uses += 1;
        if (state.uses < after) {
          return undefined;
        }
        const { schema } = args;
        if (
          usesOneOfVariable(schema, operation) ||
          !isSelectionSafe(schema, document, operation, isSafe)
        ) {
          state = { _tag: "declined" };
        } else {
          const start = performance.now();
          const compiled = compileQuery(schema, document, operationName ?? undefined);
          phase("jit", start, performance.now());
          state = isCompiledQuery(compiled)
            ? { _tag: "compiled", query: compiled }
            : { _tag: "declined" };
        }
        states.set(operationKey, state);
      }
      if (state._tag !== "compiled") {
        return undefined;
      }
      const { query } = state;
      return () => query.query(args.rootValue, args.contextValue, args.variableValues);
    },
  };
};
