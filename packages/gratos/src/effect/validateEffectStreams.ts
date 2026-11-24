// Where Effect's wrappers may appear on output types (spec §4), checked on the document.
//
// A Stream outside a subscription is rejected. Upstream's validateAsyncIterable only
// checks `Subscription` and allows an AsyncIterable as a list on other types. `Effect.isEffect`
// is false for a Stream, so a Stream on a query would compile to `[T]` and fail at runtime.
// Plain `AsyncIterable` keeps upstream's behaviour; only lists marked `isEffectStream` are
// checked.
//
// An Effect on a subscription field is rejected too: the subscription source must be a
// `Stream.Stream` (or an AsyncIterable). `Effect.Effect<AsyncIterable<A>>` would otherwise compile
// as a subscription whose source is never run, and whose per-event resolve would lose its
// `assertNonNull` to the Effect-backed field rule (src/effect/codegen.ts).
//
// Runs in the engine's pipeline just before validateAsyncIterable.
import { Kind } from "graphql";
import type { DocumentNode, FieldDefinitionNode, TypeNode } from "graphql";

import type { DiagnosticWithLocation } from "#typescript";

import { gqlErr } from "../upstream/utils/DiagnosticError.ts";
import type { DiagnosticsResult } from "../upstream/utils/DiagnosticError.ts";
import { err, ok } from "../upstream/utils/Result.ts";
import "./astExtensions.ts";
import { effectOnSubscription, streamOutsideSubscription } from "./errors.ts";

/** The first list in a type marked as a `Stream.Stream`, outermost first. */
const effectStreamIn = (type: TypeNode): TypeNode | null => {
  switch (type.kind) {
    case Kind.NON_NULL_TYPE:
      return effectStreamIn(type.type);
    case Kind.LIST_TYPE:
      return type.isEffectStream === true ? type : effectStreamIn(type.type);
    default:
      return null;
  }
};

export const validateEffectStreams = (doc: DocumentNode): DiagnosticsResult<DocumentNode> => {
  const errors: Array<DiagnosticWithLocation> = [];
  const check = (typeName: string, fields: ReadonlyArray<FieldDefinitionNode> | undefined) => {
    if (typeName === "Subscription") {
      for (const field of fields ?? []) {
        if (field.returnsEffect === true) {
          errors.push(gqlErr(field.type, effectOnSubscription()));
        }
      }
      return;
    }
    for (const field of fields ?? []) {
      const stream = effectStreamIn(field.type);
      if (stream !== null) {
        errors.push(gqlErr(stream, streamOutsideSubscription()));
      }
    }
  };
  for (const definition of doc.definitions) {
    switch (definition.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
      case Kind.OBJECT_TYPE_EXTENSION:
      case Kind.INTERFACE_TYPE_DEFINITION:
      case Kind.INTERFACE_TYPE_EXTENSION:
        check(definition.name.value, definition.fields);
        break;
      default:
        break;
    }
  }
  return errors.length > 0 ? err(errors) : ok(doc);
};
