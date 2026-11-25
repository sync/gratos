// End to end over real HTTP (docs/plan.html M7): the app's own wiring on NodeHttpServer (a port
// the OS picks), driven by Apollo Client (the catalog pins it) for the query, the mutation, @defer
// and @stream, and by fetch for the SSE subscription (Apollo's HttpLink speaks multipart
// subscriptions, not SSE). Apollo gets Defer20220824Handler explicitly, the incremental format the
// server speaks. Every wait is bounded; nothing depends on timing.
import { setTimeout as sleep } from "node:timers/promises";

import { ApolloClient, gql, HttpLink, InMemoryCache } from "@apollo/client";
import { Defer20220824Handler } from "@apollo/client/incremental";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { PersistedQueryLink } from "@apollo/client/link/persisted-queries";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUTHORIZATION, until } from "./support/app.ts";
import { serve } from "./support/serve.ts";
import type { Served } from "./support/serve.ts";

/** One response Apollo read: what the server sent, recorded beside Apollo's own reading. */
interface Exchange {
  readonly request: unknown;
  readonly status: number;
  readonly contentType: string | null;
  readonly serverTiming: string | null;
  /** The whole body, once the server has sent it. */
  readonly body: Promise<string>;
}

/** A fetch that records each exchange, handing Apollo an untouched copy of the response. */
const recordingFetch = (exchanges: Array<Exchange>): typeof fetch => {
  const recorded: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const [mine, theirs] = response.body === null ? [null, null] : response.body.tee();
    exchanges.push({
      request: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      status: response.status,
      contentType: response.headers.get("content-type"),
      serverTiming: response.headers.get("server-timing"),
      body: mine === null ? Promise.resolve("") : new Response(mine).text(),
    });
    return new Response(theirs, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return recorded;
};

/** The hash Apollo's PersistedQueryLink sends (APQ: hex SHA-256 of the query text). */
const sha256 = async (query: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query))).toString(
    "hex",
  );

interface Client {
  readonly apollo: ApolloClient;
  readonly exchanges: Array<Exchange>;
}

const client = (
  options: { readonly guest?: boolean; readonly persisted?: boolean } = {},
): Client => {
  const exchanges: Array<Exchange> = [];
  const http = new HttpLink({
    uri: served.url,
    fetch: recordingFetch(exchanges),
    headers: options.guest === true ? {} : { authorization: AUTHORIZATION },
  });
  return {
    apollo: new ApolloClient({
      link: options.persisted === true ? new PersistedQueryLink({ sha256 }).concat(http) : http,
      cache: new InMemoryCache(),
      incrementalHandler: new Defer20220824Handler(),
    }),
    exchanges,
  };
};

let served: Served;

beforeAll(async () => {
  served = await serve();
});

afterAll(async () => {
  await served.close();
});

/** JSON text, decoded. */
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** The parts of a multipart/mixed; deferSpec=20220824 body, parsed. */
const multipartParts = (body: string): Array<Schema.Json> =>
  body
    .split("\r\n---")
    .map((part) => part.split("\r\n\r\n")[1])
    .filter((json): json is string => json !== undefined && json.trim() !== "")
    .map((json) => parseJson(json));

describe("the orders app over HTTP, with Apollo Client", () => {
  it("answers a query", async () => {
    const { apollo, exchanges } = client();
    const result = await apollo.query({
      query: gql`
        query Orders($userId: ID!) {
          orders(userId: $userId) {
            id
            total
            customer {
              name
            }
          }
        }
      `,
      variables: { userId: "u-1" },
    });

    expect(result.data).toEqual({
      orders: [
        {
          __typename: "Order",
          id: "o-3",
          total: 7.25,
          customer: { __typename: "User", name: "Ada" },
        },
        {
          __typename: "Order",
          id: "o-2",
          total: 18,
          customer: { __typename: "User", name: "Ada" },
        },
        {
          __typename: "Order",
          id: "o-1",
          total: 42.5,
          customer: { __typename: "User", name: "Ada" },
        },
      ],
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.status).toBe(200);
    expect(exchanges[0]?.contentType).toBe("application/graphql-response+json; charset=utf-8");
    // serverTiming() ran: the plugins are the app's.
    expect(exchanges[0]?.serverTiming).toMatch(/(^|, )total;dur=\d+(\.\d+)?$/);
  });

  it("runs a mutation", async () => {
    const { apollo } = client();
    const result = await apollo.mutate({
      mutation: gql`
        mutation Cancel($id: ID!) {
          cancelOrder(id: $id) {
            id
            status
          }
        }
      `,
      variables: { id: "o-4" },
    });

    expect(result.data).toEqual({
      cancelOrder: { __typename: "Order", id: "o-4", status: "cancelled" },
    });
    const after = await apollo.query({
      query: gql`
        {
          order(id: "o-4") {
            id
            status
          }
        }
      `,
      fetchPolicy: "network-only",
    });
    expect(after.data).toEqual({ order: { __typename: "Order", id: "o-4", status: "cancelled" } });
  });

  it("refuses a guest with the app's Forbidden, and maps NotFound", async () => {
    const guest = client({ guest: true });
    const refused = await guest.apollo
      .query({
        query: gql`
          {
            user(id: "u-1") {
              name
            }
          }
        `,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(CombinedGraphQLErrors.is(refused)).toBe(true);
    expect(CombinedGraphQLErrors.is(refused) ? refused.errors : []).toEqual([
      expect.objectContaining({
        message: "Forbidden",
        path: ["user"],
        extensions: { code: "FORBIDDEN", http: { status: 403 } },
      }),
    ]);

    const { apollo } = client();
    const missing = await apollo
      .query({
        query: gql`
          {
            user(id: "nope") {
              name
            }
          }
        `,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(CombinedGraphQLErrors.is(missing) ? missing.errors : []).toEqual([
      expect.objectContaining({ message: "user not found", extensions: expect.anything() }),
    ]);
  });

  it("answers persisted queries (apq) by hash once registered", async () => {
    const { apollo, exchanges } = client({ persisted: true });
    const query = gql`
      {
        user(id: "u-2") {
          name
        }
      }
    `;
    const first = await apollo.query({ query, fetchPolicy: "network-only" });
    const second = await apollo.query({ query, fetchPolicy: "network-only" });

    expect(first.data).toEqual({ user: { __typename: "User", name: "Grace" } });
    expect(second.data).toEqual(first.data);
    // The hash alone, not found; the hash and the query; then the hash alone, found.
    expect(exchanges.map((exchange) => exchange.request)).toEqual([
      expect.not.objectContaining({ query: expect.anything() }),
      expect.objectContaining({ query: expect.any(String) }),
      expect.not.objectContaining({ query: expect.anything() }),
    ]);
    expect(await exchanges[0]?.body).toContain("PERSISTED_QUERY_NOT_FOUND");
  });

  it("delivers @defer as multipart, which Apollo merges", async () => {
    const { apollo, exchanges } = client();
    const result = await apollo.query({
      query: gql`
        {
          order(id: "o-1") {
            id
            ... @defer {
              customer {
                name
              }
            }
          }
        }
      `,
    });

    expect(result.data).toEqual({
      order: {
        __typename: "Order",
        id: "o-1",
        customer: { __typename: "User", name: "Ada" },
      },
    });
    expect(exchanges[0]?.contentType).toBe('multipart/mixed; boundary="-"; deferSpec=20220824');
    const parts = multipartParts((await exchanges[0]?.body) ?? "");
    expect(parts).toEqual([
      { data: { order: { id: "o-1", __typename: "Order" } }, hasNext: true },
      {
        incremental: [
          {
            data: { customer: { name: "Ada", __typename: "User" }, __typename: "Order" },
            path: ["order"],
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it('delivers @stream as multipart, which Apollo merges with fetchPolicy "no-cache"', async () => {
    const { apollo, exchanges } = client();
    const result = await apollo.query({
      query: gql`
        {
          orders(userId: "u-1") @stream(initialCount: 1) {
            id
          }
        }
      `,
      fetchPolicy: "no-cache",
    });

    expect(result.data).toEqual({
      orders: [
        { __typename: "Order", id: "o-3" },
        { __typename: "Order", id: "o-2" },
        { __typename: "Order", id: "o-1" },
      ],
    });
    expect(exchanges[0]?.contentType).toBe('multipart/mixed; boundary="-"; deferSpec=20220824');
    const parts = multipartParts((await exchanges[0]?.body) ?? "");
    expect(parts[0]).toEqual({
      data: { orders: [{ id: "o-3", __typename: "Order" }] },
      hasNext: true,
    });
    expect(parts.length).toBeGreaterThan(1);
  });

  it("with the cache (the default policy), the pinned Apollo also keeps the whole list", async () => {
    // The plan's reason for "no-cache" above is Apollo 4.1.0's changelog (#13078: with
    // Defer20220824Handler the default merge truncates a streamed array to its first chunk). For
    // a streamed root list it does not happen on the pinned 4.3.8 (nor on 4.1.9): this records
    // that. If it starts failing, Apollo truncates again, and "no-cache" is required.
    const { apollo } = client();
    const result = await apollo.query({
      query: gql`
        {
          orders(userId: "u-1") @stream(initialCount: 1) {
            id
          }
        }
      `,
    });

    expect(result.data).toEqual({
      orders: [
        { __typename: "Order", id: "o-3" },
        { __typename: "Order", id: "o-2" },
        { __typename: "Order", id: "o-1" },
      ],
    });
  });
});

/** POSTs a GraphQL request with the session. */
const post = (query: string, accept = "application/graphql-response+json") =>
  fetch(served.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept, authorization: AUTHORIZATION },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  });

describe("the orders app over HTTP, SSE subscriptions", () => {
  it("streams each change to the order as an SSE event", async () => {
    const subscription = post(
      'subscription { orderChanged(id: "o-2") { id status } }',
      "text/event-stream",
    );
    const cancel = 'mutation { cancelOrder(id: "o-2") { status } }';
    // The core answers with the first event, and the subscription starts once the request is
    // read: cancel until its first event has come.
    const response = await until(
      async () => {
        expect((await post(cancel)).status).toBe(200);
        return Promise.race([subscription, sleep(20, undefined)]);
      },
      { timeoutMs: 10_000, message: "the subscription never answered" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("the subscription has no body");
    }
    const decoder = new TextDecoder();
    let text = "";
    /** The `data` of every complete `next` event read so far. */
    const events = () =>
      text
        .split("\n\n")
        .slice(0, -1)
        .filter((frame) => frame.startsWith("event: next\n"))
        .map((frame) => parseJson(frame.slice(frame.indexOf("data: ") + 6)));
    const readEvents = async (count: number) => {
      while (events().length < count) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`the subscription ended after ${events().length} events`);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    };

    await readEvents(1);
    // Two more changes, two more events.
    await post(cancel);
    await post(cancel);
    await readEvents(3);
    expect(events().slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => ({
        data: { orderChanged: { id: "o-2", status: "cancelled" } },
      })),
    );
    await reader.cancel();

    // The server goes on answering after the client left.
    expect((await post('{ order(id: "o-2") { status } }')).status).toBe(200);
  });

  it("refuses a guest's subscription with one error event, then complete", async () => {
    const response = await fetch(served.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ query: 'subscription { orderChanged(id: "o-1") { id } }' }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    expect(text).toContain('"message":"Forbidden"');
    expect(text.trimEnd().endsWith("event: complete\ndata:")).toBe(true);
  });
});

describe("the orders app over HTTP, the plugins", () => {
  it("caches the parsed document, and compiles it with graphql-jit on its third use", async () => {
    // A query text no other test sends, so its first use is a cache miss.
    const query = '{ jitProbe: order(id: "o-3") { id total customer { id name } } }';
    const send = async () => {
      const response = await post(query);
      /** The phase names serverTiming() reported, without `total`. */
      const phases = (response.headers.get("server-timing") ?? "")
        .split(", ")
        .map((entry) => entry.split(";")[0])
        .filter((name) => name !== "total");
      const body: unknown = await response.json();
      return { phases, body };
    };

    const first = await send();
    const second = await send();
    const third = await send();
    const fourth = await send();

    expect([first.phases, second.phases, third.phases, fourth.phases]).toEqual([
      ["parse", "validate"],
      [],
      ["jit"],
      [],
    ]);
    // The compiled query answers as graphql-js did.
    expect(third.body).toEqual(first.body);
    expect(fourth.body).toEqual(first.body);
    expect(first.body).toEqual({
      data: { jitProbe: { id: "o-3", total: 7.25, customer: { id: "u-1", name: "Ada" } } },
    });
  });
});
