// Serves the orders app in this process, on NodeHttpServer with a port the OS picks: the app's own
// wiring (graphql.ts's appLayer: effectRouteLayer, effect(), runInRequest, makeGuard), built in a
// Scope the caller closes, over a FakeApi backend the test can publish events on. A test's tracer
// goes where src/server.ts puts the OTLP one: appLayer's `tracing`.
import { createServer as createHttpServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import type { GraphQLError } from "graphql";

import { getSchema } from "../../src/generated/schema.ts";
import { appLayer } from "../../src/graphql.ts";
import type { OrderRow } from "../../src/services/Api.ts";
import { Bus } from "../../src/services/Bus.ts";
import { FakeApi } from "../../src/services/FakeApi.ts";

export interface Served {
  readonly url: string;
  /** Every error reportErrors() saw, unmasked. */
  readonly reported: Array<GraphQLError>;
  /** Publishes `row` on the app's own Bus, as a backend change no mutation makes. */
  readonly publish: (topic: string, row: OrderRow) => void;
  readonly close: () => Promise<void>;
}

export interface ServeOptions {
  /** The app's tracer, as src/server.ts provides tracingLayer (default: none). */
  readonly tracing?: Layer.Layer<never> | undefined;
}

export const serve = async (options: ServeOptions = {}): Promise<Served> => {
  const reported: Array<GraphQLError> = [];
  const scope = Effect.runSync(Scope.make());
  // Built first, in the same scope: released after the app (whose drain runs first).
  const services = await Effect.runPromise(Layer.buildWithScope(FakeApi.layer, scope));
  const bus = Context.get(services, Bus);
  const layer = appLayer(getSchema(), {
    quiet: true,
    report: (error) => {
      reported.push(error);
    },
    backend: Layer.succeedContext(services),
    tracing: options.tracing,
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
    publish: (topic, row) => {
      Effect.runSync(bus.publish(topic, row));
    },
    close: () => (closed ??= Effect.runPromise(Scope.close(scope, Exit.void))),
  };
};
