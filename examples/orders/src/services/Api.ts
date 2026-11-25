// The orders backend the resolvers call, shaped like its RPC API (snake_case rows and method
// names). FakeApi.layer implements it in memory.
import { Context } from "effect";
import type { Effect } from "effect";

import type { NotFound } from "./errors.ts";

export interface OrderRow {
  readonly id: string;
  readonly total: number;
  readonly status: string;
  readonly customer_id: string;
}

export interface UserRow {
  readonly id: string;
  readonly name: string;
}

export class Api extends Context.Service<
  Api,
  {
    readonly order_get: (input: { readonly id: string }) => Effect.Effect<OrderRow, NotFound>;
    /** A user's orders, newest first, at most `limit`. */
    readonly order_list: (input: {
      readonly userId: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<OrderRow>>;
    /** Cancels the order and publishes the change on the Bus (`orders.<id>`). */
    readonly order_cancel: (input: { readonly id: string }) => Effect.Effect<OrderRow, NotFound>;
    readonly user_get: (input: { readonly id: string }) => Effect.Effect<UserRow, NotFound>;
  }
>()("orders/services/Api") {}
