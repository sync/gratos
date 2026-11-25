// Type-level contract of the Effect layer (checked by `tsc`): the app's failure mapper is
// exhaustive (Match.tagsExhaustive), and guarded resolvers keep the type `Effect<A, AppError, R>`
// because a timeout is a defect, not a typed failure (docs/plan.html M5 "Done when", Guard and
// Error mapping).
import { Effect, Match, Stream } from "effect";
import type { GraphQLError } from "graphql";
import { describe, expect, it } from "vitest";

import { gqlError } from "../../src/index.ts";
import { effectSchema, makeGuard } from "../../src/effect/index.ts";
import type { FailureMapper } from "../../src/effect/index.ts";
import { Forbidden, NotFound } from "../app/src/errors.ts";
import type { AppError } from "../app/src/errors.ts";
import { Api } from "../app/src/services.ts";
import type { OrderRow } from "../app/src/services.ts";
import { makeSchema } from "../support/schema.ts";

const guard = makeGuard<AppError>({
  authorize: () => true,
  refuse: ({ scopes }) => new Forbidden({ scopes }),
});

describe("the failure mapper", () => {
  it("is exhaustive over the app's error tags", () => {
    const mapper: FailureMapper<AppError> = Match.type<AppError>().pipe(
      Match.tagsExhaustive({
        NotFound: (error) => gqlError(error.id, 404),
        Forbidden: () => gqlError("Forbidden", 403),
      }),
    );
    expect(mapper(new NotFound({ id: "x" })).message).toBe("x");

    expect(() => {
      void Match.type<AppError>().pipe(
        // @ts-expect-error: Forbidden has no handler, so the matcher is not exhaustive.
        Match.tagsExhaustive({
          NotFound: (error: NotFound): GraphQLError => gqlError(error.id, 404),
        }),
      );
    }).not.toThrow();
  });

  it("is what effectSchema takes", () => {
    const schema = makeSchema("type Query { a: String }");
    const failure = Match.type<AppError>().pipe(
      Match.tagsExhaustive({
        NotFound: () => gqlError("not found", 404),
        Forbidden: () => gqlError("forbidden", 403),
      }),
    );
    expect(effectSchema(schema, { failure })).toBe(schema);
  });
});

const order = (id: string): Effect.Effect<OrderRow, AppError, Api> =>
  guard.guard({
    scopes: ["orders:read"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      return yield* api.order(id);
    }),
  });
const changes = (): Stream.Stream<number, AppError, Api> =>
  guard.guardStream({
    stream: Effect.gen(function* () {
      yield* Api;
      return Stream.make(1, 2);
    }),
  });

describe("guarded resolvers", () => {
  it("keep the type Effect<A, AppError, R>: a timeout is never a typed failure", () => {
    expect(Effect.isEffect(order("o-1"))).toBe(true);
    expect(Stream.isStream(changes())).toBe(true);
  });
});
