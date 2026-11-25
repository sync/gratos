// How the core runs a subscription (docs/plan.html M4b): graphql-js subscribe()'s own pipeline,
// with the core holding the source's iterator. validateSubscriptionArgs, then
// createSourceEventStream (the source resolver, its errors and the abort signal, as subscribe()
// runs them), then every event through executeSubscriptionEvent with the event as its root value
// (as subscribe() maps events), on the request's pinned schema itself.
//
// subscribe() maps events with graphql 17.1's mapAsyncIterable, which asks the source for its
// iterator twice: once for the iterator it reads, once for the one it closes. An async generator
// returns itself each time, but a plain AsyncIterable may make a new iterator on every call, and
// then `return()` reaches an iterator nobody reads: a pull that only `return()` would release (an
// idle source) is never released, and a body cancel waits on it forever. Here the source is asked
// once, and the iterator it gives is the one read and closed.
//
// Known graphql 17.1 limitation: a source resolver that settles after the request signal aborted
// is dropped (cancellablePromise rejects at the abort and ignores the late value), so its
// iterator never gets `return()` and the core never sees it. The client still gets a quiet 499.
// A source whose setup acquires something must release it itself: watch info.getAbortSignal()
// and close what it set up if the signal has aborted by then (test/subscriptions.test.ts,
// selfCleaningSetup). graphql is not patched; an upstream fix is a follow-up.
import {
  createSourceEventStream,
  executeSubscriptionEvent,
  validateSubscriptionArgs,
} from "graphql";
import type { ExecutionArgs, ExecutionResult, ValidatedSubscriptionArgs } from "graphql";

import type { PromiseOrValue } from "./types.ts";

const isPromiseLike = <T>(value: PromiseOrValue<T>): value is Promise<T> =>
  typeof value === "object" && value !== null && "then" in value;

/** A pull that rejects with the signal's reason once it aborts, as subscribe()'s pulls do. */
const cancellable = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    // The pull still runs to its end; only its outcome is ignored.
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  const { promise: settled, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = (): void => {
    reject(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  promise.then(resolve, reject).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
  return settled;
};

const DONE: IteratorReturnResult<void> = { done: true, value: undefined };

/** What a pending pull settles with once the stream is closed. */
const CLOSED: unique symbol = Symbol("closed");

/**
 * The response stream of one source: each event executed as subscribe() executes it. It is an
 * explicit iterator, not an async generator, whose calls a generator would queue behind a pending
 * pull (or skip its `finally` before the first one). Closing it (`return()`, an event that
 * fails to execute) reaches the source's iterator once and at once, even while a pull is
 * pending or before the first pull, and settles a pending pull as done even when the source's
 * own `next()` never settles. As in graphql's mapAsyncIterable, pulls are not queued.
 */
const responseStream = (
  validated: ValidatedSubscriptionArgs,
  source: AsyncIterable<unknown>,
): AsyncGenerator<ExecutionResult, void, void> => {
  const iterator = source[Symbol.asyncIterator]();
  const signal = validated.externalAbortSignal;
  /** No more pulls reach the source: it ended, it threw, or the stream was closed. */
  let finished = false;
  /** The source ended by itself: there is nothing to close. */
  let ended = false;
  let closing: Promise<void> | undefined;
  /**
   * Settles each pending pull as closed. One per pull (not one shared promise every pull races),
   * so a long subscription does not pile up reactions.
   */
  const pending = new Set<(closed: typeof CLOSED) => void>();

  /** Closes the source once; its own failure to close concerns no one (as in subscribe()). */
  const close = (): Promise<void> => {
    finished = true;
    for (const settle of pending) {
      settle(CLOSED);
    }
    pending.clear();
    closing ??= ended
      ? Promise.resolve()
      : (async () => {
          try {
            await iterator.return?.();
          } catch {
            // Ignored, as subscribe() ignores it.
          }
        })();
    return closing;
  };

  const pull = async (): Promise<IteratorResult<ExecutionResult, void>> => {
    if (finished) {
      return DONE;
    }
    const closed = Promise.withResolvers<typeof CLOSED>();
    pending.add(closed.resolve);
    let pulled: IteratorResult<unknown> | typeof CLOSED;
    try {
      pulled = await Promise.race([iterator.next(), closed.promise]);
    } catch (error) {
      // A source that throws ends the stream with its error; a later `return()` still reaches
      // it, as in subscribe().
      finished = true;
      throw error;
    } finally {
      pending.delete(closed.resolve);
    }
    if (pulled === CLOSED || finished) {
      return DONE;
    }
    if (pulled.done === true) {
      finished = true;
      ended = true;
      return DONE;
    }
    let result: ExecutionResult;
    try {
      result = await executeSubscriptionEvent({ ...validated, rootValue: pulled.value });
    } catch (error) {
      // As subscribe()'s for await: an event that fails to execute closes the source.
      await close();
      throw error;
    }
    return finished ? DONE : { done: false, value: result };
  };

  const stream: AsyncGenerator<ExecutionResult, void, void> = {
    next: () => cancellable(pull(), signal),
    return: async () => {
      await close();
      return DONE;
    },
    throw: (error: unknown) => Promise.reject(error),
    [Symbol.asyncIterator]: () => stream,
    [Symbol.asyncDispose]: async () => {
      await close();
    },
  };
  return stream;
};

/**
 * Runs a subscription as graphql-js subscribe() does, returning its response stream, or the
 * errors-only result of a subscription that could not start.
 */
export const subscribeOnce = (
  args: ExecutionArgs,
): PromiseOrValue<AsyncGenerator<ExecutionResult, void, void> | ExecutionResult> => {
  const validated = validateSubscriptionArgs(args);
  if (!("schema" in validated)) {
    return { errors: validated };
  }
  const adopt = (
    resultOrStream: AsyncIterable<unknown> | ExecutionResult,
  ): AsyncGenerator<ExecutionResult, void, void> | ExecutionResult =>
    Symbol.asyncIterator in resultOrStream
      ? responseStream(validated, resultOrStream)
      : resultOrStream;
  const resultOrStream = createSourceEventStream(validated);
  return isPromiseLike(resultOrStream) ? resultOrStream.then(adopt) : adopt(resultOrStream);
};
