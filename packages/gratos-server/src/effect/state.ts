// Per-request state shared by the Effect layer's parts (docs/plan.html M5), in WeakMaps keyed by
// objects the core never clones: the incoming Request (the route's state) and the request's
// context value (the fork context resolvers run in).
import type { Cause, Context, Fiber } from "effect";

/** What effectRoute records for a request it serves. */
export interface RouteState {
  /** When the request entered the route, in `performance.now()` milliseconds. */
  readonly t0: number;
  /** The route fiber's context, without the request Scope (the fork context's base). */
  readonly context: Context.Context<never>;
  /** Set once the HTTP request's Scope has closed (the transport is done with the response). */
  closed: boolean;
  /** Called once, when the request Scope closes. */
  readonly onClose: Set<() => void>;
}

const routes = new WeakMap<Request, RouteState>();

export const routeOf = (request: Request): RouteState | undefined => routes.get(request);

export const registerRoute = (
  request: Request,
  t0: number,
  context: Context.Context<never>,
): RouteState => {
  const state: RouteState = { t0, context, closed: false, onClose: new Set() };
  routes.set(request, state);
  return state;
};

/** Marks the route's request as closed and runs its close listeners, once. */
export const closeRoute = (state: RouteState): void => {
  if (state.closed) {
    return;
  }
  state.closed = true;
  for (const listener of state.onClose) {
    listener();
  }
  state.onClose.clear();
};

/**
 * The runtime of one request's resolvers: the context they are forked with, and the fibers still
 * running, which a client abort interrupts (except a mutation's).
 */
export interface RequestScope {
  readonly context: Context.Context<never>;
  readonly fibers: Set<Fiber.Fiber<unknown, unknown>>;
  /** Interrupt fibers on a client abort (false for a mutation: its fibers always finish). */
  readonly interruptOnAbort: boolean;
  /** Set once the client has left: a fiber forked later is interrupted at once. */
  aborted: boolean;
}

const scopes = new WeakMap<object, RequestScope>();

/** The request scope bound to a context value by effect()'s onContext, if any. */
export const scopeOf = (ctx: unknown): RequestScope | undefined =>
  typeof ctx === "object" && ctx !== null ? scopes.get(ctx) : undefined;

/** Binds a request scope to the request's context value (an object). */
export const bindScope = (ctx: unknown, scope: RequestScope): boolean => {
  if (typeof ctx !== "object" || ctx === null) {
    return false;
  }
  scopes.set(ctx, scope);
  return true;
};

/**
 * The request's fork context as providing what an app's resolvers require. graphql-js hands the
 * wrapper untyped values; the resolvers were type-checked against the app's services, which the
 * fork context carries (the route's context, or effect()'s `context`).
 */
export function servicesFor<R>(context: Context.Context<never>): Context.Context<R>;
export function servicesFor(context: Context.Context<never>): Context.Context<never> {
  return context;
}

/**
 * A resolver's failure as the app's typed failure: an app's mapper is written for the typed
 * failures of its own resolvers (`Effect<A, AppError, R>`), which graphql-js hands back untyped.
 */
export function typedCause<E>(cause: Cause.Cause<unknown>): Cause.Cause<E>;
export function typedCause(cause: Cause.Cause<unknown>): Cause.Cause<unknown> {
  return cause;
}
