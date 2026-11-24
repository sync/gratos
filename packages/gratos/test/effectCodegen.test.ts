// Codegen rules for Effect-backed fields that no fixture can reach, because validation rejects
// the source first: the schema is built from SDL and the field marked as returning
// `Effect.Effect` by hand, as the extractor would mark it.
import { join } from "node:path";

import { buildASTSchema, Kind, parse, visit } from "graphql";
import type { DocumentNode } from "graphql";
import { describe, expect, it } from "vitest";

import "../src/effect/astExtensions.ts";
import { DEFAULT_GRATS_CONFIG } from "../src/effect/config.ts";
import { codegen } from "../src/upstream/codegen/schemaCodegen.ts";
import type { Metadata } from "../src/upstream/metadata.ts";

const SEMANTIC_NON_NULL = "directive @semanticNonNull(levels: [Int] = [0]) on FIELD_DEFINITION";

/** The document with every field named `fieldName` marked as returning `Effect.Effect`. */
const markReturnsEffect = (doc: DocumentNode, fieldName: string): DocumentNode =>
  visit(doc, {
    [Kind.FIELD_DEFINITION]: (node) =>
      node.name.value === fieldName ? { ...node, returnsEffect: true } : undefined,
  });

const generate = (sdl: string, fieldName: string, resolvers: Metadata): string =>
  codegen(
    buildASTSchema(markReturnsEffect(parse(sdl), fieldName)),
    resolvers,
    { ...DEFAULT_GRATS_CONFIG, strictSemanticNullability: true },
    join(import.meta.dirname, "schema.ts"),
  );

describe("Effect-backed field codegen", () => {
  it("keeps assertNonNull on a subscription's per-event resolve, even for an Effect source", () => {
    const ts = generate(
      `${SEMANTIC_NON_NULL}\ntype Query { ok: String }\ntype Subscription { names: String @semanticNonNull }`,
      "names",
      {
        types: {
          Query: { ok: { resolver: { kind: "property", name: null } } },
          Subscription: {
            names: {
              resolver: { kind: "function", path: "./names", exportName: "names", arguments: [] },
            },
          },
        },
      },
    );
    expect(ts).toContain("return assertNonNull(payload);");
    expect(ts).not.toContain("gratos");
  });
});
