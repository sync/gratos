# comments/jsDocAfterJSDocOnSameLine.ts

## Input

```ts title="comments/jsDocAfterJSDocOnSameLine.ts"
/** Prefix. */ /** @gqlQueryField */
export function hello(): string {
  return "Hello";
}
```

## Output

### SDL

```graphql
type Query {
  hello: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from "graphql";
import { hello as queryHelloResolver } from "./jsDocAfterJSDocOnSameLine";
export function getSchema(): GraphQLSchema {
    const QueryType: GraphQLObjectType = new GraphQLObjectType({
        name: "Query",
        fields() {
            return {
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