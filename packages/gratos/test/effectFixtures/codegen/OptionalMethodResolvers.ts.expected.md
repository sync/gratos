# codegen/OptionalMethodResolvers.ts

## Input

```ts title="codegen/OptionalMethodResolvers.ts"
/** @gqlType */
export interface User {
  /**
   * An optional method: a source may omit it, so its resolve calls it with `?.`. As with
   * graphql-js' default resolver, an omitted method resolves to `null` without an error.
   */
  /** @gqlField */
  nickname?(): string | null;

  /** An optional method with arguments. */
  /** @gqlField */
  greeting?(args: { name: string }): string | null;

  /** A required method keeps a plain call. */
  /** @gqlField */
  id(): string;
}

/** @gqlQueryField */
export function me(): User {
  return { id: () => "1" };
}
```

## Output

### SDL

```graphql
type Query {
  me: User
}

type User {
  greeting(name: String!): String
  id: String
  nickname: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLNonNull } from "graphql";
import { me as queryMeResolver } from "./OptionalMethodResolvers";
export function getSchema(): GraphQLSchema {
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        fields() {
            return {
                greeting: {
                    name: "greeting",
                    type: GraphQLString,
                    args: {
                        name: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    resolve(source, args) {
                        return source.greeting?.(args);
                    }
                },
                id: {
                    name: "id",
                    type: GraphQLString,
                    resolve(source) {
                        return source.id();
                    }
                },
                nickname: {
                    name: "nickname",
                    type: GraphQLString,
                    resolve(source) {
                        return source.nickname?.();
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