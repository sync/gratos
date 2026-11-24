// Type-level contract of createServer (checked by `tsc`): a server whose context type excludes
// `undefined` must have a context factory, so no plugin is handed an `undefined` it does not
// expect; the default server, and one whose context may be `undefined`, need none.
import { describe, expect, it } from "vitest";

import { createServer } from "../src/index.ts";
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
