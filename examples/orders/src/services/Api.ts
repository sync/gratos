// The orders backend the resolvers call, shaped like its RPC API (snake_case rows and method
// names). FakeApi.layer implements it in memory.
import { Context } from "effect";
import type { Effect } from "effect";

import type { Forbidden, NotFound } from "./errors.ts";

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
    /**
     * Cancels an open order and publishes the change on the Bus (`orders.<id>`). An order that is
     * cancelled already is returned as it is, with nothing published (a retried cancel); any
     * other status (`shipped`) cannot be cancelled: Forbidden.
     */
    readonly order_cancel: (input: {
      readonly id: string;
    }) => Effect.Effect<OrderRow, NotFound | Forbidden>;
    readonly user_get: (input: { readonly id: string }) => Effect.Effect<UserRow, NotFound>;
  }
>()("orders/services/Api") {}
