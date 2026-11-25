// Order events, by topic (`orders.<id>`): a publisher, and a subscription to one topic's events.
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { Scope } from "effect";

import type { OrderRow } from "./Api.ts";

interface Event {
  readonly topic: string;
  readonly row: OrderRow;
}

export class Bus extends Context.Service<
  Bus,
  {
    readonly publish: (topic: string, row: OrderRow) => Effect.Effect<void>;
    /**
     * Subscribes to `topic` now, in the caller's scope (it unsubscribes when that scope closes:
     * the client left), and gives the stream of every event published from then on.
     */
    readonly subscribe: (
      topic: string,
    ) => Effect.Effect<Stream.Stream<OrderRow>, never, Scope.Scope>;
  }
>()("orders/services/Bus") {
  static readonly layer = Layer.effect(
    Bus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<Event>();
      return Bus.of({
        publish: (topic, row) => PubSub.publish(pubsub, { topic, row }).pipe(Effect.asVoid),
        subscribe: (topic) =>
          Effect.map(PubSub.subscribe(pubsub), (subscription) =>
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.topic === topic),
              Stream.map((event) => event.row),
            ),
          ),
      });
    }),
  );
}
