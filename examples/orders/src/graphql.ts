// The app's wiring: the GraphQL server (the generated schema wrapped by effectSchema, a context
// factory that reads the session with runInRequest and builds the guard, and the plugins; APQ and
// JIT keep their caches in this process's memory only, so each dev restart starts them over),
// served on an HttpServer with the app's services.
//
// The server imports this module dynamically, with the generated schema: in dev, inside the boot
// step's error boundary, so a service that does not load answers GRATS_ERROR like a broken model.
import { apq, createServer, gqlError, jit } from "@dblechoc/gratos-server";
import type { Server } from "@dblechoc/gratos-server";
import {
  effect,
  effectRouteLayer,
  effectSchema,
  makeGuard,
  runInRequest,
} from "@dblechoc/gratos-server/effect";
import { Effect, Layer, Match } from "effect";
import type { Context } from "effect";
import { HttpRouter } from "effect/http";
import type { GraphQLSchema } from "graphql";

import type { Ctx } from "./models/context.ts";
import type { Api } from "./services/Api.ts";
import { Bus } from "./services/Bus.ts";
import { Forbidden, isAppError } from "./services/errors.ts";
import { FakeApi } from "./services/FakeApi.ts";
import type { AppError } from "./services/errors.ts";

export type Services = Api | Bus;

/** The app's failure mapper: exhaustive over AppError's tags. */
export const failure = Match.type<AppError>().pipe(
  Match.tagsExhaustive({
    NotFound: (error) => gqlError(`Order ${error.id} not found.`, 404, { code: "NOT_FOUND" }),
    Forbidden: () => gqlError("Forbidden.", 403, { code: "FORBIDDEN" }),
  }),
);

/** A stand-in session: the viewer and scopes come from headers until M7 brings real auth. */
const readSession = (request: Request) =>
  Effect.sync(() => {
    const scopes = (request.headers.get("x-scopes") ?? "orders:read orders:write")
      .split(" ")
      .filter((scope) => scope !== "");
    return { viewer: request.headers.get("x-viewer") ?? "ada", scopes: new Set(scopes) };
  }).pipe(Effect.withSpan("session.read"));

export const makeServer = (schema: GraphQLSchema, services: Context.Context<Services>): Server =>
  createServer<Ctx>({
    schema: effectSchema(schema, { failure, isFailure: isAppError }),
    context: (request) =>
      runInRequest(
        request,
        Effect.map(readSession(request), (session): Ctx => {
          const guard = makeGuard<AppError>({
            authorize: ({ scopes }) => scopes.every((scope) => session.scopes.has(scope)),
            refuse: ({ scopes }) => new Forbidden({ scopes }),
            headers: request.headers,
          });
          return { viewer: session.viewer, guard: guard.guard, guardStream: guard.guardStream };
        }),
        services,
      ),
    // `context`: resolvers find the app's services also when the server is used without a route
    // (makeServer(...).handle(request) in a test); a route still forks with its own context.
    plugins: [apq(), jit(), effect({ context: services })],
  });

/**
 * The app on an HttpServer: POST /graphql (and the core's answers to other methods) for `schema`,
 * served with the app's services (provided outside the router, so resolvers fork with them).
 */
export const appLayer = (schema: GraphQLSchema) =>
  HttpRouter.serve(
    Layer.unwrap(
      Effect.map(Effect.context<Services>(), (services) =>
        effectRouteLayer(makeServer(schema, services)),
      ),
    ),
  ).pipe(Layer.provide([FakeApi.layer, Bus.layer]));
