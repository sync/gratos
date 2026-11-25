// The subscription-throughput bench (bench/subscriptions.ts) still runs: each variant delivers
// every event, in both modes, through the app's own server. Its numbers are not checked here (a
// shared CI runner is too noisy for them); `pnpm bench:subscriptions` reports them. Its waits are
// checked here too: a body that fails or ends, or an event that never comes, stops the run with an
// error instead of a hang, and the body is cancelled on every path.
import { describe, expect, it } from "vitest";

import { countEvents, measure, plainQueue } from "../bench/subscriptions.ts";
import type { OrderRow } from "../src/services/Api.ts";

const encoder = new TextEncoder();

/** One SSE `next` event with an order of `status`, as the bench reads it. */
const event = (status: string) =>
  encoder.encode(
    `event: next\ndata: {"data":{"orderChanged":{"id":"o-1","status":"${status}"}}}\n\n`,
  );

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
