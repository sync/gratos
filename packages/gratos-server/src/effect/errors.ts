// How an Effect resolver's failure reaches GraphQL (docs/plan.html M5, "Errors"). fromCause
// handles each cause in one of three ways:
// - a typed failure (Cause.findError) that the app's `isFailure` accepts goes to the app's mapper
//   (built with Match.tagsExhaustive, `Match.type<AppError>().pipe(Match.tagsExhaustive({ … }))`);
//   a cause that also holds a defect maps the typed error and reports the defect. A failure
//   `isFailure` rejects is a defect: the mapper only ever sees the type it was written for;
// - an interrupt-only cause carrying the ClientAbort annotation becomes the core's cancelled()
//   sentinel, which reportErrors and the error counter skip;
// - anything else is a defect: a GuardTimeout defect becomes `onTimeout()` (a 504 by default),
//   every other one a ResolverDefect (Cause.squash, with Cause.pretty as its stack), which
//   maskErrors hides because it is not a GraphQLError.
import { Cause, Data, Effect, Predicate, Result } from "effect";
import { HttpServerError } from "effect/http";
import type { GraphQLError } from "graphql";

import { cancelled, gqlError } from "../core/errors.ts";

/**
 * The defect a guarded query (or a guarded subscription's setup) dies with when it runs past its
 * timeout. It is a defect, not a typed failure, so resolver types stay `Effect<A, AppError, R>`
 * and the app's exhaustive matcher never sees it.
 */
export class GuardTimeout extends Data.TaggedError("GuardTimeout")<{
  readonly timeoutMs: number;
}> {}

/** True for a GuardTimeout defect. */
export const isGuardTimeout = (defect: unknown): defect is GuardTimeout =>
  Predicate.isTagged(defect, "GuardTimeout");

/**
 * A resolver's defect (a die, an interrupt that is not a client abort), as the Error graphql-js
 * reports. Not a GraphQLError, so `maskErrors()` replaces its message for the client.
 */
export class ResolverDefect extends Error {
  readonly _tag = "ResolverDefect";
  /** The squashed cause (Cause.squash). */
  readonly defect: unknown;

  constructor(defect: unknown, pretty: string) {
    super(Predicate.isError(defect) ? defect.message : "A resolver failed unexpectedly.");
    this.name = "ResolverDefect";
    this.defect = defect;
    this.stack = pretty;
  }
}

/**
 * Maps an app's typed failure to the GraphQL error the client gets. Build it with
 * `Match.type<AppError>().pipe(Match.tagsExhaustive({ … }))`, so a tag without a handler is a
 * type error.
 */
export type FailureMapper<E> = (error: E) => GraphQLError;

export interface FromCauseOptions<E> {
  /** The app's mapper for typed failures (see `FailureMapper`). */
  readonly failure: FailureMapper<E>;
  /**
   * Tells the app's typed failures from anything else a resolver fails with. graphql-js hands
   * failures back untyped, so the mapper only ever receives a value this accepts; any other
   * failure is a defect (a ResolverDefect, which `maskErrors()` hides). Build it from the error
   * union: `Schema.is(AppErrorSchema)`, or a `_tag` check over the union's tags.
   */
  readonly isFailure: (error: unknown) => error is E;
  /** The error a GuardTimeout becomes. Default `gqlError("Request timeout", 504)`. */
  readonly onTimeout?: ((timeout: GuardTimeout) => GraphQLError) | undefined;
  /**
   * Receives the defect of a cause that holds a typed failure too (the client gets the mapped
   * failure). Default: the Effect logger (`Effect.logError`, run with no services).
   */
  readonly onDefect?: ((defect: ResolverDefect) => void) | undefined;
}

const defaultTimeout = (): GraphQLError =>
  gqlError("Request timeout", 504, { code: "REQUEST_TIMEOUT" });

const defaultDefect = (defect: ResolverDefect): void => {
  Effect.runFork(
    Effect.logError("gratos-server: a resolver failed with a defect too.", defect.stack),
  );
};

/**
 * True when every reason is an interrupt and one of them carries the ClientAbort annotation (the
 * client left). Any other interrupt (an Effect that interrupts itself, say) is not a cancellation.
 */
export const isClientAbort = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasInterruptsOnly(cause) &&
  cause.reasons.some(
    (reason) =>
      Cause.isInterruptReason(reason) && reason.annotations.has(HttpServerError.ClientAbort.key),
  );

/** The defect part of a cause (its Die reasons), as a ResolverDefect. */
const defectOf = (cause: Cause.Cause<unknown>): ResolverDefect => {
  const dies = Cause.fromReasons(cause.reasons.filter(Cause.isDieReason));
  return new ResolverDefect(Cause.squash(dies), Cause.pretty(dies));
};

/**
 * The error a failed Effect resolver (or a failed Stream) rejects with: a GraphQLError for a
 * typed failure, a timeout or a client abort (`cancelled()`), else a ResolverDefect.
 */
export const fromCause = <E>(
  cause: Cause.Cause<unknown>,
  options: FromCauseOptions<E>,
): GraphQLError | ResolverDefect => {
  const typed = Cause.findError(cause);
  if (Result.isSuccess(typed)) {
    if (!options.isFailure(typed.success)) {
      // Not one of the app's typed failures: the mapper is never handed it.
      return new ResolverDefect(Cause.squash(cause), Cause.pretty(cause));
    }
    if (Cause.hasDies(cause)) {
      (options.onDefect ?? defaultDefect)(defectOf(cause));
    }
    return options.failure(typed.success);
  }
  if (isClientAbort(cause)) {
    return cancelled();
  }
  for (const reason of cause.reasons) {
    if (Cause.isDieReason(reason) && isGuardTimeout(reason.defect)) {
      return (options.onTimeout ?? defaultTimeout)(reason.defect);
    }
  }
  return new ResolverDefect(Cause.squash(cause), Cause.pretty(cause));
};
