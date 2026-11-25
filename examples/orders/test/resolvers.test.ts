// "Test a resolver with no server" (the spec's fifth step): every resolver is a plain Effect (or
// Stream), run with a fake layer. No schema, no server, no HTTP: the guard comes from the same
// contextFor the server's context factory uses.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Stream } from "effect";

import { anonymousContext, contextFor } from "../src/models/context.ts";
import { cancelOrder, order, orderChanged, orders } from "../src/models/Order.ts";
import { user } from "../src/models/User.ts";
import { Api } from "../src/services/Api.ts";
import type { OrderRow } from "../src/services/Api.ts";
import { Bus } from "../src/services/Bus.ts";
import { Forbidden, NotFound } from "../src/services/errors.ts";
import { FakeApi } from "../src/services/FakeApi.ts";

const guestCtx = () => anonymousContext();
const userCtx = () => contextFor({ userId: "u-1", scopes: ["USER"] });

/**
 * An event published straight on the bus (no Api call makes it): a status no cancel produces, at
 * a revision newer than any a test's cancel makes.
 */
const SHIPPED: OrderRow = {
  id: "o-1",
  total: 42.5,
  status: "shipped",
  customer_id: "u-1",
  revision: 3,
};

describe("resolvers, with no server", () => {
  it.effect("a guest cannot cancel an order", () =>
    Effect.gen(function* () {
      // The guard's refusal is an Exit: no fiber, no span, nothing of the Effect runs.
      const exit = yield* cancelOrder(guestCtx(), "o-1").pipe(
        Effect.provide(FakeApi.layer),
        Effect.exit,
      );

      expect(exit).toEqual(Exit.fail(new Forbidden()));
    }),
  );

  it.effect("orders maps each row", () =>
    Effect.gen(function* () {
      const rows = [{ id: "o-1", total: 5, status: "open", customer_id: "u-1", revision: 1 }];
      const result = yield* orders(userCtx(), "u-1").pipe(Effect.provide(FakeApi.withOrders(rows)));

      expect(result.map((o) => o.id)).toEqual(["o-1"]);
    }),
  );

  it.effect("orders returns the newest first, at most `first`", () =>
    Effect.gen(function* () {
      const result = yield* orders(userCtx(), "u-1", 2).pipe(Effect.provide(FakeApi.layer));

      expect(result.map((o) => o.id)).toEqual(["o-3", "o-2"]);
    }),
  );

  it.effect("a missing user is NotFound", () =>
    Effect.gen(function* () {
      // The failure crossed the Api's span, so its Exit carries a stack annotation: compare the
      // typed error itself.
      const error = yield* user(userCtx(), "nope").pipe(Effect.provide(FakeApi.layer), Effect.flip);

      expect(error).toEqual(new NotFound({ what: "user" }));
    }),
  );

  it.effect("an order's customer is its user", () =>
    Effect.gen(function* () {
      const customer = yield* order(userCtx(), "o-4").pipe(
        Effect.flatMap((found) => found.customer(userCtx())),
        Effect.provide(FakeApi.layer),
      );

      expect(customer).toMatchObject({ id: "u-2", name: "Grace" });
    }),
  );

  it.effect("orderChanged streams the order now, then each change to it only", () =>
    Effect.gen(function* () {
      // Started at once: the stream has subscribed to the bus when the fork returns.
      const changes = yield* orderChanged(userCtx(), "o-1").pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      const cancelled = yield* cancelOrder(userCtx(), "o-1");
      // Another order's change is on another topic.
      yield* cancelOrder(userCtx(), "o-3");
      const bus = yield* Bus;
      yield* bus.publish("orders.o-1", { ...SHIPPED, id: "o-1" });

      expect(cancelled).toMatchObject({ id: "o-1", status: "cancelled" });
      const streamed = yield* Fiber.join(changes);
      expect(streamed.map((o) => `${o.id}:${o.status}`)).toEqual([
        "o-1:open",
        "o-1:cancelled",
        "o-1:shipped",
      ]);
    }).pipe(Effect.provide(FakeApi.layer)),
  );

  // The snapshot and the bus subscription share no boundary: a change made while the stream
  // sets up reaches it once, either in the snapshot or as an event, never both and never neither.
  it.effect.each([
    ["after the subscribe, before the read: in the snapshot only", "before", ["cancelled"]],
    ["after the read: as an event", "after", ["open", "cancelled"]],
  ] as const)("a change during orderChanged's setup is streamed once, %s", ([, when, expected]) =>
    Effect.gen(function* () {
      const api = yield* Api;
      let changed = false;
      /** The Api, with o-1 cancelled during the stream's own read of it, `when` that read. */
      const racing = Api.of({
        ...api,
        order_get: (input) => {
          if (changed) {
            return api.order_get(input);
          }
          changed = true;
          const cancel = Effect.orDie(api.order_cancel(input));
          return when === "before"
            ? Effect.andThen(cancel, () => api.order_get(input))
            : Effect.tap(api.order_get(input), () => cancel);
        },
      });
      const changes = yield* orderChanged(userCtx(), "o-1").pipe(
        Stream.take(expected.length + 1),
        Stream.runCollect,
        Effect.provideService(Api, racing),
        Effect.forkChild({ startImmediately: true }),
      );
      // The next change: the stream's last event, so a duplicate or a gap shows before it.
      const bus = yield* Bus;
      yield* bus.publish("orders.o-1", SHIPPED);

      const streamed = yield* Fiber.join(changes);
      expect(changed).toBe(true);
      expect(streamed.map((o) => o.status)).toEqual([...expected, "shipped"]);
    }).pipe(Effect.provide(FakeApi.layer)),
  );

  it.effect("a retried cancel returns the cancelled order and publishes nothing", () =>
    Effect.gen(function* () {
      const changes = yield* orderChanged(userCtx(), "o-1").pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* cancelOrder(userCtx(), "o-1");
      const retried = yield* cancelOrder(userCtx(), "o-1");
      // The next event on the topic: a republished cancel would come before it.
      const bus = yield* Bus;
      yield* bus.publish("orders.o-1", { ...SHIPPED, id: "o-1" });

      expect(retried).toMatchObject({ id: "o-1", status: "cancelled" });
      const streamed = yield* Fiber.join(changes);
      expect(streamed.map((o) => o.status)).toEqual(["open", "cancelled", "shipped"]);
    }).pipe(Effect.provide(FakeApi.layer)),
  );

  it.effect("a shipped order cannot be cancelled: Forbidden, unchanged, nothing published", () =>
    Effect.gen(function* () {
      const changes = yield* orderChanged(userCtx(), "o-2").pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      const refused = yield* cancelOrder(userCtx(), "o-2").pipe(Effect.flip);
      const bus = yield* Bus;
      yield* bus.publish("orders.o-2", { ...SHIPPED, id: "o-2", status: "delivered" });
      const after = yield* order(userCtx(), "o-2");

      expect(refused).toEqual(new Forbidden());
      expect(after.status).toBe("shipped");
      const streamed = yield* Fiber.join(changes);
      expect(streamed.map((o) => o.status)).toEqual(["shipped", "delivered"]);
    }).pipe(Effect.provide(FakeApi.layer)),
  );

  it.effect("a guest cannot watch an order, and an unknown order fails the setup", () =>
    Effect.gen(function* () {
      const guest = yield* orderChanged(guestCtx(), "o-1").pipe(Stream.runCollect, Effect.flip);
      const missing = yield* orderChanged(userCtx(), "nope").pipe(Stream.runCollect, Effect.flip);

      expect(guest).toEqual(new Forbidden());
      expect(missing).toEqual(new NotFound({ what: "order" }));
    }).pipe(Effect.provide(FakeApi.layer)),
  );
});
