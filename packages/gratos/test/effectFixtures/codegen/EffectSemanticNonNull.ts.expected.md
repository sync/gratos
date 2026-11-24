# codegen/EffectSemanticNonNull.ts

## Input

```ts title="codegen/EffectSemanticNonNull.ts"
// { "strictSemanticNullability": true }
import { Effect, Stream } from "effect";

/** @gqlType */
export class User {
  /** No assertNonNull: the Effect layer checks the unwrapped value (marker). */
  /** @gqlField */
  name(): Effect.Effect<string> {
    return Effect.succeed("Ada");
  }

  /** Still wrapped in assertNonNull. */
  /** @gqlField */
  async email(): Promise<string> {
    return "ada@example.com";
  }
}

/** @gqlQueryField */
export function me(): Effect.Effect<User> {
  return Effect.succeed(new User());
}

/** The per-event resolve keeps assertNonNull. */
/** @gqlSubscriptionField */
export function names(): Stream.Stream<string> {
  return Stream.make("Ada");
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

type Subscription {
  names: String @semanticNonNull
}

type User {
  email: String @semanticNonNull
  name: String @semanticNonNull
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLDirective, DirectiveLocation, GraphQLList, GraphQLInt, specifiedDirectives, GraphQLObjectType, GraphQLString } from "graphql";
import { me as queryMeResolver, names as subscriptionNamesResolver } from "./EffectSemanticNonNull";
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
                    resolve(source) {
                        return assertNonNull(source.email());
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
                        return source.name();
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
                            semanticNonNull: true
                        }
                    },
                    resolve() {
                        return queryMeResolver();
                    }
                }
            };
        }
    });
    const SubscriptionType: GraphQLObjectType = new GraphQLObjectType({
        name: "Subscription",
        fields() {
            return {
                names: {
                    name: "names",
                    type: GraphQLString,
                    subscribe() {
                        return subscriptionNamesResolver();
                    },
                    resolve(payload) {
                        return assertNonNull(payload);
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
        subscription: SubscriptionType,
        types: [QueryType, SubscriptionType, UserType]
    });
}
```