# default_values/DefaultArgumentBooleanLiteral.ts

## Input

```ts title="default_values/DefaultArgumentBooleanLiteral.ts"
/** @gqlType */
export default class SomeType {
  /** @gqlField */
  someField1({ greet = false }: { greet?: boolean | null }): string {
    if (!greet) return "";
    return "hello";
  }

  /** @gqlField */
  someField2({ greet = true }: { greet?: boolean | null }): string {
    if (!greet) return "";
    return "hello";
  }
}
```

## Output

### SDL

```graphql
type SomeType {
  someField1(greet: Boolean = false): String
  someField2(greet: Boolean = true): String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLBoolean } from "graphql";
export function getSchema(): GraphQLSchema {
    const SomeTypeType: GraphQLObjectType = new GraphQLObjectType({
        name: "SomeType",
        fields() {
            return {
                someField1: {
                    name: "someField1",
                    type: GraphQLString,
                    args: {
                        greet: {
                            type: GraphQLBoolean,
                            defaultValue: false
                        }
                    },
                    resolve(source, args) {
                        return source.someField1(args);
                    }
                },
                someField2: {
                    name: "someField2",
                    type: GraphQLString,
                    args: {
                        greet: {
                            type: GraphQLBoolean,
                            defaultValue: true
                        }
                    },
                    resolve(source, args) {
                        return source.someField2(args);
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