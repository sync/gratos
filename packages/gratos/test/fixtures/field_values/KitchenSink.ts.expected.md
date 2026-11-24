# field_values/KitchenSink.ts

## Input

```ts title="field_values/KitchenSink.ts"
/** @gqlType */
export default class SomeType {
  /** @gqlField */
  hello(args: { greeting: string }): string {
    return `${args.greeting ?? "Hello"} world!`;
  }

  /** @gqlField */
  greetings(args: { greeting: string }): string[] {
    return [`${args.greeting ?? "Hello"} world!`];
  }
  /** @gqlField */
  greetings1(args: { greeting: string }): Array<string> {
    return [`${args.greeting ?? "Hello"} world!`];
  }
  /** @gqlField */
  greetings2(args: { greeting: string }): ReadonlyArray<string> {
    return [`${args.greeting ?? "Hello"} world!`];
  }

  /** @gqlField */
  me(): User {
    return new User();
  }
}

/** @gqlType */
class User {
  /** @gqlField */
  name(): string {
    return "Alice";
  }
  /** @gqlField */
  groups(): Group[] {
    return [new Group()];
  }
}

/** @gqlType */
class Group {
  /** @gqlField */
  description: string;

  constructor() {
    this.description = "A group of people";
  }

  /** @gqlField */
  name(): string {
    return "Pal's Club";
  }
  /** @gqlField */
  async members(): Promise<User[]> {
    return [new User()];
  }
}
```

## Output

### SDL

```graphql
type Group {
  description: String
  members: [User!]
  name: String
}

type SomeType {
  greetings(greeting: String!): [String!]
  greetings1(greeting: String!): [String!]
  greetings2(greeting: String!): [String!]
  hello(greeting: String!): String
  me: User
}

type User {
  groups: [Group!]
  name: String
}
```

### TypeScript

```ts
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLList, GraphQLNonNull } from "graphql";
export function getSchema(): GraphQLSchema {
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        fields() {
            return {
                groups: {
                    name: "groups",
                    type: new GraphQLList(new GraphQLNonNull(GroupType)),
                    resolve(source) {
                        return source.groups();
                    }
                },
                name: {
                    name: "name",
                    type: GraphQLString,
                    resolve(source) {
                        return source.name();
                    }
                }
            };
        }
    });
    const GroupType: GraphQLObjectType = new GraphQLObjectType({
        name: "Group",
        fields() {
            return {
                description: {
                    name: "description",
                    type: GraphQLString
                },
                members: {
                    name: "members",
                    type: new GraphQLList(new GraphQLNonNull(UserType)),
                    resolve(source) {
                        return source.members();
                    }
                },
                name: {
                    name: "name",
                    type: GraphQLString,
                    resolve(source) {
                        return source.name();
                    }
                }
            };
        }
    });
    const SomeTypeType: GraphQLObjectType = new GraphQLObjectType({
        name: "SomeType",
        fields() {
            return {
                greetings: {
                    name: "greetings",
                    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
                    args: {
                        greeting: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    resolve(source, args) {
                        return source.greetings(args);
                    }
                },
                greetings1: {
                    name: "greetings1",
                    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
                    args: {
                        greeting: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    resolve(source, args) {
                        return source.greetings1(args);
                    }
                },
                greetings2: {
                    name: "greetings2",
                    type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
                    args: {
                        greeting: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    resolve(source, args) {
                        return source.greetings2(args);
                    }
                },
                hello: {
                    name: "hello",
                    type: GraphQLString,
                    args: {
                        greeting: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    resolve(source, args) {
                        return source.hello(args);
                    }
                },
                me: {
                    name: "me",
                    type: UserType,
                    resolve(source) {
                        return source.me();
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        types: [GroupType, SomeTypeType, UserType]
    });
}
```