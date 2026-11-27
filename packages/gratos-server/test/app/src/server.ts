// The test app's wiring, as an app would write it (docs/plan.html M5): the generated schema
// wrapped by effectSchema, a context factory that reads the session with runInRequest, the guard,
// the effect() plugin, and effectRouteLayer served by HttpRouter on NodeHttpServer, provided with
// the same service and tracer layers as the rest of the app (so the drain runs before they are
// released). examples/orders (M6, M7) follows the same shape.
import { createServer as createHttpServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Match, Tracer } from "effect";
import type { Context, Duration } from "effect";
import { HttpRouter } from "effect/http";

import { createServer, gqlError } from "../../../src/index.ts";
import type { Logger, Plugin, Server } from "../../../src/index.ts";
import {
  effect,
  effectRouteLayer,
  effectSchema,
  makeGuard,
  runInRequest,
} from "../../../src/effect/index.ts";
import type { Ctx, DerivedHold } from "./context.ts";
import { Forbidden, isAppError } from "./errors.ts";
import type { AppError } from "./errors.ts";
import { getSchema } from "./generated/schema.ts";
import { Api, Bus, JournalRef } from "./services.ts";
import type { Journal } from "./services.ts";

/** The app's failure mapper: exhaustive over AppError's tags. */
export const failure = Match.type<AppError>().pipe(
  Match.tagsExhaustive({
    NotFound: (error) => gqlError(`Order ${error.id} not found.`, 404, { code: "NOT_FOUND" }),
    Forbidden: () => gqlError("Forbidden.", 403, { code: "FORBIDDEN" }),
  }),
);

export type Services = Api | Bus | JournalRef;

export interface AppOptions {
  readonly journal: Journal;
  readonly plugins?: ReadonlyArray<Plugin<Ctx>> | undefined;
  readonly logger?: Logger | undefined;
  readonly guardTimeout?: Duration.Input | undefined;
  /** Holds every request's derived context (the late-source test). */
  readonly derivedHold?: DerivedHold | undefined;
  /** Holds Order.confirmation (the shutdown regression test). */
  readonly confirmationHold?: ((id: string) => Promise<void>) | undefined;
  /** effect()'s context, for requests that do not come through effectRoute (handle() alone). */
  readonly context?: Context.Context<never> | undefined;
  /** createServer's request body limit (the default, 1 MiB, when absent). */
  readonly maxBodyBytes?: number | undefined;
}

/**
 * The session read, in the context factory: the scopes come from `x-scopes`, and
 * `x-session-delay-ms` makes it slow (the disconnect-during-context tests).
 */
const readSession = (request: Request) =>
  Effect.gen(function* () {
    const delay = Number(request.headers.get("x-session-delay-ms") ?? "0");
    if (delay > 0) {
      yield* Effect.sleep(delay);
    }
    const scopes = (request.headers.get("x-scopes") ?? "orders:read orders:write")
      .split(" ")
      .filter((scope) => scope !== "");
    return { viewer: request.headers.get("x-viewer") ?? "ada", scopes: new Set(scopes) };
  }).pipe(Effect.withSpan("session.read"));

/** The GraphQL server, given the app's services (and, standalone, the context to fork with). */
export const makeServer = (services: Context.Context<Services>, options: AppOptions): Server =>
  createServer<Ctx>({
    schema: effectSchema(getSchema(), { failure, isFailure: isAppError }),
    context: (request) =>
      runInRequest(
        request,
        Effect.map(readSession(request), (session): Ctx => {
          const guard = makeGuard<AppError>({
            authorize: ({ scopes }) => scopes.every((scope) => session.scopes.has(scope)),
            refuse: ({ scopes }) => new Forbidden({ scopes }),
            headers: request.headers,
            timeout: options.guardTimeout,
          });
          return {
            viewer: session.viewer,
            guard: guard.guard,
            guardStream: guard.guardStream,
            derivedHold: options.derivedHold,
            confirmationHold: options.confirmationHold,
          };
        }),
        services,
      ),
    plugins: [
      ...(options.plugins ?? []),
      effect({
        context: options.context,
        onSpanEnd: (span) => {
          options.journal.entries.push(`span end ${span.name}`);
        },
      }),
    ],
    logger: options.logger ?? console,
    maxBodyBytes: options.maxBodyBytes,
  });

/** The services, with the journal the tests read. */
export const servicesLayer = (journal: Journal) =>
  Layer.mergeAll(Api.layer, Bus.layer).pipe(Layer.provideMerge(Layer.succeed(JournalRef, journal)));

/** The tracer as a layer whose release is recorded (it must come after the drain). */
export const tracerLayer = (tracer: Tracer.Tracer, journal: Journal) =>
  Layer.effect(
    Tracer.Tracer,
    Effect.acquireRelease(Effect.succeed(tracer), () =>
      Effect.sync(() => {
        journal.entries.push("tracer released");
      }),
    ),
  );

export interface NodeOptions {
  readonly warnAfterMs?: number | undefined;
  readonly gracefulShutdownTimeout?: Duration.Input | undefined;
  readonly disablePreemptiveShutdown?: boolean | undefined;
}

/** The whole app on NodeHttpServer: the route layer provided with the same services and tracer. */
export const appLayer = (
  options: AppOptions & NodeOptions & { readonly tracer: Tracer.Tracer },
) => {
  const graphql = Layer.unwrap(
    Effect.map(Effect.context<Services>(), (services) =>
      effectRouteLayer(makeServer(services, options), { warnAfterMs: options.warnAfterMs }),
    ),
  );
  return HttpRouter.serve(graphql, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(servicesLayer(options.journal)),
    Layer.provide(tracerLayer(options.tracer, options.journal)),
    Layer.provideMerge(
      NodeHttpServer.layer(() => createHttpServer(), {
        port: 0,
        host: "127.0.0.1",
        gracefulShutdownTimeout: options.gracefulShutdownTimeout,
        disablePreemptiveShutdown: options.disablePreemptiveShutdown,
      }),
    ),
  );
};
