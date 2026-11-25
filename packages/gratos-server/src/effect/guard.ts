// makeGuard (docs/plan.html M5, "Context and guard"): `ctx.guard` and `ctx.guardStream`, built in
// the context factory from the request's session.
// - A refusal is `Effect.fail(refuse(…))`, the app's own error: that value is an Exit, so the
//   wrapper answers it with no fiber and no span.
// - The timeout (default 60 s) applies to queries only, read at run time from the OperationType
//   reference effect()'s onContext writes into the fork context. A mutation gets no interrupting
//   timeout (a half-applied write is worse than a slow one), and subscriptions bound only their
//   setup (guardStream's `setupTimeout`), never the stream's lifetime.
// - A timeout is a defect, GuardTimeout, not a typed failure: resolver types stay
//   `Effect<A, AppError, R>`, and fromCause maps it to a 504 before the app's matcher could see it.
import { Context, Duration, Effect, Stream } from "effect";
import type { Scope } from "effect";

import { GuardTimeout } from "./errors.ts";

/**
 * The type of the operation a resolver runs in. The wrapper always sets it: from the request
 * scope, or, for a resolver with none (an execution not bound to its request), from the
 * resolver's own operation. Default "query" for an Effect run outside the wrapper (unit tests).
 */
export const OperationType = Context.Reference<"query" | "mutation" | "subscription">(
  "@dblechoc/gratos-server/effect/OperationType",
  { defaultValue: () => "query" },
);

/** What a guarded call asks for. */
export interface GuardRequirements {
  /** Scopes the session must hold (all of them). */
  readonly scopes?: ReadonlyArray<string> | undefined;
  /** A feature flag that must be on. */
  readonly flag?: string | undefined;
}

/** Why a call was refused, for `refuse`. */
export interface Refusal {
  readonly scopes: ReadonlyArray<string>;
  /** The flag that is off, when the refusal comes from a flag. */
  readonly flag?: string | undefined;
}

export interface GuardOptions<E> {
  /** Whether the session holds the scopes (with the request's headers, for token checks). */
  readonly authorize: (input: {
    readonly scopes: ReadonlyArray<string>;
    readonly headers: Headers;
  }) => boolean;
  /** Builds the app's error for a refused call (Forbidden, in the app's own error union). */
  readonly refuse: (refusal: Refusal) => E;
  /** The feature flags turned on for this request. Default: none. */
  readonly flags?: Iterable<string> | undefined;
  /** The query timeout, and guardStream's default setup timeout. Default 60 seconds. */
  readonly timeout?: Duration.Input | undefined;
  /** The request's headers, handed to `authorize`. Default: empty. */
  readonly headers?: Headers | undefined;
}

export interface Guard<E> {
  /** Runs `effect` once the requirements hold, else fails with the app's refusal (an Exit). */
  readonly guard: <A, E2, R>(
    input: GuardRequirements & { readonly effect: Effect.Effect<A, E2, R> },
  ) => Effect.Effect<A, E | E2, R>;
  /**
   * A guarded subscription source. Given the setup Effect (not a Stream.unwrap of it), only that
   * setup is bounded (`setupTimeout`, default the guard timeout); the stream's lifetime is not.
   */
  readonly guardStream: <A, E2, R, E3 = never, R3 = never>(
    input: GuardRequirements & {
      readonly stream: Stream.Stream<A, E2, R> | Effect.Effect<Stream.Stream<A, E2, R>, E3, R3>;
      readonly setupTimeout?: Duration.Input | undefined;
    },
  ) => Stream.Stream<A, E | E2 | E3, R | Exclude<R3, Scope.Scope>>;
}

const DEFAULT_TIMEOUT = Duration.seconds(60);

/** Dies with GuardTimeout when `effect` runs longer than `duration`. */
const dieAfter = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  duration: Duration.Duration,
): Effect.Effect<A, E, R> =>
  Effect.timeoutOrElse(effect, {
    duration,
    orElse: () => Effect.die(new GuardTimeout({ timeoutMs: Duration.toMillis(duration) })),
  });

export const makeGuard = <E>(options: GuardOptions<E>): Guard<E> => {
  const flags = new Set(options.flags ?? []);
  const headers = options.headers ?? new Headers();
  const timeout = Duration.fromInputUnsafe(options.timeout ?? DEFAULT_TIMEOUT);

  /** The refusal, or undefined when the call may run. */
  const check = (input: GuardRequirements): E | undefined => {
    const scopes = input.scopes ?? [];
    if (input.flag !== undefined && !flags.has(input.flag)) {
      return options.refuse({ scopes, flag: input.flag });
    }
    if (scopes.length > 0 && !options.authorize({ scopes, headers })) {
      return options.refuse({ scopes });
    }
    return undefined;
  };

  const guard: Guard<E>["guard"] = (input) => {
    const refused = check(input);
    if (refused !== undefined) {
      return Effect.fail(refused);
    }
    const { effect } = input;
    return Effect.withFiber((fiber) =>
      fiber.getRef(OperationType) === "query" ? dieAfter(effect, timeout) : effect,
    );
  };

  const guardStream: Guard<E>["guardStream"] = (input) => {
    const refused = check(input);
    if (refused !== undefined) {
      return Stream.fail(refused);
    }
    const { stream } = input;
    if (Stream.isStream(stream)) {
      return stream;
    }
    const setupTimeout =
      input.setupTimeout === undefined ? timeout : Duration.fromInputUnsafe(input.setupTimeout);
    return Stream.unwrap(dieAfter(stream, setupTimeout));
  };

  return { guard, guardStream };
};
