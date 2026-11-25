// Per-request state shared by the Effect layer's parts (docs/plan.html M5): WeakMaps keyed by
// the incoming Request, which the core never clones (the route's state, the request scope), and
// the execution scope a resolver call finds its request scope in (an AsyncLocalStorage).
import { AsyncLocalStorage } from "node:async_hooks";

import type { Context, Fiber } from "effect";
import type { GraphQLResolveInfo, OperationDefinitionNode } from "graphql";

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
  /**
   * The operation nodes the request's execution runs (the core's `operationsOf(req)`: the
   * selected one, and any its executor bound), which a resolver's `info.operation` is. A
   * resolver of another execution that inherited the store (a nested server's, run from a timer
   * the request's resolver set) does not belong to this scope.
   */
  readonly operations: ReadonlySet<OperationDefinitionNode>;
  readonly context: Context.Context<never>;
  readonly fibers: Set<Fiber.Fiber<unknown, unknown>>;
  /**
   * The closes of the request's Stream sources that were pulled and are not closed yet: each
   * settles once its Stream's scope has closed (its finalizers ran). Its iterator's `return()`,
   * a failed pull or the end of the stream closes it.
   */
  readonly streams: Set<Promise<void>>;
  /** Interrupt fibers on a client abort (false for a mutation: its fibers always finish). */
  readonly interruptOnAbort: boolean;
  /** Set once the client has left: a fiber forked later is interrupted at once. */
  aborted: boolean;
  /**
   * Records a resolver span's end time (Clock nanoseconds): the operation span never ends before
   * it, even when the Clock reads earlier by then (a wall clock set back).
   */
  readonly spanEnded: (endTime: bigint) => void;
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

/**
 * Runs `run` with the request's scope as the execution scope (directly when it has none, or when
 * it is in effect already: the core enters the wrappers again for an entry made inside them).
 */
export const enterScope = <T>(request: Request, run: () => T): T => {
  const scope = requestScopes.get(request);
  return scope === undefined || executionScope.getStore() === scope
    ? run()
    : executionScope.run(scope, run);
};

/**
 * The request scope of the execution a resolver is called in, if any: the store, when the
 * resolver belongs to its execution (see RequestScope.operations). An AsyncLocalStorage store
 * follows every async continuation, so another execution started from one (a nested bare server,
 * a direct `execute()`) inherits it; such a resolver has no request scope.
 *
 * Known limitation: the check is by operation node, not by execution instance. graphql 17.1
 * gives a resolver no per-execution identity the request can know in advance: info.variableValues,
 * info.fragments and the info.getAbortSignal/getAsyncHelpers closures are created inside each
 * `execute()` (each subscription event, for the closures), after the wrapper has entered, and
 * by graphql-jit for its own executions; info.rootValue and the context are the app's values (a
 * subscription event's rootValue is the event). Claiming the first identity a resolver shows
 * would let a nested execution run from a plain resolver win. So a nested `execute()` that a
 * request's resolver starts on a document holding one of the request's own operation nodes
 * (reusing info.operation, say) runs with the request's scope: its Effect resolvers get the
 * request's services, OperationType and span parent, and their fibers are the request's (a
 * client abort interrupts them). Any other execution, a parse of the same text included, has
 * none.
 */
export const currentScope = (info: GraphQLResolveInfo): RequestScope | undefined => {
  const scope = executionScope.getStore();
  return scope?.operations.has(info.operation) === true ? scope : undefined;
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
 * Resolves once the request's Effect work has settled: every fiber it tracks has exited (an
 * interrupted one after its finalizers) and every Stream source it pulled has closed. The
 * operation span of a client that left ends then, after the spans that work still ends.
 */
export const settled = async (scope: RequestScope): Promise<void> => {
  while (scope.fibers.size > 0 || scope.streams.size > 0) {
    const fibers = [...scope.fibers].map(
      (fiber) =>
        new Promise<void>((resolve) => {
          fiber.addObserver(() => {
            resolve();
          });
        }),
    );
    await Promise.all([...fibers, ...scope.streams]);
  }
};
