// The subscription-throughput bench (bench/subscriptions.ts) still runs: each variant delivers
// every event, in both modes, through the app's own server. Its numbers are not checked here (a
// shared CI runner is too noisy for them); `pnpm bench:subscriptions` reports them. Its waits are
// checked here too: a body that fails or ends, or an event that never comes, stops the run with an
// error instead of a hang, and the body is cancelled on every path.
import { describe, expect, it, vi } from "vitest";

import { countEvents, measure, openSubscription, plainQueue } from "../bench/subscriptions.ts";
import type { OrderRow } from "../src/services/Api.ts";

const encoder = new TextEncoder();

/** One SSE `next` event with an order of `status`, as the server writes it. */
const frame = (status: string) =>
  `event: next\ndata: {"data":{"orderChanged":{"id":"o-1","status":"${status}"}}}\n\n`;

/** One SSE `next` event with an order of `status`, as the bench reads it. */
const event = (status: string) => encoder.encode(frame(status));

/** An order row with `id`. */
const row = (id: string): OrderRow => ({
  id,
  total: 1,
  status: "open",
  customer_id: "u-1",
  revision: 1,
});

describe("bench:subscriptions", () => {
  it.each([
    ["effect", "burst"],
    ["plain", "burst"],
    ["effect", "paced"],
    ["plain", "paced"],
  ] as const)("delivers every event (%s source, %s)", async (variant, mode) => {
    const run = await measure(variant, mode, 50, { timeoutMs: 10_000 });
    expect(run).toMatchObject({ variant, mode, events: 50 });
    expect(run.eventsPerSecond).toBeGreaterThan(0);
  });

  it("stops waiting when the body fails, with the failure as the cause", async () => {
    const boom = new Error("boom");
    let pulls = 0;
    const counter = countEvents(
      new ReadableStream<Uint8Array>({
        pull: (controller) => {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(event("measured"));
          } else {
            controller.error(boom);
          }
        },
      }),
    );
    const far = performance.now() + 60_000;

    const error = await counter
      .waitFor(() => counter.counts.measured >= 2, far, "waiting for event 2")
      .then(
        () => undefined,
        (error_: unknown) => error_,
      );

    expect(error).toMatchObject({
      message: "the subscription failed waiting for event 2 (warm-up 0, measured 1)",
      cause: boom,
    });
    await counter.close();
  });

  it("stops waiting at the deadline when an event never comes, and cancels the body", async () => {
    let cancelled = false;
    const counter = countEvents(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(event("warm-up"));
        },
        cancel: () => {
          cancelled = true;
        },
      }),
    );

    const error = await counter
      .waitFor(() => counter.counts.measured >= 1, performance.now() + 50, "waiting for event 1")
      .then(
        () => undefined,
        (error_: unknown) => error_,
      );

    expect(error).toMatchObject({
      message: "timed out waiting for event 1 (warm-up 1, measured 0)",
    });
    await counter.close();
    expect(cancelled).toBe(true);
  });

  it("counts each event once, however the body is split into chunks", async () => {
    // Split right after each marker, inside the next event's marker, and between the blank lines
    // that end a frame: an event is counted when its frame is complete, once.
    const text = ["warm-up", "measured", "warm-up", "measured"].map(frame).join("");
    const cuts = [
      text.indexOf('"warm-up"') + '"warm-up"'.length,
      text.indexOf('"measured"') + 4,
      text.indexOf('"measured"') + '"measured"'.length,
      text.indexOf("\n\n", text.lastIndexOf("warm-up")) + 1,
    ];
    const bounds = [0, ...cuts, text.length];
    const chunks = bounds
      .slice(1)
      .map((end, index) => encoder.encode(text.slice(bounds[index], end)));
    const counter = countEvents(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
    );

    const error = await counter
      .waitFor(() => false, performance.now() + 10_000, "reading every chunk")
      .then(
        () => undefined,
        (error_: unknown) => error_,
      );

    expect(error).toMatchObject({
      message: "the subscription ended reading every chunk (warm-up 2, measured 2)",
    });
    expect(counter.counts).toEqual({ warmUp: 2, measured: 2 });
    await counter.close();
  });

  it("aborts the request when the subscription does not answer in time, and cancels a late body", async () => {
    let sent: Request | undefined;
    const late = Promise.withResolvers<Response>();
    let published = 0;

    const error = await openSubscription(
      (request) => {
        sent = request;
        return late.promise;
      },
      () => {
        published += 1;
      },
      performance.now() + 50,
    ).then(
      () => undefined,
      (error_: unknown) => error_,
    );

    expect(error).toMatchObject({ message: "timed out waiting for the subscription to answer" });
    expect(published).toBeGreaterThan(0);
    // The client left: the server sees the request aborted.
    expect(sent?.signal.aborted).toBe(true);
    // A response that comes anyway has its body cancelled: none of its events is read.
    let cancelled = false;
    late.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(event("warm-up"));
          },
          cancel: () => {
            cancelled = true;
          },
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(cancelled).toBe(true);
    });
  });

  it("the plain source is a FIFO, also across a drained queue", async () => {
    const { iterator, push } = plainQueue();
    push(row("a"));
    push(row("b"));
    const first = await iterator.next();
    push(row("c"));
    const rest = [await iterator.next(), await iterator.next()];
    const waiting = iterator.next();
    push(row("d"));

    expect(
      [first, ...rest, await waiting].map((result) =>
        result.done === true ? "done" : result.value.id,
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });
});
