// jit({ after: 3 }): runs an operation through graphql-jit once it has been used `after` times
// (docs/plan.html M4a). It declines, so graphql-js runs the operation, when:
// - the operation is a subscription (graphql-jit 0.10.1 passes wrong arguments to subscription
//   source resolvers);
// - the operation, or a fragment it reaches, uses @defer or @stream (graphql-jit inlines them, so
//   the client would get one payload instead of an incremental response);
// - a variable's type contains a @oneOf input, directly or nested (graphql-jit 0.10.1 accepts
//   empty, null-valued and multi-field oneOf inputs that graphql-js rejects);
// - the selection, including the fragments it reaches, touches a field marked
//   `extensions: { gratos: { jit: false } }` (Grats marks every resolver that takes a GqlInfo,
//   since graphql-jit's info has no getAbortSignal()), or a field `isSafe` rejects. Abstract types
//   are checked on every possible concrete type.
// The use count and the compiled query live per operation (`operationKey`), so a document holding
// a mutation and a query never shares a compilation. jit claims every operation it does not
// decline, and counts and compiles inside its executor, which the core calls only when no
// onExecute hook refused and the gate passed; until it takes over it hands the operation on
// (`next`: a later claim, else the default executor).
//
// Default resolvers: graphql-jit reads a field without a resolver as a plain property, where
// graphql-js' default resolver calls a function-valued property with (args, context, info). jit
// keeps graphql-jit's inlined reads, so it assumes every function-valued field has its own
// resolver. Grats schemas always do: a method field gets an explicit `resolve` (spec §8). A
// hand-written schema that relies on function properties, such as `rootValue: { hello: () => "hi" }`,
// must keep those fields on graphql-js with `isSafe`, or not use jit.
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
import { usesIncrementalDelivery } from "./incremental.ts";

/** A field and the type it is read on. */
export type FieldPredicate = (
  field: GraphQLField<unknown, unknown>,
  parentType: GraphQLObjectType | GraphQLInterfaceType,
) => boolean;

export interface JitOptions {
  /** The use on which an operation switches to graphql-jit. Default 3. */
  readonly after?: number;
  /**
   * Extra check for hand-written schemas: return false for fields that must stay on graphql-js,
   * for example a field without a resolver whose value is a function (graphql-jit reads it as a
   * value; graphql-js calls it).
   */
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
  // The (selection set, parent type) pairs already walked without finding an unsafe field. A
  // field on an interface is walked once per possible type, and its children usually share the
  // interface's field type, so without this a recursive selection (`next: Node` on an interface
  // with k implementations) would be walked (k + 1)^depth times. A walk that finds an unsafe field
  // ends the whole check, so only safe walks are remembered.
  const walked = new Map<SelectionSetNode, Set<GraphQLCompositeType>>();

  const walk = (selectionSet: SelectionSetNode, parent: GraphQLCompositeType): boolean => {
    if (walked.get(selectionSet)?.has(parent) === true) {
      return true;
    }
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
    const parents = walked.get(selectionSet);
    if (parents === undefined) {
      walked.set(selectionSet, new Set([parent]));
    } else {
      parents.add(parent);
    }
    return true;
  };

  const root = schema.getRootType(operation.operation);
  return root !== undefined && root !== null && walk(operation.selectionSet, root);
};

const DECLINED: JitState = { _tag: "declined" };

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
          operation.operation === "subscription" || usesIncrementalDelivery(document, operation)
            ? DECLINED
            : { _tag: "counting", uses: 0 };
        states.set(operationKey, state);
      }
      if (state._tag === "declined") {
        return undefined;
      }
      // jit claims the operation, but counts and compiles only when its executor is called: once
      // every onExecute hook has run without refusing and the gate has passed. During warm-up (or
      // when it declines) it runs the operation as it would run without jit (`next`).
      return (next) => {
        let current = states.get(operationKey) ?? DECLINED;
        if (current._tag === "counting") {
          current.uses += 1;
          if (current.uses < after) {
            return next();
          }
          const { schema } = args;
          if (
            usesOneOfVariable(schema, operation) ||
            !isSelectionSafe(schema, document, operation, isSafe)
          ) {
            current = DECLINED;
          } else {
            const start = performance.now();
            const compiled = compileQuery(schema, document, operationName ?? undefined);
            phase("jit", start, performance.now());
            current = isCompiledQuery(compiled) ? { _tag: "compiled", query: compiled } : DECLINED;
          }
          states.set(operationKey, current);
        }
        if (current._tag !== "compiled") {
          return next();
        }
        return current.query.query(args.rootValue, args.contextValue, args.variableValues);
      };
    },
  };
};
