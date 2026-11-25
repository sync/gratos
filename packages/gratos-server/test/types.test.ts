// Type-level contract of createServer (checked by `tsc`): a server whose context type excludes
// `undefined` must have a context factory, so no plugin is handed an `undefined` it does not
// expect; the default server, and one whose context may be `undefined`, need none. And
// mapPayloadErrors's result type: the errors it may replace are widened to GraphQLError.
import { GraphQLError } from "graphql";
import type { ExecutionResult } from "graphql";
import { describe, expect, it } from "vitest";

import { createServer, mapPayloadErrors } from "../src/index.ts";
import type { Plugin } from "../src/index.ts";
import { gql } from "./support/http.ts";
import { basicSchema } from "./support/schema.ts";

interface User {
  readonly user: string;
}

const needsUser: Plugin<User> = {
  onContext: (ctx) => {
    if (ctx.user === "") {
      throw new Error("no user");
    }
  },
};

describe("createServer's context factory", () => {
  it("is optional for the default server", async () => {
    const server = createServer({ schema: basicSchema() });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
  });

  it("is optional when the context may be undefined", () => {
    createServer<User | undefined>({ schema: basicSchema() });
    createServer<User | undefined>({ schema: basicSchema(), context: () => undefined });
  });

  it("is required when the context excludes undefined", async () => {
    // @ts-expect-error: a `User` context needs a factory.
    createServer<User>({ schema: basicSchema() });
    // @ts-expect-error: a plugin that reads a `User` context needs a factory that builds one.
    createServer({ schema: basicSchema(), plugins: [needsUser] });
    // @ts-expect-error: the factory must build the context type.
    createServer<User>({ schema: basicSchema(), context: () => undefined });
    const server = createServer({
      schema: basicSchema(),
      context: (): User => ({ user: "ada" }),
      plugins: [needsUser],
    });
    expect((await gql(server, "{ count }")).body).toEqual({ data: { count: 1 } });
  });
});

/** An error subclass a payload type may promise. */
class TaggedError extends GraphQLError {
  readonly tag = "tagged" as const;
}

interface TaggedEntry {
  readonly path: ReadonlyArray<string | number>;
  readonly label: "L";
  readonly errors?: ReadonlyArray<TaggedError>;
}

interface TaggedPayload extends ExecutionResult {
  readonly errors?: ReadonlyArray<TaggedError>;
  readonly incremental: ReadonlyArray<TaggedEntry>;
  readonly extensions?: { readonly trace: string };
}

describe("mapPayloadErrors's type", () => {
  it("widens the errors it may replace, at the top and in each incremental entry, and keeps every other field", () => {
    const payload: TaggedPayload = {
      errors: [new TaggedError("top")],
      incremental: [{ path: [], label: "L", errors: [new TaggedError("entry")] }],
      extensions: { trace: "t" },
    };
    const mapped = mapPayloadErrors(payload, (error) => new GraphQLError(error.message));
    // @ts-expect-error: a mapped error may be a plain GraphQLError, not a TaggedError.
    const topTag: "tagged" | undefined = mapped.errors?.[0]?.tag;
    // @ts-expect-error: the same holds inside an incremental entry.
    const entryTag: "tagged" | undefined = mapped.incremental[0]?.errors?.[0]?.tag;
    const label: "L" | undefined = mapped.incremental[0]?.label;
    const trace: string | undefined = mapped.extensions?.trace;
    expect([topTag, entryTag, label, trace]).toEqual([undefined, undefined, "L", "t"]);
  });
});
