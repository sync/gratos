import type { GqlScalar } from "@dblechoc/gratos";
import type { DateTime as DateTimeInternal } from "./models/DateTime.ts";
import { GraphQLSchema, GraphQLObjectType, GraphQLList, GraphQLNonNull, GraphQLID, GraphQLScalarType, GraphQLString, GraphQLInt } from "graphql";
import { orders as queryOrdersResolver } from "./models/Order.ts";
export type SchemaConfig = {
    scalars: {
        DateTime: GqlScalar<DateTimeInternal>;
    };
};
export function getSchema(config: SchemaConfig): GraphQLSchema {
    const DateTimeType: GraphQLScalarType = new GraphQLScalarType({
        description: "An instant, serialized as an ISO 8601 string.",
        name: "DateTime",
        ...config.scalars.DateTime
    });
    const UserType: GraphQLObjectType = new GraphQLObjectType({
        name: "User",
        fields() {
            return {
                id: {
                    name: "id",
                    type: GraphQLID
                },
                joinedAt: {
                    name: "joinedAt",
                    type: DateTimeType
                },
                name: {
                    name: "name",
                    type: GraphQLString
                }
            };
        }
    });
    const OrderType: GraphQLObjectType = new GraphQLObjectType({
        name: "Order",
        fields() {
            return {
                customer: {
                    name: "customer",
                    type: UserType
                },
                id: {
                    name: "id",
                    type: GraphQLString
                },
                quantity: {
                    name: "quantity",
                    type: GraphQLInt
                }
            };
        }
    });
    const QueryType: GraphQLObjectType = new GraphQLObjectType({
        name: "Query",
        fields() {
            return {
                orders: {
                    name: "orders",
                    type: new GraphQLList(new GraphQLNonNull(OrderType)),
                    resolve() {
                        return queryOrdersResolver();
                    }
                }
            };
        }
    });
    return new GraphQLSchema({
        query: QueryType,
        types: [DateTimeType, OrderType, QueryType, UserType]
    });
}
