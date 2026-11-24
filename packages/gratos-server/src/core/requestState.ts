// Per-request state that hooks read through core exports, backed by WeakMaps keyed by the
// uncloned incoming Request (docs/plan.html M4a, "The core owns the abort signal").
import type { MutationState } from "./types.ts";

const signals = new WeakMap<Request, AbortSignal>();
const starts = new WeakMap<Request, number>();
const mutations = new WeakMap<Request, MutationState>();

/**
 * The core's abort signal for a request: linked to `Request.signal` and aborted when the response
 * body is cancelled. It is the signal query and subscription execution receive (never mutations).
 */
export const signalOf = (request: Request): AbortSignal | undefined => signals.get(request);

/** When `handle()` received the request, in `performance.now()` milliseconds. */
export const startOf = (request: Request): number | undefined => starts.get(request);

/** The mutation state of a request whose selected operation is a mutation, else `undefined`. */
export const mutationOf = (request: Request): MutationState | undefined => mutations.get(request);

/** A mutation's started/settled signals, with the functions that publish them. */
export interface MutationTracker {
  readonly state: MutationState;
  /** Publishes `started: true`; the settle promise must be passed once execution is under way. */
  readonly start: () => void;
  readonly settle: () => void;
  /** Publishes `started: false` (and `settled`) unless the mutation already started. */
  readonly skip: () => void;
  readonly isStarted: () => boolean;
}

export const registerRequest = (request: Request, signal: AbortSignal, start: number): void => {
  signals.set(request, signal);
  starts.set(request, start);
};

export const registerMutation = (request: Request): MutationTracker => {
  const started = Promise.withResolvers<boolean>();
  const settled = Promise.withResolvers<undefined>();
  let state: "pending" | "started" | "skipped" = "pending";
  const tracker: MutationTracker = {
    state: { started: started.promise, settled: settled.promise },
    start: () => {
      if (state === "pending") {
        state = "started";
        started.resolve(true);
      }
    },
    settle: () => {
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
