import { GraphQLSchema, GraphQLDirective, DirectiveLocation, GraphQLList, GraphQLInt, specifiedDirectives, GraphQLObjectType, GraphQLID, defaultFieldResolver, GraphQLString, GraphQLFloat, GraphQLNonNull } from "graphql";
import { order as queryOrderResolver, orders as queryOrdersResolver, cancelOrder as mutationCancelOrderResolver, orderChanged as subscriptionOrderChangedResolver } from "./../models/Order.ts";
import { user as queryUserResolver } from "./../models/User.ts";
async function assertNonNull<T>(value: T | Promise<T>): Promise<T> {
    const awaited = await value;
    if (awaited == null)
        throw new Error("Cannot return null for semantically non-nullable field.");
    return awaited;
}
export function getSchema(): GraphQLSchema {
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        description: "A user who places orders.",
        fields() {
            return {
                id: {
                    name: "id",
                    type: GraphQLID,
                    resolve(source, args, context, info) {
                        return assertNonNull(defaultFieldResolver(source, args, context, info));
                    }
                },
                name: {
                    name: "name",
                    type: GraphQLString,
                    resolve(source, args, context, info) {
                        return assertNonNull(defaultFieldResolver(source, args, context, info));
                    }
                }
            };
        }
    });
    const OrderType: GraphQLObjectType = new GraphQLObjectType({
        name: "Order",
        description: "An order a user placed.",
        fields() {
            return {
                customer: {
                    description: "Who placed it.",
                    name: "customer",
                    type: UserType,
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(source, _args, context) {
                        return source.customer(context);
                    }
                },
                id: {
                    name: "id",
                    type: GraphQLID,
                    resolve(source, args, context, info) {
                        return assertNonNull(defaultFieldResolver(source, args, context, info));
                    }
                },
                status: {
                    name: "status",
                    type: GraphQLString,
                    resolve(source, args, context, info) {
                        return assertNonNull(defaultFieldResolver(source, args, context, info));
                    }
                },
                total: {
                    name: "total",
                    type: GraphQLFloat,
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
                order: {
                    description: "One order, by id.",
                    name: "order",
                    type: OrderType,
                    args: {
                        id: {
                            type: new GraphQLNonNull(GraphQLID)
                        }
                    },
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(_source, args, context) {
                        return queryOrderResolver(context, args.id);
                    }
                },
                orders: {
                    description: "A user's orders, newest first.",
                    name: "orders",
                    type: new GraphQLList(new GraphQLNonNull(OrderType)),
                    args: {
                        first: {
                            type: GraphQLInt
                        },
                        userId: {
                            type: new GraphQLNonNull(GraphQLID)
                        }
                    },
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(_source, args, context) {
                        return queryOrdersResolver(context, args.userId, args.first);
                    }
                },
                user: {
                    description: "A user, by id.",
                    name: "user",
                    type: UserType,
                    args: {
                        id: {
                            type: new GraphQLNonNull(GraphQLID)
                        }
                    },
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(_source, args, context) {
                        return queryUserResolver(context, args.id);
                    }
                }
            };
        }
    });
    const MutationType: GraphQLObjectType = new GraphQLObjectType({
        name: "Mutation",
        fields() {
            return {
                cancelOrder: {
                    description: "Cancels an open order.",
                    name: "cancelOrder",
                    type: OrderType,
                    args: {
                        id: {
                            type: new GraphQLNonNull(GraphQLID)
                        }
                    },
                    extensions: {
                        gratos: {
                            semanticNonNull: true
                        }
                    },
                    resolve(_source, args, context) {
                        return mutationCancelOrderResolver(context, args.id);
                    }
                }
            };
        }
    });
    const SubscriptionType: GraphQLObjectType = new GraphQLObjectType({
        name: "Subscription",
        fields() {
            return {
                orderChanged: {
                    description: "Each change to one order, from the moment the subscription starts.",
                    name: "orderChanged",
                    type: OrderType,
                    args: {
                        id: {
                            type: new GraphQLNonNull(GraphQLID)
                        }
                    },
                    subscribe(_source, args, context) {
                        return subscriptionOrderChangedResolver(context, args.id);
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
        types: [MutationType, OrderType, QueryType, SubscriptionType, UserType]
    });
}
