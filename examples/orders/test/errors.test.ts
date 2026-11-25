// The app's typed failures (src/services/errors.ts) and effectSchema's `isFailure` guard: only real
// NotFound and Forbidden instances reach the failure mapper. Any other value a resolver fails
// with, a foreign object with a matching `_tag` included, is a defect, which the server masks
// (docs/plan.html M5, "Amended during M5 review": isFailure).
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql";

import { getSchema } from "../src/generated/schema.ts";
import { makeServer } from "../src/graphql.ts";
import { Bus } from "../src/services/Bus.ts";
import { Forbidden, isAppError, NotFound } from "../src/services/errors.ts";
import { FakeApi } from "../src/services/FakeApi.ts";

describe("isAppError", () => {
  it("accepts the app's errors", () => {
    expect(isAppError(new NotFound({ id: "o-9" }))).toBe(true);
    expect(isAppError(new Forbidden({ scopes: ["orders:write"] }))).toBe(true);
  });

  it("rejects foreign values with a matching tag", () => {
    expect(isAppError({ _tag: "NotFound" })).toBe(false);
    expect(isAppError({ _tag: "NotFound", id: "o-9" })).toBe(false);
    expect(isAppError({ _tag: "Forbidden", scopes: [] })).toBe(false);
    expect(isAppError(Object.assign(new Error("not found"), { _tag: "NotFound", id: "o-9" }))).toBe(
      false,
    );
    expect(isAppError(undefined)).toBe(false);
  });
});

/** A schema whose `real` field fails with a NotFound, and `foreign` with a look-alike. */
const failing = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      real: { type: GraphQLString, resolve: () => Effect.fail(new NotFound({ id: "o-9" })) },
      foreign: {
        type: GraphQLString,
        resolve: () => Effect.fail({ _tag: "NotFound", id: "o-9" }),
      },
    },
  }),
});

describe("the app's server", () => {
  it.effect("resolves an order through its services with no route (handle() alone)", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(Layer.mergeAll(FakeApi.layer, Bus.layer));
      const server = makeServer(getSchema(), services);
      const response = yield* Effect.promise(() =>
        server.handle(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/graphql-response+json",
            },
            body: JSON.stringify({ query: '{ order(id: "o-1") { id } }' }),
          }),
        ),
      );
      expect(yield* Effect.promise(() => response.json())).toEqual({
        data: { order: { id: "o-1" } },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("maps the app's errors, and masks a foreign value with a matching tag", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(Layer.mergeAll(FakeApi.layer, Bus.layer));
      const server = makeServer(failing, services);
      const response = yield* Effect.promise(() =>
        server.handle(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/graphql-response+json",
            },
            body: JSON.stringify({ query: "{ real foreign }" }),
          }),
        ),
      );
      const body: unknown = yield* Effect.promise(() => response.json());
      expect(body).toEqual({
        data: { real: null, foreign: null },
        errors: [
          expect.objectContaining({
            message: "Order o-9 not found.",
            path: ["real"],
            extensions: expect.objectContaining({ code: "NOT_FOUND" }),
          }),
          expect.objectContaining({
            message: "A resolver failed unexpectedly.",
            path: ["foreign"],
          }),
        ],
      });
      // Masked: nothing of the foreign value reaches the client.
      expect(JSON.stringify(body).match(/o-9/g)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
