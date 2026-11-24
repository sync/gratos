# subscriptions/NonSubscriptionClassWithAsyncIterable.ts

## Input

```ts title="subscriptions/NonSubscriptionClassWithAsyncIterable.ts"
// { "nullableByDefault": false }
/** @gqlType */
export class User {
  /** @gqlField */
  async *greetings(): AsyncIterable<string> {
    yield "Hello";
    yield "World";
  }

  /** @gqlField */
  async *maybeGreetings(): AsyncIterable<string> | null {
    null;
  }
  /** @gqlField */
  async *greetingsMaybe(): AsyncIterable<string | null> {
    null;
  }

  /** @gqlField */
  async *maybeGreetingsMaybe(): AsyncIterable<string | null> | null {
    null;
  }
}
```

## Output

### SDL

```graphql
type User {
  greetings: [String!]!
  greetingsMaybe: [String]!
  maybeGreetings: [String!]
  maybeGreetingsMaybe: [String]
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLNonNull, GraphQLList, GraphQLString } from "graphql";
export function getSchema(): GraphQLSchema {
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        fields() {
            return {
                greetings: {
                    name: "greetings",
                    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
                    resolve(source) {
                        return source.greetings();
                    }
                },
                greetingsMaybe: {
                    name: "greetingsMaybe",
                    type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
                    resolve(source) {
                        return source.greetingsMaybe();
                    }
                },
                maybeGreetings: {
                    name: "maybeGreetings",
                    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
                    resolve(source) {
                        return source.maybeGreetings();
                    }
                },
                maybeGreetingsMaybe: {
                    name: "maybeGreetingsMaybe",
                    type: new GraphQLList(GraphQLString),
                    resolve(source) {
                        return source.maybeGreetingsMaybe();
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        types: [UserType]
    });
}
```