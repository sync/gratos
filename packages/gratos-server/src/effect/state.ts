// Per-request state shared by the Effect layer's parts (docs/plan.html M5): WeakMaps keyed by
// the incoming Request, which the core never clones (the route's state, the request scope), and
// the execution scope a resolver call finds its request scope in (an AsyncLocalStorage).
import { AsyncLocalStorage } from "node:async_hooks";

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

const requestScopes = new WeakMap<Request, RequestScope>();

/** Binds a request scope to the request, from effect()'s onContext. */
export const bindScope = (request: Request, scope: RequestScope): void => {
  requestScopes.set(request, scope);
};

/** The request scope effect()'s onContext bound to a request, if any. */
export const scopeOfRequest = (request: Request): RequestScope | undefined =>
  requestScopes.get(request);

/**
 * The request scope of the execution running now. effect()'s `wrapExecution` enters it around
 * every synchronous entry into the request's execution (the executor call, each subscription
 * event, each pull of deferred payloads), and the async continuations of that work (a resolver
 * called after an await, deferred work graphql-js schedules) inherit it. The context value plays
 * no part, so the app's resolvers receive it unchanged, shared between requests or not an object.
 */
const executionScope = new AsyncLocalStorage<RequestScope>();

/** Runs `run` with the request's scope as the execution scope (directly when it has none). */
export const enterScope = <T>(request: Request, run: () => T): T => {
  const scope = requestScopes.get(request);
  return scope === undefined ? run() : executionScope.run(scope, run);
};

/** The request scope of the execution a resolver is called in, if any. */
export const currentScope = (): RequestScope | undefined => executionScope.getStore();

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
