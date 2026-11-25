// runInRequest(request, effect, services) (docs/plan.html M5, "Context and guard"): runs an
// Effect inside the context factory (reading the session, say). Under effectRoute it runs in the
// route fiber's context (the services, the Tracer, the HTTP span as its parent), so its span
// joins the request's trace; `services` fills in what a standalone request has no route for.
// When the client leaves (the core signal aborts), its fiber is interrupted with the ClientAbort
// annotation, so the core answers 499 and a mutation never starts.
import { Cause, Context, Effect, Exit } from "effect";
import { HttpServerError } from "effect/http";

import { cancelled } from "../core/errors.ts";
import { signalOf } from "../core/requestState.ts";
import { routeOf } from "./state.ts";

export const runInRequest = <A, E, R>(
  request: Request,
  effect: Effect.Effect<A, E, R>,
  services: Context.Context<R>,
): Promise<A> => {
  const route = routeOf(request);
  const context = route === undefined ? services : Context.merge(services, route.context);
  const fiber = Effect.runForkWith(context)(effect);
  const signal = signalOf(request);
  const interrupt = (): void => {
    fiber.interruptUnsafe(undefined, HttpServerError.ClientAbort.annotation);
  };
  if (signal?.aborted === true) {
    interrupt();
  } else {
    signal?.addEventListener("abort", interrupt, { once: true });
  }
  return new Promise<A>((resolve, reject) => {
    fiber.addObserver((exit) => {
      signal?.removeEventListener("abort", interrupt);
      if (Exit.isSuccess(exit)) {
        resolve(exit.value);
      } else if (Cause.hasInterruptsOnly(exit.cause)) {
        reject(cancelled());
      } else {
        reject(Cause.squash(exit.cause));
      }
    });
  });
};
