import { Effect, Stream } from "effect";

import { Api } from "../services/Api.ts";
import type { OrderRow } from "../services/Api.ts";
import { Bus } from "../services/Bus.ts";
import type { AppError } from "../services/errors.ts";
import type { Ctx } from "./context.ts";

/** @gqlType */
export class Order {
  /** @gqlField */
  id: string;
  /** @gqlField */
  status: string;

  constructor(row: OrderRow) {
    this.id = row.id;
    this.status = row.status;
  }
}

/** @gqlQueryField */
export function order(id: string, ctx: Ctx): Effect.Effect<Order, AppError, Api> {
  return ctx.guard({
    scopes: ["orders:read"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      return new Order(yield* api.order(id));
    }),
  });
}

/** @gqlMutationField */
export function cancelOrder(id: string, ctx: Ctx): Effect.Effect<Order, AppError, Api | Bus> {
  return ctx.guard({
    scopes: ["orders:write"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      const row = yield* api.cancel(id);
      const bus = yield* Bus;
      yield* bus.publish(row);
      return new Order(row);
    }),
  });
}

/** Every change to the order, from the moment the subscription starts. */
/** @gqlSubscriptionField */
export function orderChanged(id: string, ctx: Ctx): Stream.Stream<Order, AppError, Api | Bus> {
  return ctx.guardStream({
    scopes: ["orders:read"],
    stream: Effect.gen(function* () {
      const api = yield* Api;
      yield* api.order(id);
      const bus = yield* Bus;
      const changes = yield* bus.subscribe;
      return changes.pipe(
        Stream.filter((row) => row.id === id),
        Stream.map((row) => new Order(row)),
      );
    }),
  });
}
