// Test schemas: SDL plus resolvers and field extensions attached to the built schema, the shape
// Grats generates (one explicit resolve per method field, `extensions.gratos` markers).
import { buildSchema, isInterfaceType, isObjectType } from "graphql";
import type {
  GraphQLField,
  GraphQLFieldExtensions,
  GraphQLFieldResolver,
  GraphQLSchema,
} from "graphql";

export type Resolvers = Readonly<
  Record<string, Readonly<Record<string, GraphQLFieldResolver<never, unknown>>>>
>;
export type Extensions = Readonly<
  Record<string, Readonly<Record<string, GraphQLFieldExtensions<unknown, unknown>>>>
>;

/** Builds `sdl` and attaches `resolvers[Type][field]` and `extensions[Type][field]`. */
export const makeSchema = (
  sdl: string,
  resolvers: Resolvers = {},
  extensions: Extensions = {},
): GraphQLSchema => {
  const schema = buildSchema(sdl);
  const fieldOf = (typeName: string, fieldName: string): GraphQLField<unknown, unknown> => {
    const type = schema.getType(typeName);
    if (!isObjectType(type) && !isInterfaceType(type)) {
      throw new Error(`${typeName} has no fields`);
    }
    const field = type.getFields()[fieldName];
    if (field === undefined) {
      throw new Error(`${typeName}.${fieldName} does not exist`);
    }
    return field;
  };
  for (const [typeName, fields] of Object.entries(resolvers)) {
    for (const [fieldName, resolve] of Object.entries(fields)) {
      Object.assign(fieldOf(typeName, fieldName), { resolve });
    }
  }
  for (const [typeName, fields] of Object.entries(extensions)) {
    for (const [fieldName, value] of Object.entries(fields)) {
      Object.assign(fieldOf(typeName, fieldName), { extensions: value });
    }
  }
  return schema;
};

/** A small schema for HTTP and hook tests. */
export const basicSchema = (resolvers: Resolvers = {}, sdlExtra = ""): GraphQLSchema =>
  makeSchema(
    `
      type Query {
        hello(name: String): String
        count: Int!
        fails: String
        failsNonNull: String!
        n(value: Int!): Int
      }
      type Mutation {
        bump: Int!
      }
      ${sdlExtra}
    `,
    {
      Query: {
        hello: (_source, args: { name?: string }) => `hello ${args.name ?? "world"}`,
        count: () => 1,
        fails: () => {
          throw new Error("boom");
        },
        failsNonNull: () => {
          throw new Error("boom");
        },
        n: (_source, args: { value: number }) => args.value,
        ...resolvers["Query"],
      },
      Mutation: { bump: () => 1, ...resolvers["Mutation"] },
      ...Object.fromEntries(
        Object.entries(resolvers).filter(([name]) => name !== "Query" && name !== "Mutation"),
      ),
    },
  );
