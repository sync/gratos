// Per-request state that hooks read through core exports, backed by WeakMaps keyed by the
// uncloned incoming Request (docs/plan.html M4a, "The core owns the abort signal").
import type { OperationDefinitionNode } from "graphql";

import type { MutationState } from "./types.ts";

const signals = new WeakMap<Request, AbortSignal>();
const starts = new WeakMap<Request, number>();
const mutations = new WeakMap<Request, MutationState>();
const endedStreams = new WeakSet<Request>();
const operations = new WeakMap<Request, Set<OperationDefinitionNode>>();
const answers = new WeakMap<Request, number>();

/**
 * The core's abort signal for a request: linked to `Request.signal` and aborted when the response
 * body is cancelled. It is the signal query and subscription execution receive (never mutations).
 */
export const signalOf = (request: Request): AbortSignal | undefined => signals.get(request);

/** When `handle()` received the request, in `performance.now()` milliseconds. */
export const startOf = (request: Request): number | undefined => starts.get(request);

/** The mutation state of a request whose selected operation is a mutation, else `undefined`. */
export const mutationOf = (request: Request): MutationState | undefined => mutations.get(request);

/**
 * Whether the core has ended the request's streamed response itself (GraphQL-over-SSE or
 * multipart/mixed): its last payload and closing frame (`event: complete`, the close delimiter)
 * are in the body, which is closed after them. That is how the response ended, also when the
 * client leaves before it reads them to the end.
 */
export const streamEnded = (request: Request): boolean => endedStreams.has(request);

/** Records that the core has ended the request's streamed response (see streamEnded). */
export const endStream = (request: Request): void => {
  endedStreams.add(request);
};

/**
 * The operation nodes the request's execution runs: the selected one, bound before the context
 * phase, and any an executor bound (`ExecuteInput.bindOperation`: one it runs from a rewritten or
 * re-parsed document). A resolver whose `info.operation` is one of them belongs to the request.
 */
export const operationsOf = (request: Request): ReadonlySet<OperationDefinitionNode> | undefined =>
  operations.get(request);

/** Binds an operation node to the request's execution (see operationsOf). */
export const bindOperation = (request: Request, operation: OperationDefinitionNode): void => {
  const bound = operations.get(request);
  if (bound === undefined) {
    operations.set(request, new Set([operation]));
  } else {
    bound.add(operation);
  }
};

/**
 * The HTTP status of the GraphQL answer the core built for the request's latest handle() call (a
 * request error, a refusal, a single result, a failure's 500), also when it went out as
 * GraphQL-over-SSE with a 200 (a client that accepts no JSON type): the status a JSON client
 * would have got. `undefined` for a streamed result (its payloads carry its outcome) and for a
 * transport answer (its status is the response's).
 */
export const answerStatusOf = (request: Request): number | undefined => answers.get(request);

/** Records the status of the answer the core built for the request (see answerStatusOf). */
export const recordAnswer = (request: Request, status: number): void => {
  answers.set(request, status);
};

/** A mutation's started/settled signals, with the functions that publish them. */
export interface MutationTracker {
  readonly state: MutationState;
  /** Publishes `started: true`; the settle promise must be passed once execution is under way. */
  readonly start: () => void;
  /** Publishes `settled`, with the status of the answer built from the mutation's result. */
  readonly settle: (status: number) => void;
  /** Publishes `started: false` (and `settled`) unless the mutation already started. */
  readonly skip: () => void;
  readonly isStarted: () => boolean;
}

export const registerRequest = (request: Request, signal: AbortSignal, start: number): void => {
  signals.set(request, signal);
  starts.set(request, start);
  answers.delete(request);
};

export const registerMutation = (request: Request): MutationTracker => {
  const started = Promise.withResolvers<boolean>();
  const settled = Promise.withResolvers<undefined>();
  let state: "pending" | "started" | "skipped" = "pending";
  let status: number | undefined;
  const tracker: MutationTracker = {
    state: { started: started.promise, settled: settled.promise, status: () => status },
    start: () => {
      if (state === "pending") {
        state = "started";
        started.resolve(true);
      }
    },
    settle: (answered) => {
      status = answered;
      settled.resolve(undefined);
    },
    skip: () => {
      if (state === "pending") {
        state = "skipped";
        started.resolve(false);
        settled.resolve(undefined);
      }
    },
    isStarted: () => state === "started",
  };
  mutations.set(request, tracker.state);
  return tracker;
};
