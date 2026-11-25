// An in-memory Api, for development and tests.
import { Effect, Layer } from "effect";

import { Api } from "./Api.ts";
import type { OrderRow } from "./Api.ts";
import { NotFound } from "./errors.ts";

export const FakeApi = {
  layer: Layer.sync(Api, () => {
    const rows = new Map<string, OrderRow>([
      ["o-1", { id: "o-1", status: "open" }],
      ["o-2", { id: "o-2", status: "shipped" }],
    ]);
    const find = (id: string) => {
      const row = rows.get(id);
      return row === undefined ? Effect.fail(new NotFound({ id })) : Effect.succeed(row);
    };
    return Api.of({
      order: (id) => find(id).pipe(Effect.withSpan("rpc Api.order")),
      cancel: (id) =>
        Effect.gen(function* () {
          const row: OrderRow = { ...(yield* find(id)), status: "cancelled" };
          rows.set(id, row);
          return row;
        }).pipe(Effect.withSpan("rpc Api.cancel")),
    });
  }),
};
