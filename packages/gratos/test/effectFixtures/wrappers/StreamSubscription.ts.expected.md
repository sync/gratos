# wrappers/StreamSubscription.ts

## Input

```ts title="wrappers/StreamSubscription.ts"
import { Stream } from "effect";
import type { Int } from "../../../Types";

/** @gqlSubscriptionField */
export function countdown(from: Int): Stream.Stream<Int> {
  return Stream.make(from, from - 1, 0);
}

/** @gqlSubscriptionField */
export function maybeTicks(): Stream.Stream<string | null, Error> {
  return Stream.make("tick", null);
}
```

## Output

### SDL

```graphql
type Subscription {
  countdown(from: Int!): Int
  maybeTicks: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from "graphql";
import { countdown as subscriptionCountdownResolver, maybeTicks as subscriptionMaybeTicksResolver } from "./StreamSubscription";
export function getSchema(): GraphQLSchema {
    const SubscriptionType: GraphQLObjectType = new GraphQLObjectType({
        name: "Subscription",
        fields() {
            return {
                countdown: {
                    name: "countdown",
                    type: GraphQLInt,
                    args: {
                        from: {
                            type: new GraphQLNonNull(GraphQLInt)
                        }
                    },
                    subscribe(_source, args) {
                        return subscriptionCountdownResolver(args.from);
                    },
                    resolve(payload) {
                        return payload;
                    }
                },
                maybeTicks: {
                    name: "maybeTicks",
                    type: GraphQLString,
                    subscribe() {
                        return subscriptionMaybeTicksResolver();
                    },
                    resolve(payload) {
                        return payload;
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        subscription: SubscriptionType,
        types: [SubscriptionType]
    });
}
```