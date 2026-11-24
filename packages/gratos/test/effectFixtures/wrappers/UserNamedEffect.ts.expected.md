# wrappers/UserNamedEffect.ts

## Input

```ts title="wrappers/UserNamedEffect.ts"
// A user type named `Effect` stays a normal GraphQL type: only `Effect.Effect` is a wrapper.

/** @gqlType */
export class Effect {
  /** @gqlField */
  name: string;
}

/** @gqlQueryField */
export function effect(): Effect {
  return new Effect();
}
```

## Output

### SDL

```graphql
type Effect {
  name: String
}

type Query {
  effect: Effect
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from "graphql";
import { effect as queryEffectResolver } from "./UserNamedEffect";
export function getSchema(): GraphQLSchema {
    const EffectType: GraphQLObjectType = new GraphQLObjectType({
        name: "Effect",
        fields() {
            return {
                name: {
                    name: "name",
                    type: GraphQLString
                }
            };
        }
    });
    const QueryType: GraphQLObjectType = new GraphQLObjectType({
        name: "Query",
        fields() {
            return {
                effect: {
                    name: "effect",
                    type: EffectType,
                    resolve() {
                        return queryEffectResolver();
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        query: QueryType,
        types: [EffectType, QueryType]
    });
}
```