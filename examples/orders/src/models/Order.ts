import type { Float, ID, Int } from "@dblechoc/gratos";
import { Effect, Stream } from "effect";

import { Api } from "../services/Api.ts";
import type { OrderRow } from "../services/Api.ts";
import { Bus } from "../services/Bus.ts";
import type { AppError } from "../services/errors.ts";
import type { Ctx, Services } from "./context.ts";
import { User } from "./User.ts";

/** An order a user placed. @gqlType */
export class Order {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  total: Float;
  /** @gqlField */
  status: string;
  private readonly customerId: string;

  constructor(row: OrderRow) {
    this.id = row.id;
    this.total = row.total;
    this.status = row.status;
    this.customerId = row.customer_id;
  }

  /** Who placed it. @gqlField */
  customer(ctx: Ctx): Effect.Effect<User, AppError, Services> {
    const id = this.customerId;
    return ctx.guard({
      scopes: ["USER"],
      effect: Effect.gen(function* () {
        const api = yield* Api;
        return new User(yield* api.user_get({ id }));
      }),
    });
  }
}

/** One order, by id. @gqlQueryField */
export function order(ctx: Ctx, id: ID): Effect.Effect<Order, AppError, Services> {
  return ctx.guard({
    scopes: ["USER"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      return new Order(yield* api.order_get({ id }));
    }),
  });
}

/** A user's orders, newest first. @gqlQueryField */
export function orders(
  ctx: Ctx,
  userId: ID,
  first?: Int | null,
): Effect.Effect<Array<Order>, AppError, Services> {
  return ctx.guard({
    scopes: ["USER"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      const rows = yield* api.order_list({ userId, limit: first ?? 20 });
      return rows.map((row) => new Order(row));
    }),
  });
}

/** Cancels an open order. @gqlMutationField */
export function cancelOrder(ctx: Ctx, id: ID): Effect.Effect<Order, AppError, Services> {
  return ctx.guard({
    scopes: ["USER"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      // Runs to its end, even if the client leaves: a mutation is never interrupted.
      return new Order(yield* api.order_cancel({ id }));
    }),
  });
}

/** One order as it is now, then each change to it. @gqlSubscriptionField */
export function orderChanged(ctx: Ctx, id: ID): Stream.Stream<Order, AppError, Services> {
  return ctx.guardStream({
    scopes: ["USER"],
    // The setup Effect itself, not Stream.unwrap of it: the guard bounds only the setup (the
    // order must exist), never the stream's lifetime. When the client leaves, the encoder calls
    // return(), and the Stream's scope closes its bus subscription.
    stream: Effect.gen(function* () {
      const bus = yield* Bus;
      // Subscribed before the read, so no change made in between is lost.
      const changes = yield* bus.subscribe(`orders.${id}`);
      const api = yield* Api;
      const now = yield* api.order_get({ id });
      return Stream.concat(Stream.succeed(now), changes).pipe(Stream.map((row) => new Order(row)));
    }),
  });
}
