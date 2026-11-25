// The orders API the resolvers call. FakeApi.layer implements it in memory.
import { Context } from "effect";
import type { Effect } from "effect";

import type { NotFound } from "./errors.ts";

export interface OrderRow {
  readonly id: string;
  readonly status: string;
}

export class Api extends Context.Service<
  Api,
  {
    readonly order: (id: string) => Effect.Effect<OrderRow, NotFound>;
    readonly cancel: (id: string) => Effect.Effect<OrderRow, NotFound>;
  }
>()("orders/services/Api") {}
