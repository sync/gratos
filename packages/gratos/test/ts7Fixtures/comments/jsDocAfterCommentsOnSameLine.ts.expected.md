# comments/jsDocAfterCommentsOnSameLine.ts

## Input

```ts title="comments/jsDocAfterCommentsOnSameLine.ts"
// A line comment.
/* A block comment. */ /** @gqlQueryField */
export function hello(): string {
  return "Hello";
}

/** Prefix. */ /* A block comment. */ /** @gqlQueryField */
export function goodbye(): string {
  return "Goodbye";
}
```

## Output

### SDL

```graphql
type Query {
  goodbye: String
  hello: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from "graphql";
import { goodbye as queryGoodbyeResolver, hello as queryHelloResolver } from "./jsDocAfterCommentsOnSameLine";
export function getSchema(): GraphQLSchema {
    const QueryType: GraphQLObjectType = new GraphQLObjectType({
        name: "Query",
        fields() {
            return {
                goodbye: {
                    name: "goodbye",
                    type: GraphQLString,
                    resolve() {
                        return queryGoodbyeResolver();
                    }
                },
                hello: {
                    name: "hello",
                    type: GraphQLString,
                    resolve() {
                        return queryHelloResolver();
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        query: QueryType,
        types: [QueryType]
    });
}
```