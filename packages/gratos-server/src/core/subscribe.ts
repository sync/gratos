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
// A source resolver that settles after the request signal aborted is dropped by graphql 17.1
// (cancellablePromise rejects at the abort and ignores the late value). The workspace patches
// graphql (patches/graphql@17.1.0.patch) so that such a source is closed, once.
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

/**
 * The response stream of one source: each event executed as subscribe() executes it. Its
 * `return()` closes the source's iterator at once, even while a pull is pending or before the
 * first pull (an async generator would queue it, or skip its `finally`), and only once.
 */
const responseStream = (
  validated: ValidatedSubscriptionArgs,
  source: AsyncIterable<unknown>,
): AsyncGenerator<ExecutionResult, void, void> => {
  const iterator = source[Symbol.asyncIterator]();
  const signal = validated.externalAbortSignal;
  /** The source ended by itself: there is nothing to close. */
  let ended = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  /** Closes the source once; its own failure to close concerns no one (as in subscribe()). */
  const close = (): Promise<void> => {
    closed = true;
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

  async function* events(): AsyncGenerator<ExecutionResult, void, void> {
    while (!closed) {
      // A source that throws ends the stream with its error; a later `return()` still reaches
      // it, as in subscribe().
      const pulled = await iterator.next();
      if (pulled.done === true) {
        ended = true;
        return;
      }
      if (closed) {
        return;
      }
      let result: ExecutionResult;
      try {
        result = await executeSubscriptionEvent({ ...validated, rootValue: pulled.value });
      } catch (error) {
        // As subscribe()'s for await: an event that fails to execute closes the source.
        await close();
        throw error;
      }
      yield result;
    }
  }

  const generator = events();
  const next = generator.next.bind(generator);
  const finish = generator.return.bind(generator);
  generator.next = () => cancellable(next(), signal);
  generator.return = async (value) => {
    await close();
    return finish(value);
  };
  return generator;
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
