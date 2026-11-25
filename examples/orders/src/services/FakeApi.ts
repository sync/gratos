// An in-memory backend, for development and tests: the Api, and the Bus it publishes changes on.
// `FakeApi.layer` starts from the seed rows below; `FakeApi.withOrders(rows)` from your own.
import { Effect, Layer } from "effect";

import { Api } from "./Api.ts";
import type { OrderRow, UserRow } from "./Api.ts";
import { Bus } from "./Bus.ts";
import { Forbidden, NotFound } from "./errors.ts";

const SEED_ORDERS: ReadonlyArray<OrderRow> = [
  { id: "o-1", total: 42.5, status: "open", customer_id: "u-1", revision: 1 },
  { id: "o-2", total: 18, status: "shipped", customer_id: "u-1", revision: 1 },
  { id: "o-3", total: 7.25, status: "open", customer_id: "u-1", revision: 1 },
  { id: "o-4", total: 99, status: "open", customer_id: "u-2", revision: 1 },
];

const SEED_USERS: ReadonlyArray<UserRow> = [
  { id: "u-1", name: "Ada" },
  { id: "u-2", name: "Grace" },
];

/** The row `id` of `rows`, or NotFound for `what`. */
const find = <A>(rows: ReadonlyMap<string, A>, what: string, id: string) => {
  const row = rows.get(id);
  return row === undefined ? Effect.fail(new NotFound({ what })) : Effect.succeed(row);
};

/** The Api over in-memory rows; a cancel that changes an order publishes it on `orders.<id>`. */
const apiLayer = (seed: ReadonlyArray<OrderRow>) =>
  Layer.effect(
    Api,
    Effect.gen(function* () {
      const bus = yield* Bus;
      const orders = new Map(seed.map((row) => [row.id, row]));
      const users = new Map(SEED_USERS.map((row) => [row.id, row]));
      return Api.of({
        order_get: ({ id }) => find(orders, "order", id).pipe(Effect.withSpan("rpc order_get")),
        order_list: ({ userId, limit }) =>
          Effect.sync(() =>
            [...orders.values()]
              .filter((row) => row.customer_id === userId)
              .toReversed()
              .slice(0, limit),
          ).pipe(Effect.withSpan("rpc order_list")),
        order_cancel: ({ id }) =>
          Effect.gen(function* () {
            const current = yield* find(orders, "order", id);
            if (current.status === "cancelled") {
              // A retry: nothing changes, so nothing is published.
              return current;
            }
            if (current.status !== "open") {
              return yield* new Forbidden();
            }
            const row: OrderRow = {
              ...current,
              status: "cancelled",
              revision: current.revision + 1,
            };
            orders.set(id, row);
            yield* bus.publish(`orders.${id}`, row);
            return row;
          }).pipe(Effect.withSpan("rpc order_cancel")),
        user_get: ({ id }) => find(users, "user", id).pipe(Effect.withSpan("rpc user_get")),
      });
    }),
  );

/** The backend (Api and Bus) seeded with `orders`. */
const withOrders = (orders: ReadonlyArray<OrderRow>) =>
  Layer.provideMerge(apiLayer(orders), Bus.layer);

export const FakeApi = {
  layer: withOrders(SEED_ORDERS),
  withOrders,
};
