// The GraphQL-over-HTTP matrix of the JSON path (docs/plan.html M4a, "HTTP matrix"): one test
// per row.
import { describe, expect, it } from "vitest";

import { createServer, gqlError, httpStatusOf } from "../src/index.ts";
import { gql, post, send, URL_ } from "./support/http.ts";
import { basicSchema } from "./support/schema.ts";

const GRJ = "application/graphql-response+json; charset=utf-8";
const JSON_ = "application/json; charset=utf-8";

const server = createServer({ schema: basicSchema() });

describe("method", () => {
  it.each(["GET", "HEAD"])("%s gets 405, Allow: POST and a null body", async (method) => {
    const response = await server.handle(new Request(`${URL_}?query={count}`, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.body).toBeNull();
  });

  it("any other method gets 405 too", async () => {
    const response = await server.handle(new Request(URL_, { method: "PUT", body: "{}" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("400: not JSON, not a request, no query", () => {
  it("a body that is not JSON", async () => {
    const sent = await send(server, post("{not json"));
    expect(sent.status).toBe(400);
    expect(sent.error?.message).toBe("The request body is not valid JSON.");
  });

  it.each([
    ["an array body", [{ query: "{count}" }], "The request body must be a JSON object."],
    ["a non-string query", { query: 1 }, "`query` must be a string."],
    ["non-object variables", { query: "{count}", variables: [] }, "`variables` must be an object."],
    [
      "a non-string operationName",
      { query: "{count}", operationName: 2 },
      "`operationName` must be a string.",
    ],
    [
      "non-object extensions",
      { query: "{count}", extensions: "x" },
      "`extensions` must be an object.",
    ],
    ["no query", { variables: {} }, "Must provide a query string."],
    ["an empty query", { query: "" }, "Must provide a query string."],
  ])("%s", async (_name, body, message) => {
    const sent = await send(server, post(body));
    expect(sent.status).toBe(400);
    expect(sent.headers.get("content-type")).toBe(GRJ);
    expect(sent.body).toEqual({ errors: [{ message }] });
  });

  it("is a 400 under application/json too (not a well-formed request)", async () => {
    const sent = await send(server, post({ variables: {} }, { accept: "application/json" }));
    expect(sent.status).toBe(400);
    expect(sent.headers.get("content-type")).toBe(JSON_);
  });
});

describe("415: unsupported Content-Type", () => {
  it.each([["text/plain"], ["application/x-www-form-urlencoded"], [null]])(
    "%s",
    async (contentType) => {
      const sent = await send(server, post({ query: "{count}" }, { contentType }));
      expect(sent.status).toBe(415);
      expect(sent.error?.message).toBe("Content-Type must be application/json.");
    },
  );

  it("accepts application/json with parameters", async () => {
    const sent = await send(
      server,
      post({ query: "{count}" }, { contentType: "application/json; charset=utf-8" }),
    );
    expect(sent.status).toBe(200);
  });
});

describe("406: unsupported Accept", () => {
  it.each([
    ["text/html"],
    ["application/xml, text/*"],
    ["application/json;q=0"],
    ["application/json; charset=utf-16"],
    ['application/graphql-response+json;charset="iso-8859-1", */*;charset=utf-16'],
    // The charset is read wherever `q` sits.
    ["application/graphql-response+json;q=1;charset=utf-16"],
    ["application/json;q=0.5;charset=utf-16"],
    // A range with a parameter the core never sends cannot accept its representations.
    ['application/json;profile="special"'],
  ])("%s", async (accept) => {
    const sent = await send(server, post({ query: "{count}" }, { accept }));
    expect(sent.status).toBe(406);
    expect(sent.headers.get("content-type")).toBe(JSON_);
  });
});

describe("Accept negotiation", () => {
  it.each([
    [null, GRJ],
    ["*/*", GRJ],
    ["application/*", GRJ],
    ["application/graphql-response+json", GRJ],
    ["application/json", JSON_],
    ["application/json, application/graphql-response+json", GRJ],
    ["application/graphql-response+json;q=0.5, application/json", JSON_],
    ["application/json, */*;q=0.1", JSON_],
    ["application/json; charset=utf-8", JSON_],
    ['application/json;charset="UTF-8"', JSON_],
    ["application/graphql-response+json; charset=utf-16, application/json;q=0.5", JSON_],
    ["application/json;charset=utf-16, application/*;q=0.2", GRJ],
    ["application/json;charset=utf-8;q=0.4, application/json;q=0, */*;q=0.3", JSON_],
    ["application/json;q=0.4;charset=utf-8, application/json;q=0, */*;q=0.3", JSON_],
    // A range with a parameter the core never sends does not match, so its q=0 refuses nothing.
    [
      'application/graphql-response+json, application/graphql-response+json;profile="special";q=0',
      GRJ,
    ],
    // A comma or semicolon inside a quoted parameter value stays in its range.
    ['application/json;profile="legacy, application/json;q=0, current", application/json', JSON_],
    [String.raw`application/json;profile="a\"b, application/json;q=0", application/json`, JSON_],
  ])("%s gives %s", async (accept, contentType) => {
    const sent = await send(server, post({ query: "{count}" }, { accept }));
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toBe(contentType);
  });
});

describe("application/graphql-response+json (the default)", () => {
  it("a parse error is a 400", async () => {
    const sent = await gql(server, "{ count");
    expect(sent.status).toBe(400);
    expect(sent.body?.data).toBeUndefined();
    expect(sent.error?.message).toMatch(/^Syntax Error/);
  });

  it("a validation error is a 400", async () => {
    const sent = await gql(server, "{ nope }");
    expect(sent.status).toBe(400);
    expect(sent.error?.message).toMatch(/Cannot query field "nope"/);
  });

  it("a variable error is a 400", async () => {
    const sent = await gql(server, "query ($v: Int!) { n(value: $v) }", {
      variables: { v: "abc" },
    });
    expect(sent.status).toBe(400);
    expect(sent.body?.data).toBeUndefined();
    expect(sent.body?.errors).toHaveLength(1);
  });

  it("an unknown operation name is a 400", async () => {
    const sent = await gql(server, "query A { count }", { operationName: "B" });
    expect(sent.status).toBe(400);
    expect(sent.error?.message).toBe('Unknown operation named "B".');
  });

  it("non-null data is a 200, with field errors", async () => {
    const sent = await gql(server, "{ count fails }");
    expect(sent.status).toBe(200);
    expect(sent.body?.data).toEqual({ count: 1, fails: null });
    expect(sent.error?.path).toEqual(["fails"]);
  });

  it("null data (a non-null root field failed) is a 200", async () => {
    const sent = await gql(server, "{ failsNonNull }");
    expect(sent.status).toBe(200);
    expect(sent.body?.data).toBeNull();
  });
});

describe("application/json", () => {
  const accept = "application/json";

  it.each([
    ["a parse error", "{ count", undefined],
    ["a validation error", "{ nope }", undefined],
    ["a variable error", "query ($v: Int!) { n(value: $v) }", { v: "abc" }],
    ["a success", "{ count }", undefined],
  ])("%s is a 200", async (_name, query, variables) => {
    const sent = await gql(server, query, { accept, variables });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toBe(JSON_);
  });
});

describe("gqlError(message, status)", () => {
  const withStatus = createServer({
    schema: basicSchema({
      Query: {
        failsNonNull: () => {
          throw gqlError("Not signed in", 401);
        },
        fails: () => {
          throw gqlError("Forbidden", 403);
        },
      },
    }),
  });

  it("puts the status in extensions.http.status", () => {
    expect(gqlError("Nope", 418).extensions).toEqual({ http: { status: 418 } });
    expect(gqlError("Nope", 418, { code: "TEAPOT" }).extensions).toEqual({
      code: "TEAPOT",
      http: { status: 418 },
    });
  });

  it("sets the HTTP status when data is null", async () => {
    const sent = await gql(withStatus, "{ failsNonNull }");
    expect(sent.status).toBe(401);
    expect(sent.body?.data).toBeNull();
    expect(sent.error?.extensions).toEqual({ http: { status: 401 } });
  });

  it("sets it under application/json too", async () => {
    const sent = await gql(withStatus, "{ failsNonNull }", { accept: "application/json" });
    expect(sent.status).toBe(401);
  });

  it("leaves the status alone when there is data", async () => {
    const sent = await gql(withStatus, "{ count fails }");
    expect(sent.status).toBe(200);
    expect(sent.body?.data).toEqual({ count: 1, fails: null });
  });

  it("ignores a status that cannot carry a JSON body, or is not 200–599", () => {
    for (const status of [204, 205, 304, 100, 199, 600, 200.5]) {
      expect(httpStatusOf(gqlError("Nope", status))).toBeUndefined();
    }
    for (const status of [200, 401, 403, 418, 503, 599]) {
      expect(httpStatusOf(gqlError("Nope", status))).toBe(status);
    }
  });

  it.each([204, 205, 304])(
    "a %s gqlError keeps the GraphQL error and gets the fallback status, not a 500",
    async (status) => {
      const bodiless = createServer({
        schema: basicSchema({
          Query: {
            failsNonNull: () => {
              throw gqlError("No body allowed", status);
            },
          },
        }),
      });
      const sent = await gql(bodiless, "{ failsNonNull }");
      expect(sent.status).toBe(200);
      expect(sent.body?.data).toBeNull();
      expect(sent.error?.message).toBe("No body allowed");
    },
  );
});
