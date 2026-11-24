# codegen/JitMarkerWithDirective.ts

## Input

```ts title="codegen/JitMarkerWithDirective.ts"
// { "strictSemanticNullability": true }
import { Effect } from "effect";
import type { GqlInfo, Int } from "../../../Types";

/**
 * @gqlDirective on FIELD_DEFINITION
 */
export function cost(args: { weight: Int }) {}

/** @gqlType */
export class User {
  /**
   * Markers merge with the user directive into one `extensions` object.
   * @gqlField
   * @gqlAnnotate cost(weight: 2)
   */
  name(info: GqlInfo): Effect.Effect<string> {
    return Effect.succeed(info.fieldName);
  }

  /**
   * The directive alone, unchanged.
   * @gqlField
   * @gqlAnnotate cost(weight: 1)
   */
  plain(): string {
    return "plain";
  }
}

/** @gqlQueryField */
export function me(): User {
  return new User();
}
```

## Output

### SDL

```graphql
directive @cost(weight: Int!) on FIELD_DEFINITION

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
  """Markers merge with the user directive into one `extensions` object."""
  name: String @cost(weight: 2) @semanticNonNull
  """The directive alone, unchanged."""
  plain: String @cost(weight: 1) @semanticNonNull
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLDirective, DirectiveLocation, GraphQLNonNull, GraphQLInt, GraphQLList, specifiedDirectives, GraphQLObjectType, GraphQLString } from "graphql";
import { me as queryMeResolver } from "./JitMarkerWithDirective";
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
                name: {
                    description: "Markers merge with the user directive into one `extensions` object.",
                    name: "name",
                    type: GraphQLString,
                    extensions: {
                        grats: {
                            directives: [{
                                    name: "cost",
                                    args: {
                                        weight: 2
                                    }
                                }]
                        },
                        gratos: {
                            jit: false,
                            semanticNonNull: true
                        }
                    },
                    resolve(source, _args, _context, info) {
                        return source.name(info);
                    }
                },
                plain: {
                    description: "The directive alone, unchanged.",
                    name: "plain",
                    type: GraphQLString,
                    extensions: {
                        grats: {
                            directives: [{
                                    name: "cost",
                                    args: {
                                        weight: 1
                                    }
                                }]
                        }
                    },
                    resolve(source) {
                        return assertNonNull(source.plain());
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
                    resolve() {
                        return assertNonNull(queryMeResolver());
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        directives: [...specifiedDirectives, new GraphQLDirective({
                name: "cost",
                locations: [DirectiveLocation.FIELD_DEFINITION],
                args: {
                    weight: {
                        type: new GraphQLNonNull(GraphQLInt)
                    }
                }
            }), new GraphQLDirective({
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