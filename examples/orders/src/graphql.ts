// The GraphQL server: the generated schema wrapped by effectSchema, a context factory that reads
// the session with runInRequest and builds the guard, and the plugins (APQ and JIT keep their
// caches in this process's memory only, so each dev restart starts them over).
import { apq, createServer, gqlError, jit } from "@dblechoc/gratos-server";
import type { Server } from "@dblechoc/gratos-server";
import { effect, effectSchema, makeGuard, runInRequest } from "@dblechoc/gratos-server/effect";
import { Effect, Match } from "effect";
import type { Context } from "effect";
import type { GraphQLSchema } from "graphql";

import type { Ctx } from "./models/context.ts";
import type { Api } from "./services/Api.ts";
import type { Bus } from "./services/Bus.ts";
import { Forbidden, isAppError } from "./services/errors.ts";
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
    plugins: [apq(), jit(), effect()],
  });
