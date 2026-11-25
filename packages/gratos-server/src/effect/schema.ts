// effectSchema (docs/plan.html M5, "Wrapper"): wraps every resolve and subscribe of a schema
// once, at startup, so a resolver may return an Effect (and a subscription source a Stream).
// Each return value takes the cheapest path:
// - a plain value is returned after one Effect.isEffect check;
// - an Exit (Effect.succeed, Effect.fail, a guard refusal) is answered at once, with no fiber;
// - an Effect is forked with runForkWith(the request's fork context, from the execution scope
//   effect()'s wrapExecution enters; never from the context value); when pollUnsafe already has
//   its exit (a synchronous Effect), the value is returned with no Promise, else the fiber is
//   tracked in the request scope until it completes (addObserver) and a Promise is returned.
// A thenable (Grats' async adapters for an async derived context) keeps its fast path, but its
// fulfilled value is classified the same way: an Effect is run, a Stream becomes the
// single-iterator iterable. A subscription source may also be an Effect (or an Exit) of its
// Stream or AsyncIterable: it is run through the same runner, then its value is classified. A resolver that returns a tagged-error instance as data counts as an
// Effect (a Data.TaggedError is yieldable): it fails with itself and goes through the mapper.
//
// Semantic non-null: Grats emits `extensions.gratos.semanticNonNull` instead of assertNonNull for
// an Effect-returning resolve, and the wrapper checks the unwrapped value, raising the same error.
// Stream items are not checked here: the subscription field's own resolve(payload) keeps Grats'
// assertNonNull, so a null item is one event with an error and the subscription carries on.
import { Context, Effect, Exit, Predicate, Stream } from "effect";
import type { Fiber, Tracer } from "effect";
import { HttpServerError } from "effect/http";
import { isObjectType } from "graphql";
import type { GraphQLField, GraphQLFieldResolver, GraphQLSchema } from "graphql";

import { cancelled } from "../core/errors.ts";
import type { PromiseOrValue } from "../core/types.ts";
import { fromCause } from "./errors.ts";
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

/** The fork context of a request without an effect() plugin (unit tests, a bare server). */
const emptyScope: RequestScope = {
  context: Context.empty(),
  fibers: new Set(),
  interruptOnAbort: false,
  aborted: false,
  spanEnded: () => {},
};

/** A Promise as graphql-js tells one: an object whose `then` is a function. */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  Predicate.hasProperty(value, "then") && Predicate.isFunction(value.then);

const NON_NULL_MESSAGE = "Cannot return null for semantically non-nullable field.";

/** Reads `extensions.gratos.semanticNonNull`, the Grats marker for an Effect resolve. */
const isSemanticNonNull = (field: GraphQLField<unknown, unknown>): boolean => {
  const gratos: unknown = field.extensions["gratos"];
  return Predicate.hasProperty(gratos, "semanticNonNull") && gratos.semanticNonNull === true;
};

/** Starts tracking a running fiber in its request scope; it removes itself when it completes. */
const track = (scope: RequestScope, fiber: Fiber.Fiber<unknown, unknown>): void => {
  if (scope === emptyScope) {
    return;
  }
  if (scope.aborted && scope.interruptOnAbort) {
    fiber.interruptUnsafe(undefined, HttpServerError.ClientAbort.annotation);
    return;
  }
  scope.fibers.add(fiber);
  fiber.addObserver(() => {
    scope.fibers.delete(fiber);
  });
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

  const run = (effect: Effect.Effect<unknown, unknown, unknown>): PromiseOrValue<unknown> => {
    if (Exit.isExit(effect)) {
      return settleExit(effect);
    }
    // The execution scope (effect()'s wrapExecution): a thenable's continuation inherits it.
    const scope = currentScope() ?? emptyScope;
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
    track(scope, fiber);
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
  const resolveValue = (value: unknown): PromiseOrValue<unknown> => {
    if (Effect.isEffect(value)) {
      return run(value);
    }
    if (isThenable(value)) {
      return Promise.resolve(value).then((fulfilled) => resolveValue(fulfilled));
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
  const sourceValue = (value: unknown): PromiseOrValue<unknown> => {
    if (Stream.isStream(value)) {
      return streamSource(value, currentScope() ?? emptyScope, options);
    }
    if (Effect.isEffect(value)) {
      const ran = run(value);
      return Predicate.isPromise(ran) ? ran.then(sourceValue) : sourceValue(ran);
    }
    if (isThenable(value)) {
      return Promise.resolve(value).then((fulfilled) => sourceValue(fulfilled));
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
    [Symbol.asyncIterator]: () => (iterator ??= iterable[Symbol.asyncIterator]()),
  };
};

/** Wraps one subscribe function. */
export const wrapSubscribe = <TSource, TContext, TArgs, E>(
  subscribe: GraphQLFieldResolver<TSource, TContext, TArgs>,
  options: EffectSchemaOptions<E>,
  spanName = "subscribe",
): GraphQLFieldResolver<TSource, TContext, TArgs> => {
  const { sourceValue } = makeRunner(options, spanName, false);
  return (source, args, ctx, info) => sourceValue(subscribe(source, args, ctx, info));
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
          runner.resolveValue(resolve(source, args, ctx, info)),
        );
      }
      if (subscribe !== undefined && !wrappedFunctions.has(subscribe)) {
        field.subscribe = wrapped<GraphQLFieldResolver<unknown, unknown>>(
          (source, args, ctx, info) => sources.sourceValue(subscribe(source, args, ctx, info)),
        );
      }
    }
  }
  return schema;
};
