# codegen/JitMarkerAlone.ts

## Input

```ts title="codegen/JitMarkerAlone.ts"
// { "strictSemanticNullability": true }
import { Effect } from "effect";
import type { GqlInfo } from "../../../Types";

/** @gqlType */
export class User {
  /** Both markers, no directive: the merge creates the `extensions` object. */
  /** @gqlField */
  name(info: GqlInfo): Effect.Effect<string> {
    return Effect.succeed(info.fieldName);
  }

  /** The jit marker only. */
  /** @gqlField */
  path(info: GqlInfo): string {
    return info.fieldName;
  }

  /** The semanticNonNull marker only. */
  /** @gqlField */
  greeting(): Effect.Effect<string> {
    return Effect.succeed("hi");
  }
}

/** @gqlQueryField */
export function me(info: GqlInfo): User {
  return new User();
}
```

## Output

### SDL

```graphql
"""
Indicates that a position is semantically non null: it is only null if there is a matching error in the `errors` array.
In all other cases, the position is non-null.

Tools doing code generation may use this information to generate the position as non-null if field errors are handled out of band:

```graphql
type User {
    # email is semantically non-null and can be generated as non-null by error-handling clients.
    email: String @semanticNonNull
}
```

The `levels` argument indicates what levels are semantically non null in case of lists:

```graphql
type User {
    # friends is semantically non null
    friends: [User] @semanticNonNull # same as @semanticNonNull(levels: [0])

    # every friends[k] is semantically non null
    friends: [User] @semanticNonNull(levels: [1])

    # friends as well as every friends[k] is semantically non null
    friends: [User] @semanticNonNull(levels: [0, 1])
}
```

`levels` are zero indexed.
Passing a negative level or a level greater than the list dimension is an error.
"""
directive @semanticNonNull(levels: [Int] = [0]) on FIELD_DEFINITION

type Query {
  me: User @semanticNonNull
}

type User {
  greeting: String @semanticNonNull
  name: String @semanticNonNull
  path: String @semanticNonNull
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLDirective, DirectiveLocation, GraphQLList, GraphQLInt, specifiedDirectives, GraphQLObjectType, GraphQLString } from "graphql";
import { me as queryMeResolver } from "./JitMarkerAlone";
async function assertNonNull<T>(value: T | Promise<T>): Promise<T> {
    const awaited = await value;
    if (awaited == null)
        throw new Error("Cannot return null for semantically non-nullable field.");
    return awaited;
}
export function getSchema(): GraphQLSchema {
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        fields() {
            return {
                greeting: {
                    name: "greeting",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(source) {
                        return source.greeting();
                    }
                },
                name: {
                    name: "name",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            jit: false,
                            semanticNonNull: true
                        }
                    },
                    resolve(source, _args, _context, info) {
                        return source.name(info);
                    }
                },
                path: {
                    name: "path",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            jit: false
                        }
                    },
                    resolve(source, _args, _context, info) {
                        return assertNonNull(source.path(info));
                    }
                }
            };
        }
    });
    const QueryType: GraphQLObjectType = new GraphQLObjectType({
        name: "Query",
        fields() {
            return {
                me: {
                    name: "me",
                    type: UserType,
                    extensions: {
                        gratos: {
                            jit: false
                        }
                    },
                    resolve(_source, _args, _context, info) {
                        return assertNonNull(queryMeResolver(info));
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        directives: [...specifiedDirectives, new GraphQLDirective({
                name: "semanticNonNull",
                locations: [DirectiveLocation.FIELD_DEFINITION],
                description: "Indicates that a position is semantically non null: it is only null if there is a matching error in the `errors` array.\nIn all other cases, the position is non-null.\n\nTools doing code generation may use this information to generate the position as non-null if field errors are handled out of band:\n\n```graphql\ntype User {\n    # email is semantically non-null and can be generated as non-null by error-handling clients.\n    email: String @semanticNonNull\n}\n```\n\nThe `levels` argument indicates what levels are semantically non null in case of lists:\n\n```graphql\ntype User {\n    # friends is semantically non null\n    friends: [User] @semanticNonNull # same as @semanticNonNull(levels: [0])\n\n    # every friends[k] is semantically non null\n    friends: [User] @semanticNonNull(levels: [1])\n\n    # friends as well as every friends[k] is semantically non null\n    friends: [User] @semanticNonNull(levels: [0, 1])\n}\n```\n\n`levels` are zero indexed.\nPassing a negative level or a level greater than the list dimension is an error.",
                args: {
                    levels: {
                        type: new GraphQLList(GraphQLInt),
                        defaultValue: [0]
                    }
                }
            })],
        query: QueryType,
        types: [QueryType, UserType]
    });
}
```