// `pnpm --filter orders-example bench:subscriptions`: subscription throughput of the Effect
// layer's Stream sources (docs/plan.html M7, moved from M5; Risks: Stream.toAsyncIterableWith
// forks two fibers per pull).
//
// Both variants run the app's own server (makeServer: effectSchema, the context factory, every
// plugin) on `subscription { orderChanged(id: "o-1") { id status } }`, read as SSE through
// handle(), with no socket in between, so the source is the only difference:
// - "effect": the app's orderChanged, a guarded Stream over the Bus (PubSub), each pull through
//   Stream.toAsyncIterableWith;
// - "plain": the same field with its subscribe replaced by a plain async iterator over an array
//   queue (no Effect).
// Each run warms up until an event has come through the SSE body, then times `events` events in
// one of two modes (see Mode). `--record` writes the medians, with the runner class, to
// bench/subscriptions.json at the repo root (run `pnpm fmt` after). There is no spec target: the plan asks for the
// numbers, and for chunked pulls only if they are needed.
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

/** A plain async iterator over a queue: what a source without Effect looks like. */
const plainQueue = () => {
  const buffer: Array<OrderRow> = [];
  let waiting: ((result: IteratorResult<OrderRow>) => void) | undefined;
  let done = false;
  const iterator: AsyncIterableIterator<OrderRow> = {
    next: () => {
      const row = buffer.shift();
      if (row !== undefined) {
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

/** One run: `events` events through a fresh server and subscription. */
export const measure = async (variant: Variant, mode: Mode, events: number): Promise<Run> => {
  const scope = Effect.runSync(Scope.make());
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
    // The response comes once the source exists; the Stream subscribes to the bus on its first
    // pull, and the bus drops what it publishes before that. Warm up until a warm-up event has
    // come through the body, then publish the measured ones.
    let response: Response | undefined;
    while (response === undefined) {
      publish(WARM_UP);
      response = await Promise.race([pending, immediate()]);
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("the subscription has no body");
    }
    const counts = { warmUp: 0, measured: 0 };
    let ended = false;
    const pump = (async () => {
      const decoder = new TextDecoder();
      let tail = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          ended = true;
          return;
        }
        // A marker may straddle two chunks: count in the tail of the last chunk plus this one
        // (the tail is shorter than any marker, so nothing is counted twice).
        const text = tail + decoder.decode(chunk.value, { stream: true });
        counts.warmUp += text.split(WARM_UP_MARKER).length - 1;
        counts.measured += text.split(MEASURED_MARKER).length - 1;
        tail = text.slice(-(MEASURED_MARKER.length - 1));
      }
    })();
    while (counts.warmUp === 0) {
      if (ended) {
        throw new Error("the subscription ended during the warm-up");
      }
      publish(WARM_UP);
      await immediate();
    }

    /** Waits until `count` measured events have been read. */
    const readUntil = async (count: number) => {
      while (counts.measured < count) {
        if (ended) {
          throw new Error(`the subscription ended after ${counts.measured} events`);
        }
        await immediate();
      }
    };
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
    await reader.cancel();
    await pump;
    return {
      variant,
      mode,
      events,
      ms: Math.round(ms),
      eventsPerSecond: Math.round((events / ms) * 1000),
      microsPerEvent: Math.round((ms / events) * 1000 * 10) / 10,
    };
  } finally {
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
  const output = `${JSON.stringify({ runner, events, runs, ...report }, null, 2)}\n`;
  process.stdout.write(output);
  if (flags.record) {
    const path = join(import.meta.dirname, "..", "..", "..", "bench", "subscriptions.json");
    writeFileSync(path, output);
    process.stderr.write(`bench: recorded ${path}\n`);
  }
}
