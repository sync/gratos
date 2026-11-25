// The app's services: Api (orders, with a write log the tests read) and Bus (order events).
// Their layers record when they are built and released, so the shutdown tests can order the
// drain against the release.
import { Context, Effect, Layer, PubSub, Stream } from "effect";

import { NotFound } from "./errors.ts";

export interface OrderRow {
  readonly id: string;
  readonly status: string;
}

/** What the services saw, in order: writes, releases, events. */
export interface Journal {
  readonly entries: Array<string>;
  /** Holds the write of an order id before it commits (a test opens it). */
  readonly holds: Map<string, Promise<void>>;
}

export const makeJournal = (): Journal => ({ entries: [], holds: new Map() });

export class JournalRef extends Context.Service<JournalRef, Journal>()("test/app/JournalRef") {}

export class Api extends Context.Service<
  Api,
  {
    readonly order: (id: string) => Effect.Effect<OrderRow, NotFound>;
    readonly setStatus: (id: string, status: string) => Effect.Effect<OrderRow, NotFound>;
  }
>()("test/app/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function* () {
      const journal = yield* JournalRef;
      const rows = new Map<string, OrderRow>([
        ["o-1", { id: "o-1", status: "open" }],
        ["o-2", { id: "o-2", status: "open" }],
      ]);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          journal.entries.push("api built");
        }),
        () =>
          Effect.sync(() => {
            journal.entries.push("api released");
          }),
      );
      const find = (id: string) => {
        const row = rows.get(id);
        return row === undefined ? Effect.fail(new NotFound({ id })) : Effect.succeed(row);
      };
      return Api.of({
        order: (id) => find(id).pipe(Effect.withSpan("rpc Api.order")),
        setStatus: (id, status) =>
          Effect.gen(function* () {
            yield* find(id);
            const hold = journal.holds.get(id);
            if (hold !== undefined) {
              journal.entries.push(`held ${id}`);
              yield* Effect.promise(() => hold);
            }
            const row = { id, status };
            rows.set(id, row);
            journal.entries.push(`commit ${id}=${status}`);
            return row;
          }).pipe(Effect.withSpan("rpc Api.setStatus")),
      });
    }),
  );
}

export class Bus extends Context.Service<
  Bus,
  {
    readonly publish: (row: OrderRow) => Effect.Effect<void>;
    readonly changes: Stream.Stream<OrderRow>;
  }
>()("test/app/Bus") {
  static readonly layer = Layer.effect(
    Bus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<OrderRow>();
      return Bus.of({
        publish: (row) => PubSub.publish(pubsub, row).pipe(Effect.asVoid),
        changes: Stream.fromPubSub(pubsub),
      });
    }),
  );
}
