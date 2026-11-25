// effect(): the Effect layer's server plugin (docs/plan.html M5, "Tracing"). Per request it
// - creates the operation span `graphql <op>` in onContext, once the operation is known and before
//   any resolver forks, through the Tracer service's own span() (the only way to backdate a span),
//   as a child of the HTTP span, starting at t0 (the route's entry, else the core's startOf);
// - binds the request scope to the request, and enters it around the request's execution
//   (wrapExecution, an AsyncLocalStorage the resolver wrapper reads), never through the context
//   value, which may be shared between requests or not an object: the fork context (the route's context, or the
//   plugin's `context`) with the operation span as Tracer.ParentSpan and the OperationType, plus
//   the fibers a client abort interrupts (never a mutation's);
// - buffers the phase spans the core reports before onContext and emits them then; later phases
//   (jit compiles after onContext) are emitted at once;
// - on an early exit (no onContext: a parse or validation error, an onParams throw, an onRequest
//   answer) creates a `graphql anonymous` span in onResponse, an error only for a status >= 400;
// - counts errors in onResult, skipping cancelled() ones;
// - ends the span once, from one idempotent finalizer with three triggers: the response body (a
//   pass-through wrapper that sees done, a read error or a cancel; done after the request's own
//   signal aborted, the client leaving a stream, is a cancel), a null body (ended in
//   onResponse), and effectRoute's request Scope (the closed flag: a span created later ends
//   with cancel at once); a client that leaves once the core has ended its stream itself (its
//   closing frame sent, `streamEnded`) keeps the stream's outcome, never a cancel; plus, for a mutation, the request signal's abort (a standalone client
//   that left, whose body nobody may read). A mutation the core reports as started defers its end
//   until the core's tracked mutation settles, and ends ok or error (its errors, its answer's
//   status, a failing body), never cancel. A cancel, or a failed body (the core stops the
//   executor then), is recorded when it is decided, but with
//   Effect work still running the span ends once that work has settled (the interrupted
//   resolvers' fibers have exited, after their finalizers, and every pulled Stream has closed
//   its scope), never before the spans that work ends.
//
// Span times are nanoseconds from the Effect Clock. The core reports performance.now()
// milliseconds; every such value goes through one per-request anchor, a (clock nanos, perf ms)
// pair captured once, when the span is created: nanos = clockNanos + (perf − perfMs) × 10⁶.
import { Clock, Context, Effect, Exit, Option, Tracer } from "effect";
import { HttpServerError } from "effect/http";
import type { ExecutionResult, OperationDefinitionNode } from "graphql";

import { isCancelled } from "../core/errors.ts";
import { payloadErrors } from "../core/payload.ts";
import { mutationOf, operationsOf, signalOf, startOf, streamEnded } from "../core/requestState.ts";
import type { Phase, Plugin } from "../core/types.ts";
import { OperationType } from "./guard.ts";
import { bindScope, enterScope, routeOf, settled } from "./state.ts";
import type { RequestScope } from "./state.ts";

export interface EffectPluginOptions {
  /**
   * The fork context of a request that did not come through effectRoute (a standalone
   * `handle(Request)`): the app's services, and the Tracer and Clock spans use. Under effectRoute
   * the route fiber's context is used. Default: an empty context (the default Tracer and Clock).
   */
  readonly context?: Context.Context<never> | undefined;
  /**
   * Called after the operation span ends (tests count the calls). A throw is logged (the Effect
   * logger, run with the request's fork context) and never changes the response.
   */
  readonly onSpanEnd?: ((span: Tracer.Span, request: Request) => void) | undefined;
}

/** What ended the request, for the span's status. */
type Trigger = "complete" | "error" | "cancel";

/**
 * The end trigger of a client that left: a cancel, unless the core had ended its streamed
 * response itself (the closing frame sent), whose outcome stays (ok, or a failed source's
 * error, through its error payload).
 */
const leftAs = (request: Request): Trigger => (streamEnded(request) ? "complete" : "cancel");

/** The per-request finalizer state. */
interface SpanState {
  readonly request: Request;
  readonly context: Context.Context<never>;
  readonly tracer: Tracer.Tracer;
  readonly clock: Clock.Clock;
  /** The HTTP span (the route's ParentSpan), the operation span's parent. */
  readonly parent: Option.Option<Tracer.AnySpan>;
  /** t0 in performance.now() milliseconds. */
  readonly t0: number;
  span: Tracer.Span | undefined;
  anchor: { readonly nanos: bigint; readonly perf: number } | undefined;
  phases: Array<Phase>;
  /** The first end trigger, once the request is over for the transport. */
  trigger: Trigger | undefined;
  /** Set once effectRoute's request Scope has closed. */
  closed: boolean;
  status: number;
  errors: number;
  /** "none" for a query or subscription, else the mutation's progress. */
  mutation: "none" | "pending" | "started" | "skipped" | "settled";
  /** A settled mutation's answer status (mutationOf(req).status()). */
  answered: number | undefined;
  /** The latest end time of a child span (a phase, a resolver), in Clock nanoseconds. */
  childEnd: bigint;
  /** The request scope onContext bound, with what interrupts its fibers (a client abort). */
  scope: { readonly scope: RequestScope; readonly interrupt: () => void } | undefined;
  /** Set once the end is decided (its outcome recorded); the span may end later. */
  ended: boolean;
}

export const effect = (options: EffectPluginOptions = {}): Plugin => {
  const base = options.context ?? Context.empty();
  const states = new WeakMap<Request, SpanState>();

  /** Logs a failure of the span's own bookkeeping; the request never sees it. */
  const report = (state: SpanState, message: string, error: unknown): void => {
    Effect.runForkWith(state.context)(Effect.logError(message, error));
  };

  const finish = (state: SpanState): void => {
    const { span } = state;
    if (state.ended || span === undefined) {
      return;
    }
    state.ended = true;
    let exit: Exit.Exit<unknown, unknown>;
    // The status the core answered with, or, once a started mutation has settled before
    // onResponse ran (its client left first), the status of the answer built from its result.
    const status = state.status === 0 ? (state.answered ?? 0) : state.status;
    if (state.mutation === "settled") {
      // A started mutation always finished: ok or error, never cancel. Its answer failing (a
      // throwing result hook's 500) or its body failing is an error too.
      exit =
        state.errors > 0 || status >= 400 || state.trigger === "error"
          ? Exit.fail(state.trigger === "error" ? "response body failed" : "graphql errors")
          : Exit.void;
    } else if (state.trigger === "cancel" || state.status === 499) {
      exit = Exit.interrupt();
    } else if (state.trigger === "error" || state.status >= 400 || state.errors > 0) {
      exit = Exit.fail(state.trigger === "error" ? "response body failed" : "graphql errors");
    } else {
      exit = Exit.void;
    }
    span.attribute("graphql.errors", state.errors);
    span.attribute("http.response.status_code", status);
    const scope = state.scope;
    const cancelled = Exit.hasInterrupts(exit);
    if (
      (cancelled || state.trigger === "error") &&
      scope !== undefined &&
      (scope.scope.fibers.size > 0 || scope.scope.streams.size > 0)
    ) {
      // The client left, or the streamed response failed (the core stops its executor then),
      // with Effect work still running: its outcome is recorded now, but the span ends once that
      // work has settled (interrupted resolvers have exited, after their finalizers; pulled
      // Streams have closed their scopes), after the spans it still ends. The transport is not
      // held: the response is over for it already. A failed stream's executor is stopped by the
      // core (its signal aborts, which interrupts the fibers), so only a cancel interrupts here.
      if (cancelled && scope.scope.interruptOnAbort) {
        scope.interrupt();
      }
      void settled(scope.scope)
        .then(() => {
          endSpan(state, span, exit);
        })
        .catch((error: unknown) => {
          report(state, "gratos-server: ending the operation span failed.", error);
        });
      return;
    }
    endSpan(state, span, exit);
  };

  /** Ends the operation span, at its end time, and reports it. */
  const endSpan = (
    state: SpanState,
    span: Tracer.Span,
    exit: Exit.Exit<unknown, unknown>,
  ): void => {
    // Never before a phase (on the anchored timeline: a coarse Clock read alone could end the
    // operation before a jit compile reported after onContext) nor before a resolver span
    // (which ends on a Clock read: the anchor alone can be a little behind the Clock), whose
    // recorded end also bounds it (a Clock set back after the resolver ended reads earlier).
    let end = nanosOf(state, performance.now());
    for (const bound of [state.clock.currentTimeNanosUnsafe(), state.childEnd]) {
      if (bound > end) {
        end = bound;
      }
    }
    try {
      span.end(end, exit);
    } catch (error) {
      report(state, "gratos-server: ending the operation span failed.", error);
    }
    try {
      options.onSpanEnd?.(span, state.request);
    } catch (error) {
      report(state, "gratos-server: an onSpanEnd callback failed.", error);
    }
  };

  /** Ends the span once every condition holds: a trigger, a span, no mutation still running. */
  const tryEnd = (state: SpanState): void => {
    if (state.trigger === undefined || state.span === undefined) {
      return;
    }
    if (state.mutation === "pending" || state.mutation === "started") {
      return;
    }
    finish(state);
  };

  const requestEnd = (state: SpanState, trigger: Trigger): void => {
    state.trigger ??= trigger;
    tryEnd(state);
  };

  const stateOf = (request: Request): SpanState => {
    let state = states.get(request);
    if (state !== undefined) {
      return state;
    }
    const route = routeOf(request);
    const context = route?.context ?? base;
    const created: SpanState = {
      request,
      context,
      tracer: Context.get(context, Tracer.Tracer),
      clock: Context.get(context, Clock.Clock),
      parent: Context.getOption(context, Tracer.ParentSpan),
      t0: route?.t0 ?? startOf(request) ?? performance.now(),
      span: undefined,
      anchor: undefined,
      phases: [],
      trigger: undefined,
      closed: false,
      status: 0,
      errors: 0,
      mutation: "none",
      answered: undefined,
      childEnd: 0n,
      scope: undefined,
      ended: false,
    };
    state = created;
    states.set(request, created);
    if (route !== undefined) {
      const onClose = (): void => {
        created.closed = true;
        requestEnd(created, leftAs(request));
      };
      if (route.closed) {
        created.closed = true;
      } else {
        route.onClose.add(onClose);
      }
    }
    return state;
  };

  const nanosOf = (state: SpanState, perf: number): bigint => {
    const anchor = state.anchor ?? { nanos: state.clock.currentTimeNanosUnsafe(), perf };
    return anchor.nanos + BigInt(Math.round((perf - anchor.perf) * 1_000_000));
  };

  const childEnded = (state: SpanState, endTime: bigint): void => {
    if (endTime > state.childEnd) {
      state.childEnd = endTime;
    }
  };

  const emitPhase = (state: SpanState, span: Tracer.Span, phase: Phase): void => {
    const child = state.tracer.span({
      name: phase.name,
      parent: Option.some(span),
      annotations: Context.empty(),
      links: [],
      startTime: nanosOf(state, phase.start),
      kind: "internal",
      root: false,
      sampled: span.sampled,
    });
    const end = nanosOf(state, phase.end);
    child.end(end, Exit.void);
    childEnded(state, end);
  };

  /** Creates the operation span (or the early-exit span), backdated to t0, with its phases. */
  const createSpan = (state: SpanState, name: string): Tracer.Span => {
    state.anchor = { nanos: state.clock.currentTimeNanosUnsafe(), perf: performance.now() };
    const parent = state.parent;
    const span = state.tracer.span({
      name,
      parent,
      annotations: Context.empty(),
      links: [],
      startTime: nanosOf(state, state.t0),
      kind: "internal",
      root: false,
      // A Span and an ExternalSpan (a propagated parent) both carry their sampling decision.
      sampled: Option.isSome(parent) ? parent.value.sampled : true,
    });
    state.span = span;
    for (const phase of state.phases) {
      emitPhase(state, span, phase);
    }
    state.phases = [];
    if (state.closed) {
      // The client left before the span existed (during the context factory, say).
      requestEnd(state, "cancel");
    }
    return span;
  };

  const onContext = (_ctx: unknown, request: Request, operation: OperationDefinitionNode): void => {
    const state = stateOf(request);
    if (state.span !== undefined) {
      return;
    }
    const type = operation.operation;
    const mutation = type === "mutation" ? mutationOf(request) : undefined;
    if (mutation !== undefined) {
      // Registered before the mutation can start, so the end runs before drain() resolves.
      state.mutation = "pending";
      void mutation.started.then((started) => {
        if (!started) {
          state.mutation = "skipped";
          tryEnd(state);
        } else if (state.mutation === "pending") {
          state.mutation = "started";
        }
      });
      void mutation.settled.then(() => {
        if (state.mutation === "started" || state.mutation === "pending") {
          state.mutation = "settled";
          state.answered = mutation.status();
          tryEnd(state);
        }
      });
      // The client leaving is an end trigger too: a standalone request has no route scope, and
      // nobody may ever read or cancel its body. The end is still deferred until the mutation
      // settles (before drain() resolves), and is ok or error, never cancel.
      const signal = signalOf(request);
      if (signal?.aborted === true) {
        requestEnd(state, "cancel");
      } else {
        signal?.addEventListener(
          "abort",
          () => {
            requestEnd(state, "cancel");
          },
          { once: true },
        );
      }
    }
    const span = createSpan(state, `graphql ${operation.name?.value ?? "anonymous"}`);
    span.attribute("graphql.operation.type", type);
    if (operation.name !== undefined) {
      span.attribute("graphql.operation.name", operation.name.value);
    }
    if (type === "mutation") {
      span.attribute("graphql.mutation", true);
    }
    const scope: RequestScope = {
      operations: operationsOf(request) ?? new Set([operation]),
      context: Context.add(
        Context.add(state.context, Tracer.ParentSpan, span),
        OperationType,
        type,
      ),
      fibers: new Set(),
      streams: new Set(),
      interruptOnAbort: type !== "mutation",
      aborted: false,
      spanEnded: (endTime) => {
        childEnded(state, endTime);
      },
    };
    bindScope(request, scope);
    const interrupt = (): void => {
      if (scope.aborted) {
        return;
      }
      scope.aborted = true;
      for (const fiber of scope.fibers) {
        fiber.interruptUnsafe(undefined, HttpServerError.ClientAbort.annotation);
      }
    };
    state.scope = { scope, interrupt };
    const signal = signalOf(request);
    if (scope.interruptOnAbort && signal !== undefined) {
      if (signal.aborted) {
        interrupt();
      } else {
        signal.addEventListener("abort", interrupt, { once: true });
      }
    }
  };

  /** A pass-through body that ends the span when the transport is done with it. */
  const wrapBody = (state: SpanState, body: ReadableStream<Uint8Array>): ReadableStream => {
    const reader = body.getReader();
    let done = false;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (done) {
            return;
          }
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch (error) {
            if (done) {
              return;
            }
            done = true;
            controller.error(error);
            requestEnd(state, "error");
            return;
          }
          // A cancel while the read was pending: the controller is closed.
          if (done) {
            return;
          }
          if (read.done) {
            done = true;
            controller.close();
            // The core ends the body at once when the client leaves (the incoming signal aborts
            // the core one): that end is a cancel, unless the core had ended the stream itself
            // before (its closing frame sent). A source failure also aborts the core signal,
            // never the incoming one, and keeps its error outcome (its error payload).
            requestEnd(state, state.request.signal.aborted ? leftAs(state.request) : "complete");
            return;
          }
          controller.enqueue(read.value);
        },
        // The cancel always reaches the original body (the core stops its executor there).
        cancel: async (reason) => {
          done = true;
          try {
            requestEnd(state, leftAs(state.request));
          } finally {
            await reader.cancel(reason);
          }
        },
      },
      { highWaterMark: 0 },
    );
  };

  return {
    name: "effect",
    onPhase: (phase, request) => {
      const state = stateOf(request);
      if (state.span === undefined) {
        state.phases.push(phase);
      } else {
        emitPhase(state, state.span, phase);
      }
      return undefined;
    },
    onContext,
    wrapExecution: enterScope,
    onResult: (payload: ExecutionResult, _ctx, request) => {
      const state = stateOf(request);
      for (const error of payloadErrors(payload)) {
        if (!isCancelled(error)) {
          state.errors += 1;
        }
      }
      return undefined;
    },
    onResponse: (response, request) => {
      const state = stateOf(request);
      state.status = response.status;
      if (state.span === undefined) {
        createSpan(state, "graphql anonymous");
      }
      if (response.body === null || response.status === 0) {
        requestEnd(state, "complete");
        return undefined;
      }
      if (state.ended) {
        return undefined;
      }
      return new Response(wrapBody(state, response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
};
