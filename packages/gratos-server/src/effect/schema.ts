// effectSchema (docs/plan.html M5, "Wrapper"): wraps every resolve and subscribe of a schema
// once, at startup, so a resolver may return an Effect (and a subscription source a Stream).
// Each return value takes the cheapest path:
// - a plain value is returned after one Effect.isEffect check;
// - an Exit (Effect.succeed, Effect.fail, a guard refusal) is answered at once, with no fiber;
// - an Effect is forked with runForkWith(the request's fork context, from the execution scope
//   effect()'s wrapExecution enters, when the resolver's info.operation is one of the request's
//   bound operations; never from the context value); when pollUnsafe already has its exit (a synchronous Effect),
//   the value is returned with no Promise, else the fiber is tracked in the request scope until
//   it completes (addObserver) and a Promise is returned.
// A thenable (Grats' async adapters for an async derived context) keeps its fast path, but its
// fulfilled value is classified the same way: an Effect is run, a Stream becomes the
// single-iterator iterable. A subscription source may also be an Effect (or an Exit) of its
// Stream or AsyncIterable: it is run through the same runner, then its value is classified. A
// resolver that returns a tagged-error instance as data counts as an Effect (a Data.TaggedError
// is yieldable): it fails with itself and goes through the mapper.
//
// Semantic non-null: Grats emits `extensions.gratos.semanticNonNull` instead of assertNonNull for
// an Effect-returning resolve, and the wrapper checks the unwrapped value, raising the same error.
// Stream items are not checked here: the subscription field's own resolve(payload) keeps Grats'
// assertNonNull, so a null item is one event with an error and the subscription carries on.
import { Context, Effect, Exit, Predicate, Stream } from "effect";
import type { Fiber, Tracer } from "effect";
import { HttpServerError } from "effect/http";
import { isObjectType } from "graphql";
import type {
  GraphQLField,
  GraphQLFieldResolver,
  GraphQLResolveInfo,
  GraphQLSchema,
} from "graphql";

import { cancelled } from "../core/errors.ts";
import type { PromiseOrValue } from "../core/types.ts";
import { fromCause } from "./errors.ts";
import { OperationType } from "./guard.ts";
import type { FromCauseOptions } from "./errors.ts";
import { currentScope, servicesFor } from "./state.ts";
import type { RequestScope } from "./state.ts";

export type EffectSchemaOptions<E> = FromCauseOptions<E>;

/**
 * The runtime functions the wrapper calls, as one object so a test can spy on them (the "an Exit
 * creates no fiber" check spies on runForkWith). Not part of the public API.
 */
export const internals = {
  runForkWith: Effect.runForkWith,
};

type OperationKind = GraphQLResolveInfo["operation"]["operation"];

/** A scope for resolvers that run with no request scope, carrying only their operation's type. */
const unboundScopeOf = (type: OperationKind): RequestScope => ({
  operations: new Set(),
  context: Context.make(OperationType, type),
  fibers: new Set(),
  streams: new Set(),
  interruptOnAbort: false,
  signal: undefined,
  aborted: false,
  spanEnded: () => {},
});

const unboundScopes: Readonly<Record<OperationKind, RequestScope>> = {
  query: unboundScopeOf("query"),
  mutation: unboundScopeOf("mutation"),
  subscription: unboundScopeOf("subscription"),
};

/**
 * The fork context of a resolver with no request scope (a server without an effect() plugin,
 * an execution its executor did not bind to the request): no services and no fiber tracking,
 * but the OperationType of the resolver's own operation, so an unbound mutation never gets
 * the query timeout.
 */
const unboundScope = (info: GraphQLResolveInfo): RequestScope =>
  unboundScopes[info.operation.operation];

const isUnbound = (scope: RequestScope): boolean => scope.operations.size === 0;

/** A Promise as graphql-js tells one: an object whose `then` is a function. */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  Predicate.hasProperty(value, "then") && Predicate.isFunction(value.then);

const NON_NULL_MESSAGE = "Cannot return null for semantically non-nullable field.";

/** Reads `extensions.gratos.semanticNonNull`, the Grats marker for an Effect resolve. */
const isSemanticNonNull = (field: GraphQLField<unknown, unknown>): boolean => {
  const gratos: unknown = field.extensions["gratos"];
  return Predicate.hasProperty(gratos, "semanticNonNull") && gratos.semanticNonNull === true;
};

/**
 * The abort signal of the execution a resolver runs in. graphql-jit's info has no
 * `getAbortSignal` (its executions take no signal).
 */
const signalOfExecution = (info: GraphQLResolveInfo): AbortSignal | undefined => {
  const execution: { readonly getAbortSignal?: () => AbortSignal | undefined } = info;
  return execution.getAbortSignal?.();
};

/**
 * Starts tracking a running fiber in its request scope; it removes itself when it completes.
 * `signal` is its execution's (`info.getAbortSignal()`): one that is not the core signal (a
 * claim's `next()`) interrupts the fiber when it aborts, as the core signal does.
 */
const track = (
  scope: RequestScope,
  fiber: Fiber.Fiber<unknown, unknown>,
  signal: AbortSignal | undefined,
): void => {
  if (isUnbound(scope)) {
    return;
  }
  scope.fibers.add(fiber);
  fiber.addObserver(() => {
    scope.fibers.delete(fiber);
  });
  if (!scope.interruptOnAbort) {
    return;
  }
  const interrupt = (): void => {
    fiber.interruptUnsafe(undefined, HttpServerError.ClientAbort.annotation);
  };
  // Tracked still: an interrupted fiber runs its finalizers before it exits.
  if (scope.aborted || signal?.aborted === true) {
    interrupt();
  } else if (signal !== undefined && signal !== scope.signal) {
    signal.addEventListener("abort", interrupt, { once: true });
    fiber.addObserver(() => {
      signal.removeEventListener("abort", interrupt);
    });
  }
};

/** One field's wrapped resolver (or subscribe), with its error mapping and markers. */
const makeRunner = <E>(options: EffectSchemaOptions<E>, spanName: string, nonNull: boolean) => {
  /** A finished Effect's value, or the error it fails with (thrown). */
  const settleExit = (exit: Exit.Exit<unknown, unknown>): PromiseOrValue<unknown> => {
    if (Exit.isSuccess(exit)) {
      if (nonNull && (exit.value === null || exit.value === undefined)) {
        throw new Error(NON_NULL_MESSAGE);
      }
      return exit.value;
    }
    throw fromCause(exit.cause, options);
  };

  const run = (
    effect: Effect.Effect<unknown, unknown, unknown>,
    info: GraphQLResolveInfo,
  ): PromiseOrValue<unknown> => {
    if (Exit.isExit(effect)) {
      return settleExit(effect);
    }
    // The execution scope (effect()'s wrapExecution): a thenable's continuation inherits it.
    const scope = currentScope(info) ?? unboundScope(info);
    if (scope.aborted && scope.interruptOnAbort) {
      // The client has left (a Promise-wrapped resolver settled after the abort): the Effect is
      // never started. track() still interrupts a fiber whose own startup saw the abort.
      throw cancelled();
    }
    // As Effect.withSpan, keeping the span to report its end time to the request scope.
    let span: Tracer.Span | undefined;
    const fiber = internals.runForkWith(servicesFor<unknown>(scope.context))(
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- Effect.useSpan is not a React hook.
      Effect.useSpan(spanName, (opened) => {
        span = opened;
        return Effect.withParentSpan(effect, opened);
      }),
    );
    /** The span ends in the fiber, before its exit is observed. */
    const spanEnded = (): void => {
      if (span?.status._tag === "Ended") {
        scope.spanEnded(span.status.endTime);
      }
    };
    const exit = fiber.pollUnsafe();
    if (exit !== undefined) {
      spanEnded();
      return settleExit(exit);
    }
    track(scope, fiber, signalOfExecution(info));
    return new Promise<unknown>((resolve, reject) => {
      fiber.addObserver((done) => {
        spanEnded();
        try {
          resolve(settleExit(done));
        } catch (error) {
          reject(error);
        }
      });
    });
  };

  /** Classifies a resolve's return value. */
  const resolveValue = (value: unknown, info: GraphQLResolveInfo): PromiseOrValue<unknown> => {
    if (Effect.isEffect(value)) {
      return run(value, info);
    }
    if (isThenable(value)) {
      return Promise.resolve(value).then((fulfilled) => resolveValue(fulfilled, info));
    }
    if (nonNull && (value === null || value === undefined)) {
      throw new Error(NON_NULL_MESSAGE);
    }
    return value;
  };

  /**
   * Classifies a subscribe's return value: a Stream becomes the single-iterator iterable; an
   * Effect (an Exit included) is run as a field's is, and what it succeeds with is classified the
   * same way (a Stream, or an AsyncIterable as it is); a thenable's value too.
   */
  const sourceValue = (value: unknown, info: GraphQLResolveInfo): PromiseOrValue<unknown> => {
    if (Stream.isStream(value)) {
      return streamSource(value, currentScope(info) ?? unboundScope(info), options);
    }
    if (Effect.isEffect(value)) {
      const ran = run(value, info);
      return Predicate.isPromise(ran)
        ? ran.then((source) => sourceValue(source, info))
        : sourceValue(ran, info);
    }
    if (isThenable(value)) {
      return Promise.resolve(value).then((fulfilled) => sourceValue(fulfilled, info));
    }
    return value;
  };

  return { resolveValue, sourceValue };
};

/**
 * A Stream as a subscription source (wrapSubscribe): its failures take the same error paths as
 * fields (Stream.catchCause into Stream.die(fromCause)), it runs in the request's fork context
 * (Stream.toAsyncIterableWith), and the iterable is request-local and always returns the same
 * iterator, so `return()` closes the iterator that is being read, and with it the Stream's scope
 * (acquireRelease finalizers). Nothing runs before the first pull: a source that graphql-js drops
 * (one that settles after the client left, a known graphql 17.1 limitation) never acquires
 * anything, so it has nothing to leak.
 */
const streamSource = <A, E, R, F>(
  stream: Stream.Stream<A, E, R>,
  scope: RequestScope,
  options: EffectSchemaOptions<F>,
): AsyncIterable<A> => {
  const iterable = stream.pipe(
    Stream.catchCause((cause) => Stream.die(fromCause(cause, options))),
    Stream.toAsyncIterableWith(servicesFor<R>(scope.context)),
  );
  let iterator: AsyncIterator<A> | undefined;
  return {
    [Symbol.asyncIterator]: () => (iterator ??= tracked(iterable[Symbol.asyncIterator](), scope)),
  };
};

/**
 * The Stream's iterator, recording its close in the request scope (`streams`) from its first
 * pull until its Stream's scope has closed: the iterator settles `return()`, `throw()`, a failed
 * pull and the end only once the close has run its finalizers.
 */
const tracked = <A>(iterator: AsyncIterator<A>, scope: RequestScope): AsyncIterator<A> => {
  if (isUnbound(scope)) {
    return iterator;
  }
  let closing: PromiseWithResolvers<void> | undefined;
  let closed = false;
  const open = (): void => {
    if (closing === undefined && !closed) {
      closing = Promise.withResolvers();
      scope.streams.add(closing.promise);
    }
  };
  const close = (): void => {
    closed = true;
    if (closing !== undefined) {
      scope.streams.delete(closing.promise);
      closing.resolve();
    }
  };
  return {
    next: async () => {
      open();
      try {
        const result = await iterator.next();
        if (result.done === true) {
          close();
        }
        return result;
      } catch (error) {
        close();
        throw error;
      }
    },
    return: async (value?: unknown) => {
      try {
        return (await iterator.return?.(value)) ?? { done: true, value: undefined };
      } finally {
        close();
      }
    },
    throw: async (error?: unknown) => {
      try {
        if (iterator.throw === undefined) {
          throw error;
        }
        return await iterator.throw(error);
      } finally {
        close();
      }
    },
  };
};

/** Wraps one subscribe function. */
export const wrapSubscribe = <TSource, TContext, TArgs, E>(
  subscribe: GraphQLFieldResolver<TSource, TContext, TArgs>,
  options: EffectSchemaOptions<E>,
  spanName = "subscribe",
): GraphQLFieldResolver<TSource, TContext, TArgs> => {
  const { sourceValue } = makeRunner(options, spanName, false);
  return (source, args, ctx, info) => sourceValue(subscribe(source, args, ctx, info), info);
};

/**
 * The resolve and subscribe functions effectSchema made. Tracked by identity, not per schema:
 * two schemas can share their field objects (incremental()'s schema is rebuilt from the app's
 * config, with the same types), and a function already wrapped is never wrapped again.
 */
const wrappedFunctions = new WeakSet<object>();

/** Marks a wrapper effectSchema made, and returns it. */
const wrapped = <F extends object>(fn: F): F => {
  wrappedFunctions.add(fn);
  return fn;
};

/**
 * Wraps every field's `resolve` and `subscribe` in place, once (a function it already wrapped,
 * through this schema or another one that shares the field, is left as it is), and returns the
 * schema. `failure` maps the typed failures `isFailure` accepts (see `FailureMapper`); any other
 * failure is a defect.
 */
export const effectSchema = <E>(
  schema: GraphQLSchema,
  options: EffectSchemaOptions<E>,
): GraphQLSchema => {
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) {
      continue;
    }
    for (const field of Object.values(type.getFields())) {
      const spanName = `resolve ${type.name}.${field.name}`;
      const runner = makeRunner(options, spanName, isSemanticNonNull(field));
      // A source's Effect is not checked for null: the marker is about the field's values.
      const sources = makeRunner(options, `subscribe ${type.name}.${field.name}`, false);
      const { resolve, subscribe } = field;
      if (resolve !== undefined && !wrappedFunctions.has(resolve)) {
        field.resolve = wrapped<GraphQLFieldResolver<unknown, unknown>>((source, args, ctx, info) =>
          runner.resolveValue(resolve(source, args, ctx, info), info),
        );
      }
      if (subscribe !== undefined && !wrappedFunctions.has(subscribe)) {
        field.subscribe = wrapped<GraphQLFieldResolver<unknown, unknown>>(
          (source, args, ctx, info) =>
            sources.sourceValue(subscribe(source, args, ctx, info), info),
        );
      }
    }
  }
  return schema;
};
