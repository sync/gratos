// Shutdown with the test app's real wiring (docs/plan.html M5 "Done when", Fibers and shutdown):
// effectRouteLayer's drain finalizer waits for every tracked mutation, before the services and
// the tracer layer are released. NodeHttpServer's graceful-shutdown wait runs before the drain
// (appendix, M5): the tests use a short gracefulShutdownTimeout, and the regression test also
// aborts the client socket, so the drain really runs while the mutation is held. The "warning
// logged" assertion proves it did. The regression test holds the mutation between its two
// serial fields, before the second field's Effect is forked (no resolver fiber is running), so
// a drain that only waited for resolver fibers would release the layers too early.
import { describe, expect, it, onTestFinished } from "vitest";

import type { Plugin } from "../../src/index.ts";
import { scopeOfRequest } from "../../src/effect/state.ts";
import type { Ctx } from "../app/src/context.ts";
import { appLayer } from "../app/src/server.ts";
import type { AppOptions } from "../app/src/server.ts";
import { makeJournal } from "../app/src/services.ts";
import { gate } from "../support/http.ts";
import { buildServed, executors, recordingTracer, until } from "./support.ts";

const MUTATION = `mutation Ship {
  first: setStatus(id: "o-1", status: "packed") { id }
  second: setStatus(id: "o-2", status: "shipped") { id }
}`;

/** The same mutation, whose first field's selection includes the held Order.confirmation. */
const HELD_MUTATION = `mutation Ship {
  first: setStatus(id: "o-1", status: "packed") { id confirmation }
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

const start = async (
  plugins: ReadonlyArray<Plugin<Ctx>>,
  options: Pick<AppOptions, "confirmationHold"> = {},
) => {
  const journal = makeJournal();
  const tracer = recordingTracer();
  const warnings: Array<string> = [];
  const served = await buildServed(
    appLayer({
      journal,
      tracer: tracer.tracer,
      plugins,
      ...options,
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
    // Registered before the mutation is held: the drain can finish once the hold is open.
    onTestFinished(async () => {
      hold.resolve();
      await served.close();
    });
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

  it("regression: a mutation held past warnAfterMs between two serial fields, before the second forks, finishes, then its span ends, then the layers go", async () => {
    // Held in the first field's selection (Order.confirmation, a plain Promise): graphql-js
    // has not called the second field's resolver yet, so no resolver fiber is running. Only a
    // drain that waits for the whole mutation (control.drain) holds the layers here.
    const reached = gate();
    const hold = gate();
    let holding = false;
    const requests: Array<Request> = [];
    const recorder: Plugin<Ctx> = {
      onContext: (_ctx, request) => {
        requests.push(request);
      },
    };
    const { journal, served, warnings, tracer } = await start([recorder, ...executor.plugins()], {
      confirmationHold: (id) => {
        if (!holding || id !== "o-1") {
          return Promise.resolve();
        }
        reached.resolve();
        return hold.promise;
      },
    });
    for (let index = 0; index < executor.warmUp; index += 1) {
      await (await post(served.url, HELD_MUTATION)).text();
    }
    journal.entries.length = 0;
    tracer.clear();
    onTestFinished(async () => {
      hold.resolve();
      await served.close();
    });
    holding = true;
    const client = new AbortController();
    const response = post(served.url, HELD_MUTATION, client.signal).catch(() => undefined);
    await reached.promise;
    // Between the two writes: the first committed, the second not started, no fiber running.
    expect(journal.entries).toEqual(["commit o-1=packed"]);
    const request = requests.at(-1);
    expect(request === undefined ? undefined : scopeOfRequest(request)?.fibers.size).toBe(0);
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
    expect(indexOf(entries, "commit o-1=packed")).toBeLessThan(
      indexOf(entries, "commit o-2=shipped"),
    );
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
