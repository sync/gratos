# wrappers/EffectField.ts

## Input

```ts title="wrappers/EffectField.ts"
import { Effect } from "effect";
import type { Int } from "../../../Types";

class NotFound {
  readonly _tag = "NotFound";
}

/** @gqlType */
export class User {
  /** @gqlField */
  name(): Effect.Effect<string> {
    return Effect.succeed("Ada");
  }

  /** @gqlField */
  age: Effect.Effect<Int, NotFound>;

  /** @gqlField */
  orders(userId: string, first: Int): Effect.Effect<ReadonlyArray<string>, NotFound, never> {
    return Effect.succeed([userId].slice(0, first));
  }

  /** @gqlField */
  nickname(): Effect.Effect<string | null> {
    return Effect.succeed(null);
  }
}

/** @gqlQueryField */
export function me(): Effect.Effect<User> {
  return Effect.succeed(new User());
}
```

## Output

### SDL

```graphql
type Query {
  me: User
}

type User {
  age: Int
  name: String
  nickname: String
  orders(first: Int!, userId: String!): [String!]
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLInt, GraphQLString, GraphQLList, GraphQLNonNull } from "graphql";
import { me as queryMeResolver } from "./EffectField";
export function getSchema(): GraphQLSchema {
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        fields() {
            return {
                age: {
                    name: "age",
                    type: GraphQLInt,
                    resolve(source) {
                        return source.age;
                    }
                },
                name: {
                    name: "name",
                    type: GraphQLString,
                    resolve(source) {
                        return source.name();
                    }
                },
                nickname: {
                    name: "nickname",
                    type: GraphQLString,
                    resolve(source) {
                        return source.nickname();
                    }
                },
                orders: {
                    name: "orders",
                    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
                    args: {
                        first: {
                            type: new GraphQLNonNull(GraphQLInt)
                        },
                        userId: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    resolve(source, args) {
                        return source.orders(args.userId, args.first);
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
                        return queryMeResolver();
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        query: QueryType,
        types: [QueryType, UserType]
    });
}
```