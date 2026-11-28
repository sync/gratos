// The app's wiring (the spec's "wire it up" and "Effect in the context factory"): the generated
// schema wrapped once by effectSchema, a context factory that reads the session with
// runInRequest (its span joins the request's trace) and builds the guard, and the plugins, served
// by the Effect HTTP router (effectRouteLayer) with the app's services.
//
// Plugin order: apq() first (it must see the query before any executor); incremental() before
// jit() (graphql-jit would inline @defer); reportErrors() before maskErrors() (the report sees the
// unmasked errors). effect() and serverTiming() only observe, so their place is free. APQ and JIT
// keep their caches in this process's memory only, so each dev restart starts them over.
//
// The server imports this module dynamically, with the generated schema: in dev, inside the boot
// step's error boundary, so a service that does not load answers GRATS_ERROR like a broken model.
import {
  apq,
  createServer,
  gqlError,
  incremental,
  maskErrors,
  reportErrors,
  serverTiming,
} from "gratos-server";
import type { Server } from "gratos-server";
import { effect, effectRouteLayer, effectSchema, runInRequest } from "gratos-server/effect";
import { jit } from "gratos-server/jit";
import { Effect, Layer, Match } from "effect";
import type { Context } from "effect";
import { HttpRouter } from "effect/http";
import type { GraphQLError, GraphQLSchema } from "graphql";

import { contextFor } from "./models/context.ts";
import type { Ctx, Services } from "./models/context.ts";
import { isAppError } from "./services/errors.ts";
import type { AppError } from "./services/errors.ts";
import { FakeApi } from "./services/FakeApi.ts";
import { Session } from "./services/Session.ts";

/** One error union, mapped with Match: a new tag fails this type check until it is mapped. */
export const failure = Match.type<AppError>().pipe(
  Match.tagsExhaustive({
    NotFound: (error) => gqlError(`${error.what} not found`, 404, { code: "NOT_FOUND" }),
    Forbidden: () => gqlError("Forbidden", 403, { code: "FORBIDDEN" }),
  }),
);

export interface AppOptions {
  /** Receives every error of every result, unmasked. Default: the Effect logger. */
  readonly report?: ((error: GraphQLError) => void) | undefined;
  /** No request log and no "Listening on" line (tests). Default false. */
  readonly quiet?: boolean | undefined;
  /** The services the app runs on. Default: FakeApi.layer (a test builds its own, to reach the Bus). */
  readonly backend?: Layer.Layer<Services> | undefined;
  /**
   * The tracer the app's spans go to (`tracingLayer` in `src/tracing.ts`; a test passes an
   * in-memory one). Default: none, so spans are made but never exported.
   */
  readonly tracing?: Layer.Layer<never> | undefined;
}

export const makeServer = (
  schema: GraphQLSchema,
  services: Context.Context<Services>,
  options: AppOptions = {},
): Server => {
  const report =
    options.report ??
    ((error: GraphQLError) => {
      Effect.runForkWith(services)(Effect.logError("graphql error", error));
    });
  return createServer<Ctx>({
    schema: effectSchema(schema, { failure, isFailure: isAppError }),
    context: async (request) => {
      // Same fiber context and span as the route.
      const session = await runInRequest(request, Session.read(request), services);
      return contextFor(session, request.headers);
    },
    plugins: [
      apq(),
      incremental(),
      jit({ after: 3 }),
      // `context`: resolvers find the app's services also when the server is used without a
      // route (makeServer(...).handle(request) in a test); a route forks with its own context.
      effect({ context: services }),
      serverTiming(),
      reportErrors((error) => {
        report(error);
      }),
      maskErrors(),
    ],
  });
};

/**
 * The app on an HttpServer: one route, /graphql (every method, so the core answers GET with its
 * 405), served with the app's services (`backend`) and its tracer (`tracing`). Both are provided
 * to the route layer, whose finalizer drains the in-flight mutations on shutdown before the
 * services are released. The tracer is released last, so its last export (on shutdown) holds
 * the spans of the drained requests.
 */
export const appLayer = (schema: GraphQLSchema, options: AppOptions = {}) =>
  HttpRouter.serve(
    Layer.unwrap(
      Effect.map(Effect.context<Services>(), (services) =>
        effectRouteLayer(makeServer(schema, services, options)),
      ),
    ),
    { disableLogger: options.quiet === true, disableListenLog: options.quiet === true },
  ).pipe(
    Layer.provide(options.backend ?? FakeApi.layer),
    Layer.provide(options.tracing ?? Layer.empty),
  );
