// runInRequest(request, effect, services) (docs/plan.html M5, "Context and guard"): runs an
// Effect inside the context factory (reading the session, say). Under effectRoute it runs in the
// route fiber's context (the services, the Tracer, the HTTP span as its parent), so its span
// joins the request's trace; `services` fills in what a standalone request has no route for.
// When the client leaves (the core signal aborts), its fiber is interrupted with the ClientAbort
// annotation, so the core answers 499 and a mutation never starts; when the client has already
// left, the Effect is never forked (forking runs its synchronous part at once). Any other
// failure, an interrupt that is not a client abort included (an Effect that interrupts itself),
// is an ordinary context failure: a masked 500, logged by the core.
import { Cause, Context, Effect, Exit } from "effect";
import { HttpServerError } from "effect/http";

import { cancelled } from "../core/errors.ts";
import { signalOf } from "../core/requestState.ts";
import { isClientAbort } from "./errors.ts";
import { routeOf } from "./state.ts";

export const runInRequest = <A, E, R>(
  request: Request,
  effect: Effect.Effect<A, E, R>,
  services: Context.Context<R>,
): Promise<A> => {
  const signal = signalOf(request);
  /** Read afresh at each check: the client may leave while the Effect's synchronous part runs. */
  const left = (): boolean => signal?.aborted === true;
  if (left()) {
    // The client left before the context phase (during a pending onParams hook, say).
    return Promise.reject(cancelled());
  }
  const route = routeOf(request);
  const context = route === undefined ? services : Context.merge(services, route.context);
  const fiber = Effect.runForkWith(context)(effect);
  const interrupt = (): void => {
    fiber.interruptUnsafe(undefined, HttpServerError.ClientAbort.annotation);
  };
  if (left()) {
    // The client left while the Effect's synchronous part ran.
    interrupt();
  } else {
    signal?.addEventListener("abort", interrupt, { once: true });
  }
  return new Promise<A>((resolve, reject) => {
    fiber.addObserver((exit) => {
      signal?.removeEventListener("abort", interrupt);
      if (Exit.isSuccess(exit)) {
        resolve(exit.value);
      } else if (isClientAbort(exit.cause)) {
        reject(cancelled());
      } else {
        reject(Cause.squash(exit.cause));
      }
    });
  });
};
