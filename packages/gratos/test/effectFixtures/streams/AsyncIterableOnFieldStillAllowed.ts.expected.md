# streams/AsyncIterableOnFieldStillAllowed.ts

## Input

```ts title="streams/AsyncIterableOnFieldStillAllowed.ts"
// Plain AsyncIterable keeps upstream's behaviour outside Subscription: it is a list.

/** @gqlType */
export class User {
  /** @gqlField */
  async *greetings(): AsyncIterable<string> {
    yield "hi";
  }
}
```

## Output

### SDL

```graphql
type User {
  greetings: [String!]
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from "graphql";
export function getSchema(): GraphQLSchema {
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        fields() {
            return {
                greetings: {
                    name: "greetings",
                    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
                    resolve(source) {
                        return source.greetings();
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