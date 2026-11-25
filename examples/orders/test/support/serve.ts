// Serves the orders app in this process, on NodeHttpServer with a port the OS picks: the app's own
// wiring (graphql.ts's appLayer: effectRouteLayer, effect(), runInRequest, makeGuard), built in a
// Scope the caller closes.
import { createServer as createHttpServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import type { GraphQLError } from "graphql";

import { getSchema } from "../../src/generated/schema.ts";
import { appLayer } from "../../src/graphql.ts";

export interface Served {
  readonly url: string;
  /** Every error reportErrors() saw, unmasked. */
  readonly reported: Array<GraphQLError>;
  readonly close: () => Promise<void>;
}

export const serve = async (): Promise<Served> => {
  const reported: Array<GraphQLError> = [];
  const layer = appLayer(getSchema(), {
    quiet: true,
    report: (error) => {
      reported.push(error);
    },
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => createHttpServer(), {
        port: 0,
        host: "127.0.0.1",
        // Open subscriptions end at once on close, instead of after the 20 s default.
        gracefulShutdownTimeout: "50 millis",
      }),
    ),
  );
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const { address } = Context.get(context, HttpServer.HttpServer);
  if (address._tag === "UnixPathAddress") {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error("expected a TCP address");
  }
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    reported,
    close: () => (closed ??= Effect.runPromise(Scope.close(scope, Exit.void))),
  };
};
