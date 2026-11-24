// Effect and Stream fields are rejected when `EXPERIMENTAL__emitResolverMap` is on.
//
// The Gratos Effect layer (docs/plan.html M5) runs an Effect by wrapping a field's generated
// `resolve`, reads the `gratos` extensions markers (`semanticNonNull`, `jit`) from the field
// config, and turns a `Stream.Stream` subscription source into an AsyncIterable by wrapping its
// `subscribe`. The experimental resolver map has none of these: a field is a bare function with
// no extensions, and a subscription field is a plain resolver that returns the Stream, with no
// `subscribe`. Rather than emit a map the Effect layer cannot run, the option rejects them.
//
// Runs in the engine's pipeline just after validateEffectStreams, which has already rejected a
// Stream anywhere but as a subscription's source.
import { Kind } from "graphql";
import type { DocumentNode, FieldDefinitionNode, TypeNode } from "graphql";

import type { DiagnosticWithLocation } from "#typescript";

import type { GratsConfig } from "../upstream/gratsConfig.ts";
import { gqlErr } from "../upstream/utils/DiagnosticError.ts";
import type { DiagnosticsResult } from "../upstream/utils/DiagnosticError.ts";
import { err, ok } from "../upstream/utils/Result.ts";
import "./astExtensions.ts";
import { effectWithResolverMap, streamWithResolverMap } from "./errors.ts";
import { effectStreamIn } from "./validateEffectStreams.ts";

export const validateEffectResolverMap = (
  doc: DocumentNode,
  config: Pick<GratsConfig, "EXPERIMENTAL__emitResolverMap">,
): DiagnosticsResult<DocumentNode> => {
  if (!config.EXPERIMENTAL__emitResolverMap) {
    return ok(doc);
  }
  const errors: Array<DiagnosticWithLocation> = [];
  // A field an interface adds to each implementation is the same node: report it once.
  const reported = new Set<TypeNode>();
  const check = (fields: ReadonlyArray<FieldDefinitionNode> | undefined) => {
    for (const field of fields ?? []) {
      const stream = effectStreamIn(field.type);
      const node = field.returnsEffect === true ? field.type : stream;
      if (node === null || reported.has(node)) {
        continue;
      }
      reported.add(node);
      errors.push(
        gqlErr(
          node,
          field.returnsEffect === true ? effectWithResolverMap() : streamWithResolverMap(),
        ),
      );
    }
  };
  for (const definition of doc.definitions) {
    switch (definition.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
      case Kind.OBJECT_TYPE_EXTENSION:
      case Kind.INTERFACE_TYPE_DEFINITION:
      case Kind.INTERFACE_TYPE_EXTENSION:
        check(definition.fields);
        break;
      default:
        break;
    }
  }
  return errors.length > 0 ? err(errors) : ok(doc);
};
