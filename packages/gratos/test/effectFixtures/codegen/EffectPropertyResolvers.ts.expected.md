# codegen/EffectPropertyResolvers.ts

## Input

```ts title="codegen/EffectPropertyResolvers.ts"
// { "strictSemanticNullability": true }
import { Effect } from "effect";

/**
 * Same-name Effect-backed properties and getters get an explicit resolve, so the Effect layer
 * can run the Effect (and check its value when the field is semantically non-null).
 */
/** @gqlType */
export class User {
  /** @gqlField */
  name: Effect.Effect<string> = Effect.succeed("Ada");

  /** @gqlField */
  get email(): Effect.Effect<string> {
    return Effect.succeed("ada@example.com");
  }

  /** Nullable: no marker, but still an explicit resolve. */
  /** @gqlField */
  nickname: Effect.Effect<string | null> = Effect.succeed(null);

  /** A plain property keeps graphql-js' default resolver. */
  /** @gqlField */
  id: string = "u-1";
}

/** @gqlType */
export type Post = {
  /** @gqlField */
  title: Effect.Effect<string>;
};

/** @gqlQueryField */
export function me(): User {
  return new User();
}

/** @gqlQueryField */
export function post(): Post {
  return { title: Effect.succeed("Hello") };
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

type Post {
  title: String @semanticNonNull
}

type Query {
  me: User @semanticNonNull
  post: Post @semanticNonNull
}

type User {
  email: String @semanticNonNull
  id: String @semanticNonNull
  name: String @semanticNonNull
  nickname: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLDirective, DirectiveLocation, GraphQLList, GraphQLInt, specifiedDirectives, GraphQLObjectType, GraphQLString, defaultFieldResolver } from "graphql";
import { me as queryMeResolver, post as queryPostResolver } from "./EffectPropertyResolvers";
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
                email: {
                    name: "email",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(source) {
                        return source.email;
                    }
                },
                id: {
                    name: "id",
                    type: GraphQLString,
                    resolve(source, args, context, info) {
                        return assertNonNull(defaultFieldResolver(source, args, context, info));
                    }
                },
                name: {
                    name: "name",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(source) {
                        return source.name;
                    }
                },
                nickname: {
                    name: "nickname",
                    type: GraphQLString,
                    resolve(source) {
                        return source.nickname;
                    }
                }
            };
        }
    });
    const PostType: GraphQLObjectType = new GraphQLObjectType({
        name: "Post",
        fields() {
            return {
                title: {
                    name: "title",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(source) {
                        return source.title;
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
                },
                post: {
                    name: "post",
                    type: PostType,
                    resolve() {
                        return assertNonNull(queryPostResolver());
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
        types: [PostType, QueryType, UserType]
    });
}
```