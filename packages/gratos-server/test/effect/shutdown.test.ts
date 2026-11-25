// Shutdown with the test app's real wiring (docs/plan.html M5 "Done when", Fibers and shutdown):
// effectRouteLayer's drain finalizer waits for every tracked mutation, before the services and
// the tracer layer are released. NodeHttpServer's graceful-shutdown wait runs before the drain
// (appendix, M5): the tests use a short gracefulShutdownTimeout, and the regression test also
// aborts the client socket, so the drain really runs while the mutation is held. The "warning
// logged" assertion proves it did.
import { describe, expect, it } from "vitest";

import { appLayer } from "../app/src/server.ts";
import { makeJournal } from "../app/src/services.ts";
import { gate } from "../support/http.ts";
import { buildServed, executors, recordingTracer, until } from "./support.ts";

const MUTATION = `mutation Ship {
  first: setStatus(id: "o-1", status: "packed") { id }
  second: setStatus(id: "o-2", status: "shipped") { id }
}`;

const post = (url: string, query: string, signal?: AbortSignal) => {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query }),
  };
  if (signal !== undefined) {
    init.signal = signal;
  }
  return fetch(url, init);
};

const start = async (plugins: ReturnType<(typeof executors)[number]["plugins"]>) => {
  const journal = makeJournal();
  const tracer = recordingTracer();
  const warnings: Array<string> = [];
  const served = await buildServed(
    appLayer({
      journal,
      tracer: tracer.tracer,
      plugins,
      warnAfterMs: 10,
      gracefulShutdownTimeout: "20 millis",
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
        error: () => {},
      },
    }),
  );
  return { journal, tracer, warnings, served };
};

const indexOf = (entries: ReadonlyArray<string>, entry: string): number => {
  const index = entries.indexOf(entry);
  if (index === -1) {
    throw new Error(`no "${entry}" in ${JSON.stringify(entries)}`);
  }
  return index;
};

describe.each(executors)("shutdown ($name executor)", (executor) => {
  it("commits both serial fields of a mutation in flight before any service is released", async () => {
    const { journal, served, warnings } = await start(executor.plugins());
    for (let index = 0; index < executor.warmUp; index += 1) {
      await (await post(served.url, MUTATION)).text();
    }
    journal.entries.length = 0;
    const hold = gate();
    journal.holds.set("o-1", hold.promise);
    const response = post(served.url, MUTATION).catch(() => undefined);
    await until(() => journal.entries.includes("held o-1"));
    const closing = served.close();
    // The drain has begun and is waiting for the mutation (it logged it).
    await until(() => warnings.length > 0);
    hold.resolve();
    await closing;
    await response;
    const { entries } = journal;
    expect(indexOf(entries, "commit o-1=packed")).toBeLessThan(
      indexOf(entries, "commit o-2=shipped"),
    );
    expect(indexOf(entries, "commit o-2=shipped")).toBeLessThan(indexOf(entries, "api released"));
  });

  it("regression: a mutation held past warnAfterMs between two serial fields finishes, then its span ends, then the layers go", async () => {
    const { journal, served, warnings, tracer } = await start(executor.plugins());
    for (let index = 0; index < executor.warmUp; index += 1) {
      await (await post(served.url, MUTATION)).text();
    }
    journal.entries.length = 0;
    tracer.clear();
    // The first field commits; the second is held, so shutdown starts between the two writes.
    const hold = gate();
    journal.holds.set("o-2", hold.promise);
    const client = new AbortController();
    const response = post(served.url, MUTATION, client.signal).catch(() => undefined);
    await until(() => journal.entries.includes("held o-2"));
    expect(journal.entries).toContain("commit o-1=packed");
    const closing = served.close();
    // The client leaves too: the transport stops waiting for it, and the drain runs.
    client.abort();
    await response;
    await until(() => warnings.length > 0);
    expect(warnings[0]).toContain("drain is waiting for 1 mutation(s)");
    expect(journal.entries).not.toContain("api released");
    expect(journal.entries).not.toContain("tracer released");
    hold.resolve();
    await closing;
    const { entries } = journal;
    const spanEnd = indexOf(entries, "span end graphql Ship");
    expect(entries.filter((entry) => entry === "span end graphql Ship")).toHaveLength(1);
    expect(indexOf(entries, "commit o-1=packed")).toBeLessThan(spanEnd);
    expect(indexOf(entries, "commit o-2=shipped")).toBeLessThan(spanEnd);
    expect(spanEnd).toBeLessThan(indexOf(entries, "tracer released"));
    expect(indexOf(entries, "commit o-2=shipped")).toBeLessThan(indexOf(entries, "api released"));
    const [operation] = tracer.named("graphql Ship");
    const resolvers = tracer.named("resolve Mutation.setStatus");
    expect(resolvers).toHaveLength(2);
    for (const resolver of resolvers) {
      expect((resolver.endTime ?? 0n) <= (operation?.endTime ?? -1n)).toBe(true);
    }
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("ok");
  });
});
