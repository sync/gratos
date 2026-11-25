import { Effect, Stream } from "effect";

import type { Ctx, Viewer } from "../context.ts";
import type { AppError } from "../errors.ts";
import { Api, Bus, JournalRef } from "../services.ts";
import type { Journal, OrderRow } from "../services.ts";

/** @gqlType */
export class Order {
  /** @gqlField */
  id: string;
  /** @gqlField */
  status: string;

  constructor(row: OrderRow) {
    this.id = row.id;
    this.status = row.status;
  }

  /** An Effect field: no assertNonNull, the Effect layer checks the value (semanticNonNull). */
  /** @gqlField */
  label(): Effect.Effect<string> {
    return Effect.succeed(`${this.id}:${this.status}`);
  }

  /**
   * A plain Promise field (no fiber): the shutdown test holds it to stop a mutation between its
   * two serial fields, before the second field's Effect is forked.
   */
  /** @gqlField */
  async confirmation(ctx: Ctx): Promise<string> {
    await ctx.confirmationHold?.(this.id);
    return `confirmed ${this.id}`;
  }

  /**
   * Never resolves, and holds a resource whose release waits for the journal's
   * `note <id>` hold: an interrupted deferred selection of it exits once the release ran.
   */
  /** @gqlField */
  heldNote(): Effect.Effect<string, never, JournalRef> {
    const id = this.id;
    return Effect.gen(function* () {
      const journal = yield* JournalRef;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          journal.entries.push(`acquired note ${id}`);
        }),
        () => heldRelease(journal, `note ${id}`),
      );
      return yield* Effect.never;
    }).pipe(Effect.scoped);
  }

  /** Never resolves: a deferred selection of it stays pending until it is interrupted. */
  /** @gqlField */
  slowNote(): Effect.Effect<string, never, JournalRef> {
    const id = this.id;
    return Effect.gen(function* () {
      const journal = yield* JournalRef;
      journal.entries.push(`note started ${id}`);
      return yield* Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            journal.entries.push(`note interrupted ${id}`);
          }),
        ),
      );
    });
  }
}

/**
 * A finalizer whose release waits for the journal's hold of `key` (a test opens it), inside a
 * `release <key>` span: the operation span of a client that left must end after it.
 */
const heldRelease = (journal: Journal, key: string) =>
  Effect.gen(function* () {
    journal.entries.push(`releasing ${key}`);
    const hold = journal.holds.get(key);
    if (hold !== undefined) {
      yield* Effect.promise(() => hold);
    }
    journal.entries.push(`released ${key}`);
  }).pipe(Effect.withSpan(`release ${key}`));

/** @gqlQueryField */
export function order(id: string, ctx: Ctx): Effect.Effect<Order, AppError, Api> {
  return ctx.guard({
    scopes: ["orders:read"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      return new Order(yield* api.order(id));
    }),
  });
}

/** Admits null as a string: how this fixture returns null from an Effect<string>. */
const admitsNull = (value: string | null): value is string =>
  typeof value === "string" || value === null;

const NULL: string | null = null;

/** Succeeds with null although its type says string (a semanticNonNull field error). */
/** @gqlQueryField */
export function missingLabel(): Effect.Effect<string> {
  return admitsNull(NULL) ? Effect.succeed(NULL) : Effect.die("unreachable");
}

/** Uses the async derived context: Grats wraps the Effect in a Promise. */
/** @gqlQueryField */
export function greeting(viewer: Viewer): Effect.Effect<string> {
  return Effect.succeed(`hello ${viewer.name}`).pipe(Effect.delay("1 millis"));
}

/** Two of these in one mutation run serially: the shutdown tests hold the first. */
/** @gqlMutationField */
export function setStatus(
  id: string,
  status: string,
  ctx: Ctx,
): Effect.Effect<Order, AppError, Api | Bus> {
  return ctx.guard({
    scopes: ["orders:write"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      const row = yield* api.setStatus(id, status);
      const bus = yield* Bus;
      yield* bus.publish(row);
      return new Order(row);
    }),
  });
}

/** Yields null, then a valid value: one event with an error, then the value. */
/** @gqlSubscriptionField */
export function labels(): Stream.Stream<string> {
  return admitsNull(NULL) ? Stream.make(NULL, "o-1:open") : Stream.empty;
}

/** Uses the async derived context: Grats wraps the Stream in a Promise. */
/** @gqlSubscriptionField */
export function greetings(viewer: Viewer): Stream.Stream<string> {
  return Stream.make(`hello ${viewer.name}`, `bye ${viewer.name}`);
}

/** A guarded subscription whose setup is an Effect (guardStream bounds the setup only). */
/** @gqlSubscriptionField */
export function orderChanged(
  id: string,
  ctx: Ctx,
): Stream.Stream<Order, AppError, Bus | Api | JournalRef> {
  return ctx.guardStream({
    scopes: ["orders:read"],
    stream: Effect.gen(function* () {
      const api = yield* Api;
      yield* api.order(id);
      const journal = yield* JournalRef;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          journal.entries.push(`orderChanged released ${id}`);
        }),
      );
      const bus = yield* Bus;
      // Subscribed in the setup, so the tests can publish once it is recorded.
      const changes = yield* bus.subscribe;
      journal.entries.push(`orderChanged subscribed ${id}`);
      return changes.pipe(
        Stream.filter((row) => row.id === id),
        Stream.map((row) => new Order(row)),
      );
    }),
  });
}

/**
 * An idle subscription whose setup acquires a resource: the Stream's scope releases it when the
 * stream closes. With a slow derived context, the source settles after a client that left: it
 * must not acquire anything then (graphql 17.1 drops such a source without `return()`).
 */
/** @gqlSubscriptionField */
export function watch(viewer: Viewer, ctx: Ctx): Stream.Stream<string, AppError, JournalRef> {
  return ctx.guardStream({
    stream: Effect.gen(function* () {
      const journal = yield* JournalRef;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          journal.entries.push(`watch acquired ${viewer.name}`);
        }),
        () =>
          Effect.sync(() => {
            journal.entries.push(`watch released ${viewer.name}`);
          }),
      );
      return Stream.never;
    }),
  });
}

/**
 * One event, then idle, holding a resource whose release waits for the journal's `heldWatch`
 * hold: the Stream's scope closes only once a test opens it.
 */
/** @gqlSubscriptionField */
export function heldWatch(ctx: Ctx): Stream.Stream<string, AppError, JournalRef> {
  return ctx.guardStream({
    stream: Effect.gen(function* () {
      const journal = yield* JournalRef;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          journal.entries.push("acquired heldWatch");
        }),
        () => heldRelease(journal, "heldWatch"),
      );
      return Stream.make("first").pipe(Stream.concat(Stream.never));
    }),
  });
}
