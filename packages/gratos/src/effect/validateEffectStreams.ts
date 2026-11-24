// Where Effect's wrappers may appear on output types (spec §4), checked on the document.
//
// A Stream outside a subscription is rejected. Upstream's validateAsyncIterable only
// checks `Subscription` and allows an AsyncIterable as a list on other types. `Effect.isEffect`
// is false for a Stream, so a Stream on a query would compile to `[T]` and fail at runtime.
// Plain `AsyncIterable` keeps upstream's behaviour; only lists marked `isEffectStream` are
// checked.
//
// On `Subscription`, a Stream is allowed only as the source: the field's outermost list.
// `Stream.Stream<Stream.Stream<A>>` or `AsyncIterable<Stream.Stream<A>>` would deliver each event
// as a Stream, which has no iterator protocol.
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
import {
  effectOnSubscription,
  streamInSubscriptionEvent,
  streamOutsideSubscription,
} from "./errors.ts";

/** The first list in a type marked as a `Stream.Stream`, outermost first. */
export const effectStreamIn = (type: TypeNode): TypeNode | null => {
  switch (type.kind) {
    case Kind.NON_NULL_TYPE:
      return effectStreamIn(type.type);
    case Kind.LIST_TYPE:
      return type.isEffectStream === true ? type : effectStreamIn(type.type);
    default:
      return null;
  }
};

/** The event type of a subscription field: the element of its source list, if it has one. */
const subscriptionEventType = (type: TypeNode): TypeNode | null => {
  const source = type.kind === Kind.NON_NULL_TYPE ? type.type : type;
  return source.kind === Kind.LIST_TYPE ? source.type : null;
};

export const validateEffectStreams = (doc: DocumentNode): DiagnosticsResult<DocumentNode> => {
  const errors: Array<DiagnosticWithLocation> = [];
  // A field an interface adds to each implementation is the same node: report it once.
  const reported = new Set<TypeNode>();
  const report = (node: TypeNode, message: string) => {
    if (!reported.has(node)) {
      reported.add(node);
      errors.push(gqlErr(node, message));
    }
  };
  const check = (typeName: string, fields: ReadonlyArray<FieldDefinitionNode> | undefined) => {
    if (typeName === "Subscription") {
      for (const field of fields ?? []) {
        if (field.returnsEffect === true) {
          report(field.type, effectOnSubscription());
          continue;
        }
        const event = subscriptionEventType(field.type);
        const stream = event === null ? null : effectStreamIn(event);
        if (stream !== null) {
          report(stream, streamInSubscriptionEvent());
        }
      }
      return;
    }
    for (const field of fields ?? []) {
      const stream = effectStreamIn(field.type);
      if (stream !== null) {
        report(stream, streamOutsideSubscription());
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
