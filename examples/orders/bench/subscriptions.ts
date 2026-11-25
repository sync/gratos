// `pnpm --filter orders-example bench:subscriptions`: subscription throughput of the Effect
// layer's Stream sources (docs/plan.html M7, moved from M5; Risks: Stream.toAsyncIterableWith
// forks two fibers per pull).
//
// Both variants run the app's own server (makeServer: effectSchema, the context factory, every
// plugin) on `subscription { orderChanged(id: "o-1") { id status } }`, read as SSE through
// handle(), with no socket in between, so only the source path differs. The numbers compare two
// complete source paths, from a publish to an event in the body, not one mechanism in isolation:
// - "effect": the app's own path: Bus.publish into a PubSub, the topic's subscription (filtered
//   by topic, mapped to an Order) behind ctx.guardStream, each pull through effectSchema's
//   Stream.toAsyncIterableWith;
// - "plain": the same field with its subscribe replaced by a hand-written async iterator over an
//   in-memory FIFO (an indexed array: O(1) per push and pull), with no Effect, PubSub or guard.
// Each run warms up until an event has come through the SSE body, then times `events` events in
// one of two modes (see Mode). Every wait is bounded (`timeoutMs`), fails at once when the body
// ends or fails, and the body is cancelled on every path. `--record` writes the medians, with the
// runner class, to bench/subscriptions.json at the repo root (run `pnpm fmt` after). There is no
// spec target: the plan asks for the numbers, and for chunked pulls only if they are needed.
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { GraphQLFieldResolver } from "graphql";

import { getSchema } from "../src/generated/schema.ts";
import { makeServer } from "../src/graphql.ts";
import type { OrderRow } from "../src/services/Api.ts";
import { Bus } from "../src/services/Bus.ts";
import { FakeApi } from "../src/services/FakeApi.ts";

export type Variant = "effect" | "plain";

/**
 * "burst": publish every event at once, then read them all (throughput; the Stream pulls the
 * PubSub's backlog in chunks). "paced": publish one event and wait until it has been read before
 * the next (each event pays a whole pull, the case Stream.toAsyncIterableWith's per-pull fibers
 * cost most).
 */
export type Mode = "burst" | "paced";

export interface Run {
  readonly variant: Variant;
  readonly mode: Mode;
  readonly events: number;
  readonly ms: number;
  readonly eventsPerSecond: number;
  readonly microsPerEvent: number;
}

/** A warm-up event (some are published before the subscription listens, and are dropped). */
const WARM_UP: OrderRow = { id: "o-1", total: 42.5, status: "warm-up", customer_id: "u-1" };
/** A measured event: only these are counted. */
const MEASURED: OrderRow = { ...WARM_UP, status: "measured" };
const WARM_UP_MARKER = '"status":"warm-up"';
const MEASURED_MARKER = '"status":"measured"';

/** Resolves on the next turn of the event loop. */
const immediate = () =>
  new Promise<undefined>((resolve) => {
    setImmediate(() => resolve(undefined));
  });

/**
 * A plain async iterator over a FIFO queue: what a source without Effect looks like. The queue is
 * an array read from a moving index (Array.shift() would copy the backlog on every pull), and is
 * reset whenever it has been read to its end.
 */
export const plainQueue = () => {
  let buffer: Array<OrderRow> = [];
  let head = 0;
  let waiting: ((result: IteratorResult<OrderRow>) => void) | undefined;
  let done = false;
  const iterator: AsyncIterableIterator<OrderRow> = {
    next: () => {
      const row = buffer[head];
      if (row !== undefined) {
        head += 1;
        if (head === buffer.length) {
          buffer = [];
          head = 0;
        }
        return Promise.resolve({ value: row, done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    return: () => {
      done = true;
      waiting?.({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]: () => iterator,
  };
  const push = (row: OrderRow) => {
    if (waiting === undefined) {
      buffer.push(row);
    } else {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: row, done: false });
    }
  };
  return { iterator, push };
};

/** The events counted in an SSE body so far, and the waits on them. */
export interface EventCounter {
  readonly counts: { readonly warmUp: number; readonly measured: number };
  /** Throws when the body has ended or failed, or once `performance.now()` passes `deadline`. */
  readonly check: (deadline: number, what: string) => void;
  /**
   * Resolves once `done()` holds, checking at each turn of the event loop. Rejects as soon as the
   * body has ended or failed (with the failure as its cause), or once `performance.now()` passes
   * `deadline`: a missed event never leaves it waiting forever.
   */
  readonly waitFor: (done: () => boolean, deadline: number, what: string) => Promise<void>;
  /** Cancels the body and waits until its reads have stopped. Safe to call more than once. */
  readonly close: () => Promise<void>;
}

/** Reads `body` to its end, counting the warm-up and measured events in it. */
export const countEvents = (body: ReadableStream<Uint8Array>): EventCounter => {
  const reader = body.getReader();
  const counts = { warmUp: 0, measured: 0 };
  let ended = false;
  let failure: unknown;
  const pump = (async () => {
    const decoder = new TextDecoder();
    let tail = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          return;
        }
        // A marker may straddle two chunks: count in the tail of the last chunk plus this one
        // (the tail is shorter than any marker, so nothing is counted twice).
        const text = tail + decoder.decode(chunk.value, { stream: true });
        counts.warmUp += text.split(WARM_UP_MARKER).length - 1;
        counts.measured += text.split(MEASURED_MARKER).length - 1;
        tail = text.slice(-(MEASURED_MARKER.length - 1));
      }
    } catch (error) {
      failure = error;
    } finally {
      ended = true;
    }
  })();
  const check: EventCounter["check"] = (deadline, what) => {
    const seen = `warm-up ${counts.warmUp}, measured ${counts.measured}`;
    if (ended) {
      const how = failure === undefined ? "ended" : "failed";
      throw new Error(`the subscription ${how} ${what} (${seen})`, { cause: failure });
    }
    if (performance.now() > deadline) {
      throw new Error(`timed out ${what} (${seen})`);
    }
  };
  const waitFor: EventCounter["waitFor"] = async (done, deadline, what) => {
    while (!done()) {
      check(deadline, what);
      await immediate();
    }
  };
  const close = async () => {
    await reader.cancel().catch(() => undefined);
    await pump;
  };
  return { counts, check, waitFor, close };
};

const subscription = () =>
  new Request("http://localhost/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: "Bearer u-1",
    },
    body: JSON.stringify({ query: 'subscription { orderChanged(id: "o-1") { id status } }' }),
  });

/**
 * One run: `events` events through a fresh server and subscription, within `timeoutMs` (default
 * 60 s) from its start.
 */
export const measure = async (
  variant: Variant,
  mode: Mode,
  events: number,
  options: { readonly timeoutMs?: number } = {},
): Promise<Run> => {
  const deadline = performance.now() + (options.timeoutMs ?? 60_000);
  const scope = Effect.runSync(Scope.make());
  let counter: EventCounter | undefined;
  try {
    const services = await Effect.runPromise(Layer.buildWithScope(FakeApi.layer, scope));
    const schema = getSchema();
    let publish: (row: OrderRow) => void;
    if (variant === "plain") {
      const queue = plainQueue();
      const field = schema.getSubscriptionType()?.getFields()["orderChanged"];
      if (field === undefined) {
        throw new Error("the schema has no orderChanged subscription");
      }
      const subscribe: GraphQLFieldResolver<unknown, unknown> = () => queue.iterator;
      field.subscribe = subscribe;
      publish = (row) => {
        queue.push(row);
      };
    } else {
      const bus = Context.get(services, Bus);
      publish = (row) => {
        Effect.runSync(bus.publish("orders.o-1", row));
      };
    }
    const server = makeServer(schema, services, { report: () => {} });
    const pending = server.handle(subscription());
    // The response comes with the first event (the app's source sends the order as it is first;
    // the plain one, the first warm-up event). The bus drops what it publishes before the Stream
    // has subscribed: warm up until a warm-up event has come through the body, then publish the
    // measured ones.
    let response: Response | undefined;
    while (response === undefined) {
      if (performance.now() > deadline) {
        throw new Error("timed out waiting for the subscription to answer");
      }
      publish(WARM_UP);
      response = await Promise.race([pending, immediate()]);
    }
    if (response.body === null) {
      throw new Error("the subscription has no body");
    }
    counter = countEvents(response.body);
    const { counts, check, waitFor } = counter;
    while (counts.warmUp === 0) {
      check(deadline, "during the warm-up");
      publish(WARM_UP);
      await immediate();
    }

    /** Waits until `count` measured events have been read. */
    const readUntil = (count: number) =>
      waitFor(() => counts.measured >= count, deadline, `waiting for measured event ${count}`);
    const start = performance.now();
    if (mode === "burst") {
      for (let index = 0; index < events; index++) {
        publish(MEASURED);
      }
      await readUntil(events);
    } else {
      for (let index = 0; index < events; index++) {
        publish(MEASURED);
        await readUntil(index + 1);
      }
    }
    const ms = performance.now() - start;
    return {
      variant,
      mode,
      events,
      ms: Math.round(ms),
      eventsPerSecond: Math.round((events / ms) * 1000),
      microsPerEvent: Math.round((ms / events) * 1000 * 10) / 10,
    };
  } finally {
    // The client leaves on every path, before the server's services are released.
    await counter?.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

if (import.meta.main) {
  const { values: flags } = parseArgs({
    options: {
      events: { type: "string", default: "20000" },
      record: { type: "boolean", default: false },
    },
  });
  const events = Number(flags.events);
  const runs = 5;
  const variants = ["effect", "plain"] as const;
  const modes = ["burst", "paced"] as const;
  const results = new Map<string, Array<Run>>();
  for (const mode of modes) {
    for (const variant of variants) {
      // One warm-up run (JIT, caches), not counted.
      await measure(variant, mode, events);
    }
  }
  // Interleaved, so every case sees the same machine state.
  for (let run = 0; run < runs; run++) {
    for (const mode of modes) {
      for (const variant of variants) {
        const key = `${mode}/${variant}`;
        results.set(key, [...(results.get(key) ?? []), await measure(variant, mode, events)]);
      }
    }
  }
  const summary = (mode: Mode, variant: Variant) => {
    const list = results.get(`${mode}/${variant}`) ?? [];
    return {
      eventsPerSecond: median(list.map((run) => run.eventsPerSecond)),
      microsPerEvent: median(list.map((run) => run.microsPerEvent)),
      runs: list.map((run) => run.eventsPerSecond),
    };
  };
  const report = Object.fromEntries(
    modes.map((mode) => {
      const effect = summary(mode, "effect");
      const plain = summary(mode, "plain");
      return [
        mode,
        {
          effect,
          plain,
          effectVersusPlain:
            Math.round((effect.eventsPerSecond / plain.eventsPerSecond) * 100) / 100,
        },
      ];
    }),
  );
  const runner = {
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
  };
  const compares =
    "complete source paths, publish to SSE event: effect = Bus (PubSub) + topic filter + guardStream + Stream.toAsyncIterableWith; plain = a hand-written async iterator over an indexed FIFO";
  const output = `${JSON.stringify({ runner, compares, events, runs, ...report }, null, 2)}\n`;
  process.stdout.write(output);
  if (flags.record) {
    const path = join(import.meta.dirname, "..", "..", "..", "bench", "subscriptions.json");
    writeFileSync(path, output);
    process.stderr.write(`bench: recorded ${path}\n`);
  }
}
