// One trace per request, on the example's own wiring over real HTTP (docs/plan.html F6): the app
// is served by test/support/serve.ts with an in-memory tracer in appLayer's `tracing`, the place
// src/server.ts gives the OTLP one. A query keeps one trace id from the HTTP span down to the
// backend's spans; a mutation does too; an SSE subscription's operation span ends after its last
// event; and no span is left open once the server has closed. Every wait is bounded.
import { afterEach, describe, expect, it } from "vitest";

import { AUTHORIZATION, until } from "./support/app.ts";
import { serve } from "./support/serve.ts";
import type { Served } from "./support/serve.ts";
import { recordingTracer } from "./support/tracer.ts";
import type { RecordedSpan, RecordingTracer } from "./support/tracer.ts";

/** How long any request of these tests may take, its response body included. */
const DEADLINE_MS = 10_000;

const opened: Array<Served> = [];

afterEach(async () => {
  for (const served of opened.splice(0)) {
    await served.close();
  }
});

const start = async (): Promise<{ served: Served; tracer: RecordingTracer }> => {
  const tracer = recordingTracer();
  const served = await serve({ tracing: tracer.layer });
  opened.push(served);
  return { served, tracer };
};

const post = (
  url: string,
  query: string,
  options: { readonly accept?: string; readonly signal?: AbortSignal } = {},
) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: options.accept ?? "application/graphql-response+json",
      authorization: AUTHORIZATION,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.any([
      AbortSignal.timeout(DEADLINE_MS),
      ...(options.signal === undefined ? [] : [options.signal]),
    ]),
  });

/** Resolves once no recorded span is open. */
const allEnded = (tracer: RecordingTracer) =>
  until(async () => (tracer.open().length === 0 ? true : undefined), {
    timeoutMs: 2000,
    message: `spans still open: ${tracer
      .open()
      .map((span) => span.name)
      .join(", ")}`,
  });

/** Asserts that `child` is a child span of `parent`: both exist, on one trace. */
const expectChildOf = (child: RecordedSpan | undefined, parent: RecordedSpan | undefined) => {
  expect(child, "the child span").toBeDefined();
  expect(parent, "the parent span").toBeDefined();
  expect(child?.parentId).toBe(parent?.spanId);
  expect(child?.traceId).toBe(parent?.traceId);
};

/** The one span named `name`. */
const only = (tracer: RecordingTracer, name: string): RecordedSpan | undefined => {
  const spans = tracer.named(name);
  expect(spans.map((span) => span.name)).toEqual([name]);
  return spans[0];
};

/** The SSE events of a subscription's body, read on demand. */
const sseReader = (response: Response) => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("the subscription has no body");
  }
  const decoder = new TextDecoder();
  let text = "";
  const nextEvents = () =>
    text
      .split("\n\n")
      .slice(0, -1)
      .filter((frame) => frame.startsWith("event: next\n"))
      .map((frame) => frame.slice(frame.indexOf("data: ") + 6));
  return {
    /** Reads until `count` `next` events have arrived, and returns their data. */
    read: async (count: number): Promise<Array<string>> => {
      while (nextEvents().length < count) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`the subscription ended after ${nextEvents().length} events`);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return nextEvents();
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
};

describe("the orders app's trace, over HTTP", () => {
  it("keeps one trace id for a query: HTTP, operation, phases, resolvers, backend, session read", async () => {
    const { served, tracer } = await start();
    const response = await post(
      served.url,
      'query Trace { order(id: "o-1") { id customer { name } } }',
    );
    expect(await response.json()).toEqual({
      data: { order: { id: "o-1", customer: { name: "Ada" } } },
    });
    await allEnded(tracer);

    expect(new Set(tracer.spans.map((span) => span.traceId)).size).toBe(1);
    const http = only(tracer, "POST");
    const operation = only(tracer, "graphql Trace");
    const session = only(tracer, "session.read");
    const order = only(tracer, "resolve Query.order");
    const customer = only(tracer, "resolve Order.customer");
    expect(http?.parentId).toBeUndefined();
    expectChildOf(operation, http);
    // The context factory's runInRequest: beside the operation span, under the HTTP span.
    expectChildOf(session, http);
    expectChildOf(only(tracer, "parse"), operation);
    expectChildOf(only(tracer, "validate"), operation);
    expectChildOf(order, operation);
    expectChildOf(customer, operation);
    expectChildOf(only(tracer, "rpc order_get"), order);
    // The session's user lookup (the context is built before any resolver runs), then the
    // customer's.
    const users = tracer.named("rpc user_get");
    expect(users.map((span) => span.parentId)).toEqual([session?.spanId, customer?.spanId]);
    expect(tracer.spans.every((span) => span.endCalls === 1)).toBe(true);
    expect(operation?.outcome).toBe("ok");
  });

  it("keeps one trace id for a mutation", async () => {
    const { served, tracer } = await start();
    const response = await post(
      served.url,
      'mutation Cancel { cancelOrder(id: "o-1") { id status } }',
    );
    expect(await response.json()).toEqual({
      data: { cancelOrder: { id: "o-1", status: "cancelled" } },
    });
    await allEnded(tracer);

    expect(new Set(tracer.spans.map((span) => span.traceId)).size).toBe(1);
    const operation = only(tracer, "graphql Cancel");
    const resolver = only(tracer, "resolve Mutation.cancelOrder");
    expectChildOf(operation, only(tracer, "POST"));
    expectChildOf(resolver, operation);
    expectChildOf(only(tracer, "rpc order_cancel"), resolver);
    expect(operation?.attributes.get("graphql.operation.type")).toBe("mutation");
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("ok");
  });

  it("ends an SSE subscription's operation span after its last event", async () => {
    const { served, tracer } = await start();
    const client = new AbortController();
    const response = await post(
      served.url,
      'subscription Watch { orderChanged(id: "o-1") { id status customer { name } } }',
      { accept: "text/event-stream", signal: client.signal },
    );
    expect(response.status).toBe(200);
    const events = sseReader(response);
    // The first event is the order now: the source has subscribed to the bus.
    await events.read(1);
    const change = await post(served.url, 'mutation { cancelOrder(id: "o-1") { id } }');
    expect(await change.json()).toEqual({ data: { cancelOrder: { id: "o-1" } } });
    const data = await events.read(2);
    expect(data[1]).toContain('"status":"cancelled"');

    const operation = only(tracer, "graphql Watch");
    // The last event has arrived, and the subscription is still open.
    expect(operation?.ended).toBe(false);
    client.abort();
    await events.cancel();
    await allEnded(tracer);

    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("cancel");
    // Its own request's HTTP span (the mutation that changed the order has another).
    const http = tracer.named("POST").find((span) => span.spanId === operation?.parentId);
    expectChildOf(operation, http);
    const below = operation === undefined ? [] : tracer.descendantsOf(operation);
    // Every span below it, the last event's resolvers included, ended before it.
    // The source's setup reads the order once; each event resolves its customer.
    expect(below.filter((span) => span.name === "rpc order_get")).toHaveLength(1);
    expect(below.filter((span) => span.name === "resolve Order.customer")).toHaveLength(2);
    for (const span of below) {
      expect(span.endTime ?? 0n, span.name).toBeLessThanOrEqual(operation?.endTime ?? -1n);
    }
    expect(new Set([operation, ...below].map((span) => span?.traceId)).size).toBe(1);
  });

  it("leaves no span open once the server has closed, an open subscription included", async () => {
    const { served, tracer } = await start();
    const response = await post(
      served.url,
      'subscription Open { orderChanged(id: "o-2") { id status } }',
      { accept: "text/event-stream" },
    );
    const events = sseReader(response);
    await events.read(1);
    const query = await post(served.url, '{ orders(userId: "u-1") { id } }');
    expect(response.status).toBe(200);
    expect(query.status).toBe(200);
    await query.text();
    expect(only(tracer, "graphql Open")?.ended).toBe(false);

    await served.close();
    await events.cancel();

    expect(tracer.open().map((span) => span.name)).toEqual([]);
    expect(tracer.spans.every((span) => span.endCalls === 1)).toBe(true);
    expect(only(tracer, "graphql Open")?.outcome).toBe("cancel");
  });
});
