// End to end over real HTTP (docs/plan.html M7): the app's own wiring on NodeHttpServer (a port
// the OS picks), driven by Apollo Client (the catalog pins it) for the query, the mutation, @defer
// and @stream, and by fetch for the SSE subscription (Apollo's HttpLink speaks multipart
// subscriptions, not SSE). Apollo gets Defer20220824Handler explicitly, the incremental format the
// server speaks. Every wait is bounded: each request (its body included) has a deadline, and every
// Apollo client and SSE reader is stopped when its test ends, passed or failed.
import { createServer } from "node:http";

import { ApolloClient, gql, HttpLink, InMemoryCache } from "@apollo/client";
import { Defer20220824Handler } from "@apollo/client/incremental";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { PersistedQueryLink } from "@apollo/client/link/persisted-queries";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import type { OrderRow } from "../src/services/Api.ts";
import { AUTHORIZATION } from "./support/app.ts";
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

/** How long any request of these tests may take, its response body included. */
const DEADLINE_MS = 10_000;

/** `inner`, with a deadline on every request (on top of the caller's own signal, if any). */
const withDeadline = (inner: typeof fetch): typeof fetch => {
  const bounded: typeof fetch = (input, init) => {
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return inner(input, { ...init, signal });
  };
  return bounded;
};

/** The global fetch, with the deadline. */
const boundedFetch = withDeadline(globalThis.fetch);

/** A fetch that records each exchange, handing Apollo an untouched copy of the response. */
const recordingFetch = (exchanges: Array<Exchange>): typeof fetch => {
  const recorded: typeof fetch = async (input, init) => {
    const response = await boundedFetch(input, init);
    const [mine, theirs] = response.body === null ? [null, null] : response.body.tee();
    const body = mine === null ? Promise.resolve("") : new Response(mine).text();
    // A body cut short rejects both copies. Apollo reports its own; this one is read only by the
    // tests that await it, so it is handled here (they still see it reject).
    body.catch(() => undefined);
    exchanges.push({
      request: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      status: response.status,
      contentType: response.headers.get("content-type"),
      serverTiming: response.headers.get("server-timing"),
      body,
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
  const apollo = new ApolloClient({
    link: options.persisted === true ? new PersistedQueryLink({ sha256 }).concat(http) : http,
    cache: new InMemoryCache(),
    incrementalHandler: new Defer20220824Handler(),
  });
  // Stops its queries when the test ends, also a failed one.
  onTestFinished(() => {
    apollo.stop();
  });
  return { apollo, exchanges };
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

    // Only an open order can be cancelled: o-2 has shipped.
    const refused = await apollo
      .mutate({
        mutation: gql`
          mutation {
            cancelOrder(id: "o-2") {
              status
            }
          }
        `,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(CombinedGraphQLErrors.is(refused) ? refused.errors : []).toEqual([
      expect.objectContaining({ message: "Forbidden", path: ["cancelOrder"] }),
    ]);
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

  it("the README's client signs in, and reads its @stream query whole", async () => {
    const uri = served.url;
    const userId = "u-1";
    // The README's code has no deadline of its own: give its fetch the tests' one.
    vi.stubGlobal("fetch", boundedFetch);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    // From here to the query's end, the README's code (its two `file=` blocks quote it), with
    // the client's cleanup registered between them: it stops when the test ends, also when its
    // query rejects.
    const client = new ApolloClient({
      link: new HttpLink({ uri, headers: { authorization: `Bearer ${userId}` } }),
      cache: new InMemoryCache(),
      incrementalHandler: new Defer20220824Handler(),
    });
    onTestFinished(() => {
      client.stop();
    });
    const result = await client.query({
      query: gql`
        query StreamedOrders($userId: ID!) {
          orders(userId: $userId) @stream(initialCount: 1) {
            id
            total
          }
        }
      `,
      variables: { userId },
      fetchPolicy: "no-cache",
    });

    // Signed in (a guest gets Forbidden and no data), the whole streamed list.
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({
      orders: [
        { __typename: "Order", id: "o-3", total: 7.25 },
        { __typename: "Order", id: "o-2", total: 18 },
        { __typename: "Order", id: "o-1", total: 42.5 },
      ],
    });
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

/** POSTs a GraphQL request with the session (and the deadline, its body included). */
const post = (query: string, accept = "application/graphql-response+json") =>
  boundedFetch(served.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept, authorization: AUTHORIZATION },
    body: JSON.stringify({ query }),
  });

/** An `orderChanged` event of o-3 with `status`. */
const o3Event = (status: string) => ({ data: { orderChanged: { id: "o-3", status } } });

/** A change the backend makes on its own: no mutation of the app refunds an order. */
const REFUNDED: OrderRow = {
  id: "o-3",
  total: 7.25,
  status: "refunded",
  customer_id: "u-1",
  revision: 3,
};

describe("the orders app over HTTP, SSE subscriptions", () => {
  it("streams the order, then each change to it, as SSE events", async () => {
    // The core answers with the first event: the order as it is when the subscription starts.
    const response = await post(
      'subscription { orderChanged(id: "o-3") { id status } }',
      "text/event-stream",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("the subscription has no body");
    }
    // The client leaves when the test ends, also a failed one (a second cancel is harmless).
    onTestFinished(() => reader.cancel());
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
    const cancel = async () => {
      const answer = await post('mutation { cancelOrder(id: "o-3") { status } }');
      expect(await answer.json()).toEqual({ data: { cancelOrder: { status: "cancelled" } } });
    };

    await readEvents(1);
    // The cancel publishes a change; its retry changes nothing and publishes nothing. A change the
    // backend makes on its own (no mutation does) comes next on the same topic: a republished
    // cancel would come before it.
    await cancel();
    await cancel();
    served.publish("orders.o-3", REFUNDED);
    await readEvents(3);
    expect(events()).toEqual([o3Event("open"), o3Event("cancelled"), o3Event("refunded")]);
    await reader.cancel();

    // The server goes on answering after the client left.
    expect((await post('{ order(id: "o-3") { status } }')).status).toBe(200);
  });

  it("refuses a guest's subscription with one error event, then complete", async () => {
    const response = await boundedFetch(served.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ query: 'subscription { orderChanged(id: "o-1") { id } }' }),
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

describe("the recording fetch", () => {
  it("leaves no rejection unhandled when a body is cut short", async () => {
    // A server that sends its headers and the start of a body, then drops the connection.
    const truncating = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":');
      setImmediate(() => response.socket?.destroy());
    });
    await new Promise<void>((resolve) => {
      truncating.listen(0, "127.0.0.1", resolve);
    });
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          truncating.close(() => resolve());
        }),
    );
    const address = truncating.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const unhandled: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", onUnhandled);
    });
    const exchanges: Array<Exchange> = [];

    // Apollo's copy rejects, and nothing reads the recorded one.
    const response = await recordingFetch(exchanges)(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: "{}",
    });
    await expect(response.text()).rejects.toThrow();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(unhandled).toEqual([]);
    // A test that reads the recorded body still sees it fail.
    await expect(exchanges[0]?.body).rejects.toThrow();
  });
});
