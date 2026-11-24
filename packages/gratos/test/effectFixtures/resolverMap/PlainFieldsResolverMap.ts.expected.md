# resolverMap/PlainFieldsResolverMap.ts

## Input

```ts title="resolverMap/PlainFieldsResolverMap.ts"
// { "EXPERIMENTAL__emitResolverMap": true }

/** Without Effect or Stream, the resolver map compiles as upstream's does. */
/** @gqlQueryField */
export async function greeting(): Promise<string> {
  return "hello";
}

/** @gqlSubscriptionField */
export async function* ticks(): AsyncIterable<string> {
  yield "tick";
}
```

## Output

### SDL

```graphql
type Query {
  greeting: String
}

type Subscription {
  ticks: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from "graphql";
import { greeting as queryGreetingResolver, ticks as subscriptionTicksResolver } from "./PlainFieldsResolverMap";
export function getSchema(): GraphQLSchema {
    const QueryType: GraphQLObjectType = new GraphQLObjectType({
        name: "Query",
        fields() {
            return {
                greeting: {
                    name: "greeting",
                    type: GraphQLString,
                    resolve() {
                        return queryGreetingResolver();
                    }
                }
            };
        }
    });
    const SubscriptionType: GraphQLObjectType = new GraphQLObjectType({
        name: "Subscription",
        fields() {
            return {
                ticks: {
                    name: "ticks",
                    type: GraphQLString,
                    subscribe() {
                        return subscriptionTicksResolver();
                    },
                    resolve(payload) {
                        return payload;
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        query: QueryType,
        subscription: SubscriptionType,
        types: [QueryType, SubscriptionType]
    });
}
```