# field_values/OptionalFields.ts

## Input

```ts title="field_values/OptionalFields.ts"
/** @gqlType */
export default class SomeType {
  /** @gqlField */
  hello(): string | void {
    return "Hello world!";
  }
  /** @gqlField */
  goodbye(): string | null {
    return "Hello world!";
  }
  /** @gqlField */
  farewell(): string | null | void | undefined {
    return "Hello world!";
  }
  /** @gqlField */
  async adieu(): Promise<string | null | void> {
    return "Hello world!";
  }
}
```

## Output

### SDL

```graphql
type SomeType {
  adieu: String
  farewell: String
  goodbye: String
  hello: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from "graphql";
export function getSchema(): GraphQLSchema {
    const SomeTypeType: GraphQLObjectType = new GraphQLObjectType({
        name: "SomeType",
        fields() {
            return {
                adieu: {
                    name: "adieu",
                    type: GraphQLString,
                    resolve(source) {
                        return source.adieu();
                    }
                },
                farewell: {
                    name: "farewell",
                    type: GraphQLString,
                    resolve(source) {
                        return source.farewell();
                    }
                },
                goodbye: {
                    name: "goodbye",
                    type: GraphQLString,
                    resolve(source) {
                        return source.goodbye();
                    }
                },
                hello: {
                    name: "hello",
                    type: GraphQLString,
                    resolve(source) {
                        return source.hello();
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        types: [SomeTypeType]
    });
}
```