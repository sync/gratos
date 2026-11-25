import { GraphQLSchema, GraphQLDirective, DirectiveLocation, GraphQLList, GraphQLInt, specifiedDirectives, GraphQLObjectType, GraphQLString, defaultFieldResolver, GraphQLNonNull } from "graphql";
import { greeting as queryGreetingResolver, missingLabel as queryMissingLabelResolver, order as queryOrderResolver, setStatus as mutationSetStatusResolver, greetings as subscriptionGreetingsResolver, labels as subscriptionLabelsResolver, orderChanged as subscriptionOrderChangedResolver, watch as subscriptionWatchResolver } from "./../models/Order.ts";
import { viewerOf } from "./../context.ts";
async function assertNonNull<T>(value: T | Promise<T>): Promise<T> {
    const awaited = await value;
    if (awaited == null)
        throw new Error("Cannot return null for semantically non-nullable field.");
    return awaited;
}
export function getSchema(): GraphQLSchema {
    const OrderType: GraphQLObjectType = new GraphQLObjectType({
        name: "Order",
        fields() {
            return {
                id: {
                    name: "id",
                    type: GraphQLString,
                    resolve(source, args, context, info) {
                        return assertNonNull(defaultFieldResolver(source, args, context, info));
                    }
                },
                label: {
                    name: "label",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(source) {
                        return source.label();
                    }
                },
                slowNote: {
                    name: "slowNote",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(source) {
                        return source.slowNote();
                    }
                },
                status: {
                    name: "status",
                    type: GraphQLString,
                    resolve(source, args, context, info) {
                        return assertNonNull(defaultFieldResolver(source, args, context, info));
                    }
                }
            };
        }
    });
    const QueryType: GraphQLObjectType = new GraphQLObjectType({
        name: "Query",
        fields() {
            return {
                greeting: {
                    name: "greeting",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    async resolve(_source, _args, context) {
                        return queryGreetingResolver(await viewerOf(context));
                    }
                },
                missingLabel: {
                    name: "missingLabel",
                    type: GraphQLString,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve() {
                        return queryMissingLabelResolver();
                    }
                },
                order: {
                    name: "order",
                    type: OrderType,
                    args: {
                        id: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(_source, args, context) {
                        return queryOrderResolver(args.id, context);
                    }
                }
            };
        }
    });
    const MutationType: GraphQLObjectType = new GraphQLObjectType({
        name: "Mutation",
        fields() {
            return {
                setStatus: {
                    name: "setStatus",
                    type: OrderType,
                    args: {
                        id: {
                            type: new GraphQLNonNull(GraphQLString)
                        },
                        status: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(_source, args, context) {
                        return mutationSetStatusResolver(args.id, args.status, context);
                    }
                }
            };
        }
    });
    const SubscriptionType: GraphQLObjectType = new GraphQLObjectType({
        name: "Subscription",
        fields() {
            return {
                greetings: {
                    name: "greetings",
                    type: GraphQLString,
                    async subscribe(_source, _args, context) {
                        return subscriptionGreetingsResolver(await viewerOf(context));
                    },
                    resolve(payload) {
                        return assertNonNull(payload);
                    }
                },
                labels: {
                    name: "labels",
                    type: GraphQLString,
                    subscribe() {
                        return subscriptionLabelsResolver();
                    },
                    resolve(payload) {
                        return assertNonNull(payload);
                    }
                },
                orderChanged: {
                    name: "orderChanged",
                    type: OrderType,
                    args: {
                        id: {
                            type: new GraphQLNonNull(GraphQLString)
                        }
                    },
                    subscribe(_source, args, context) {
                        return subscriptionOrderChangedResolver(args.id, context);
                    },
                    resolve(payload) {
                        return assertNonNull(payload);
                    }
                },
                watch: {
                    name: "watch",
                    type: GraphQLString,
                    async subscribe(_source, _args, context) {
                        return subscriptionWatchResolver(await viewerOf(context), context);
                    },
                    resolve(payload) {
                        return assertNonNull(payload);
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        directives: [...specifiedDirectives, new GraphQLDirective({
                name: "semanticNonNull",
                locations: [DirectiveLocation.FIELD_DEFINITION],
                description: "Indicates that a position is semantically non null: it is only null if there is a matching error in the `errors` array.\nIn all other cases, the position is non-null.\n\nTools doing code generation may use this information to generate the position as non-null if field errors are handled out of band:\n\n```graphql\ntype User {\n    # email is semantically non-null and can be generated as non-null by error-handling clients.\n    email: String @semanticNonNull\n}\n```\n\nThe `levels` argument indicates what levels are semantically non null in case of lists:\n\n```graphql\ntype User {\n    # friends is semantically non null\n    friends: [User] @semanticNonNull # same as @semanticNonNull(levels: [0])\n\n    # every friends[k] is semantically non null\n    friends: [User] @semanticNonNull(levels: [1])\n\n    # friends as well as every friends[k] is semantically non null\n    friends: [User] @semanticNonNull(levels: [0, 1])\n}\n```\n\n`levels` are zero indexed.\nPassing a negative level or a level greater than the list dimension is an error.",
                args: {
                    levels: {
                        type: new GraphQLList(GraphQLInt),
                        defaultValue: [0]
                    }
                }
            })],
        query: QueryType,
        mutation: MutationType,
        subscription: SubscriptionType,
        types: [MutationType, OrderType, QueryType, SubscriptionType]
    });
}
