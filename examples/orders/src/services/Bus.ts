// Order events: a publisher and a per-subscriber stream.
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { Scope } from "effect";

import type { OrderRow } from "./Api.ts";

export class Bus extends Context.Service<
  Bus,
  {
    readonly publish: (row: OrderRow) => Effect.Effect<void>;
    /** Subscribes now (in the caller's scope): the stream gets every event published after. */
    readonly subscribe: Effect.Effect<Stream.Stream<OrderRow>, never, Scope.Scope>;
  }
>()("orders/services/Bus") {
  static readonly layer = Layer.effect(
    Bus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<OrderRow>();
      return Bus.of({
        publish: (row) => PubSub.publish(pubsub, row).pipe(Effect.asVoid),
        subscribe: Effect.map(PubSub.subscribe(pubsub), Stream.fromSubscription),
      });
    }),
  );
}
