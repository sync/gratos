// An optional method field (`name?(): T`) runs end to end: generate() writes the schema for a
// real project, and a query against a source that omits the method resolves it to null without
// an error, as graphql-js' default resolver did for upstream Grats. A plain call in the explicit
// resolve (spec §8) would throw "source.nickname is not a function" instead.
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { graphql, isSchema } from "graphql";
import type { GraphQLSchema } from "graphql";

import { generate } from "../src/generate.ts";

import { scratchProject } from "./support/scratch.ts";

/** The generated schema.ts exports `getSchema()`; isSchema checks what it returns. */
type GetSchema = () => GraphQLSchema;
const isGetSchema = (value: unknown): value is GetSchema => Predicate.isFunction(value);

/** The schema exported by a generated schema.ts module. */
const schemaOf = (schemaModule: unknown): GraphQLSchema => {
  if (!Predicate.hasProperty(schemaModule, "getSchema") || !isGetSchema(schemaModule.getSchema)) {
    throw new Error("schema.ts does not export getSchema()");
  }
  const schema = schemaModule.getSchema();
  if (!isSchema(schema)) {
    throw new Error("getSchema() did not return a GraphQLSchema");
  }
  return schema;
};

describe("an optional method field", () => {
  it.effect("resolves to null without an error when the source omits the method", () => {
    const project = scratchProject("optional-method", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          allowImportingTsExtensions: true,
          noEmit: true,
        },
        include: ["*.ts"],
        grats: {
          graphqlSchema: "./schema.graphql",
          tsSchema: "./schema.ts",
          importModuleSpecifierEnding: ".ts",
        },
      }),
      "models.ts": [
        "/** @gqlType */",
        "export interface User {",
        "  /** @gqlField */",
        "  nickname?(): string | null;",
        "  /** @gqlField */",
        "  greeting?(args: { name: string }): string | null;",
        "  /** @gqlField */",
        "  id(): string;",
        "}",
        "",
        "/** @gqlQueryField */",
        "export function me(): User {",
        '  return { id: () => "1" };',
        "}",
        "",
      ].join("\n"),
    });
    return Effect.gen(function* () {
      yield* Effect.scoped(generate(project.path("tsconfig.json")));
      const schemaModule: unknown = yield* Effect.promise(() => import(project.path("schema.ts")));
      const schema = schemaOf(schemaModule);
      const result = yield* Effect.promise(() =>
        graphql({ schema, source: '{ me { id nickname greeting(name: "Ada") } }' }),
      );
      expect(result).toEqual({ data: { me: { id: "1", nickname: null, greeting: null } } });
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.ensuring(Effect.sync(project.remove)));
  });
});
