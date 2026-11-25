// Order events, by topic (`orders.<id>`): a publisher, and a stream of one topic's events.
import { Context, Effect, Layer, PubSub, Stream } from "effect";

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
     * Every event published on `topic` once the stream runs: it subscribes when it starts, in
     * the stream's scope, and unsubscribes when that scope closes (the client left).
     */
    readonly watch: (topic: string) => Stream.Stream<OrderRow>;
  }
>()("orders/services/Bus") {
  static readonly layer = Layer.effect(
    Bus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<Event>();
      return Bus.of({
        publish: (topic, row) => PubSub.publish(pubsub, { topic, row }).pipe(Effect.asVoid),
        watch: (topic) =>
          Stream.fromPubSub(pubsub).pipe(
            Stream.filter((event) => event.topic === topic),
            Stream.map((event) => event.row),
          ),
      });
    }),
  );
}
