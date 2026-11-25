// effectRoute and effectRouteLayer (docs/plan.html M5, "Route" and "Fibers").
//
// effectRoute(server) is the handler for HttpRouter.add("*", "/graphql", …), so a GET reaches the
// core and gets its 405. Inside the route Effect it:
// - records t0 and the route fiber's context (without the request Scope: resolvers that need one
//   use Effect.scoped), keyed by the Web Request, which the core never clones;
// - answers a method the Web Request constructor rejects (TRACE, say) with the core's 405 for
//   any method but POST, before any conversion;
// - converts the request with HttpServerRequest.toWeb(req, { signal }), where the signal belongs to
//   a route AbortController that Effect.promise's signal aborts, which happens only on interrupt
//   (the client left before the Response), never on completion; the core links its own
//   controller to it. A Web-backed request, which toWeb returns as it is, is rebuilt once from
//   its current view (the URL and headers a middleware set with `modify`), with its body and a
//   signal that follows both its own signal and the route's;
// - registers the span backstop with the request Scope, which closes once the transport is done
//   with the response (after the body is written, a discarded HEAD body, a transport failure or
//   an interrupt): it sets the closed flag effect() reads;
// - answers with HttpServerResponse.fromWeb(await server.handle(request)), keeping every
//   Set-Cookie field (fromWeb keys cookies by name), and, for a HEAD request, cancels the Web
//   body the transport never reads (a Node transport discards a converted body unpulled).
//
// effectRouteLayer(server) is the route as a Layer, plus a finalizer that drains the server: it
// waits for every tracked mutation to settle (control.drain, which logs the ones still running
// every `warnAfterMs`). Provide it with the same service and tracer layers as the app, so the
// drain runs before they are released.
import { Context, Effect, Layer, Scope } from "effect";
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http";

import type { Server } from "../core/types.ts";
import { closeRoute, registerRoute, routeOf } from "./state.ts";

/** The methods the Web Request constructor rejects (the Fetch standard's forbidden methods). */
const FORBIDDEN_METHODS: ReadonlySet<string> = new Set(["CONNECT", "TRACE", "TRACK"]);

/**
 * The one Request the core gets, carrying the route's signal. toWeb builds a Request with it,
 * except for a Web-backed HttpServerRequest, which it returns as it is (ignoring the signal and
 * any URL or headers a middleware set with `modify`): that one is rebuilt once, here, from the
 * request's current URL and headers, with the source's body and a signal that aborts on either
 * the incoming request's own signal (its client left) or the route's (the route was
 * interrupted). The core never clones it, so it is the key of every per-request WeakMap.
 */
const withRouteSignal = (
  req: HttpServerRequest.HttpServerRequest,
  converted: Request,
  signal: AbortSignal,
): Request => {
  if (converted !== req.source) {
    return converted;
  }
  const { origin } = new URL(converted.url);
  // As HttpServerRequest.toURL: a path resolves below the origin, so a leading `//` keeps it.
  const url = new URL(req.url.startsWith("/") ? `.${req.url}` : req.url, origin);
  const init: RequestInit & { duplex?: "half" } = {
    method: converted.method,
    headers: req.headers,
    signal: AbortSignal.any([converted.signal, signal]),
  };
  if (converted.body !== null) {
    init.body = converted.body;
    init.duplex = "half";
  }
  return new Request(url, init);
};

/**
 * The Web Response as an HttpServerResponse. fromWeb keys cookies by name, so a Response with
 * several Set-Cookie fields (one cookie expired at one path, set at another) gets them back one
 * per field. A HEAD response's body is never read: it is cancelled here (its source's `cancel`
 * runs, the core's executor stops), and the answer has none.
 */
const toServerResponse = (
  method: string,
  response: Response,
  context: Context.Context<never>,
): HttpServerResponse.HttpServerResponse => {
  let web = response;
  if (method === "HEAD" && response.body !== null) {
    response.body.cancel().catch((error: unknown) => {
      Effect.runForkWith(context)(
        Effect.logError("gratos-server: cancelling a HEAD response's body failed.", error),
      );
    });
    web = new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const converted = HttpServerResponse.fromWeb(web);
  const fields = web.headers.getSetCookie();
  if (fields.length < 2) {
    return converted;
  }
  const cookies: Record<string, Cookies.Cookie> = {};
  for (const [index, field] of fields.entries()) {
    for (const cookie of Object.values(Cookies.fromSetCookie(field).cookies)) {
      cookies[String(index)] = cookie;
    }
  }
  return HttpServerResponse.replaceCookies(converted, Cookies.fromReadonlyRecord(cookies));
};

/** The route handler for the server. */
export const effectRoute =
  (server: Server) =>
  (
    req: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.RequestError,
    Scope.Scope
  > =>
    Effect.withFiber((fiber) => {
      if (FORBIDDEN_METHODS.has(req.method)) {
        // No Web Request can carry it: the core's answer for any method but POST.
        return Effect.succeed(
          HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } }),
        );
      }
      const t0 = performance.now();
      const controller = new AbortController();
      const context = Context.omit(Scope.Scope)(fiber.context);
      return HttpServerRequest.toWeb(req, { signal: controller.signal }).pipe(
        Effect.map((converted) => withRouteSignal(req, converted, controller.signal)),
        Effect.flatMap((request) => {
          const route = routeOf(request) ?? registerRoute(request, t0, context);
          return Effect.addFinalizer(() =>
            Effect.sync(() => {
              closeRoute(route);
            }),
          ).pipe(
            Effect.andThen(
              Effect.promise((signal) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    controller.abort(signal.reason);
                  },
                  { once: true },
                );
                return server.handle(request);
              }),
            ),
          );
        }),
        Effect.map((response) => toServerResponse(req.method, response, context)),
      );
    });

export interface EffectRouteLayerOptions {
  /** The route path. Default "/graphql". */
  readonly path?: HttpRouter.PathInput | undefined;
  /** How often the drain logs the mutations it still waits for. Default 5000 ms. */
  readonly warnAfterMs?: number | undefined;
}

/**
 * The route as a Layer (every method, so the core answers GET and HEAD with its 405), with the
 * drain finalizer: on shutdown it waits until every tracked mutation has settled.
 */
export const effectRouteLayer = (server: Server, options: EffectRouteLayerOptions = {}) => {
  const warnAfterMs = options.warnAfterMs ?? 5000;
  const drain = Layer.effectDiscard(
    Effect.addFinalizer(() => Effect.promise(() => server.control.drain({ warnAfterMs }))),
  );
  return Layer.merge(HttpRouter.add("*", options.path ?? "/graphql", effectRoute(server)), drain);
};
