// The Effect layer over a real NodeHttpServer socket, with the test app's wiring, once per
// executor (docs/plan.html M5 "Done when": aborts mid-SSE and mid-multipart, an idle subscription's
// finalizer, one trace per request, the session-read span, HEAD, a client that leaves during a
// slow runInRequest context, and the M4a method and content-type rows through NodeHttpServer).
import { request as httpRequest } from "node:http";

import type { GraphQLError } from "graphql";
import { afterEach, describe, expect, it } from "vitest";

import { reportErrors } from "../../src/index.ts";
import type { Plugin } from "../../src/index.ts";
import type { Ctx } from "../app/src/context.ts";
import { appLayer } from "../app/src/server.ts";
import { makeJournal } from "../app/src/services.ts";
import type { Journal } from "../app/src/services.ts";
import { readUntil } from "../support/stream.ts";
import { buildServed, executors, expectChildOf, recordingTracer, until } from "./support.ts";
import type { ExecutorCase, RecordingTracer, Served } from "./support.ts";

interface Running {
  readonly served: Served;
  readonly tracer: RecordingTracer;
  readonly journal: Journal;
  readonly reported: Array<GraphQLError>;
}

const running: Array<Running> = [];
/** Holds a test opens on a failure too, before the shutdown (which waits for their finalizers). */
const releases: Array<() => void> = [];

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  for (const { served } of running.splice(0)) {
    await served.close();
  }
});

const start = async (executor: ExecutorCase, extra: ReadonlyArray<Plugin<Ctx>> = []) => {
  const tracer = recordingTracer();
  const journal = makeJournal();
  const reported: Array<GraphQLError> = [];
  const served = await buildServed(
    appLayer({
      journal,
      tracer: tracer.tracer,
      plugins: [
        ...extra,
        reportErrors((error) => {
          reported.push(error);
        }),
        ...executor.plugins(),
      ],
      gracefulShutdownTimeout: "50 millis",
    }),
  );
  const app: Running = { served, tracer, journal, reported };
  running.push(app);
  return app;
};

const graphql = (
  url: string,
  query: string,
  options: {
    readonly accept?: string;
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
  } = {},
) => {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: options.accept ?? "application/graphql-response+json",
      ...options.headers,
    },
    body: JSON.stringify({ query }),
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  return fetch(url, init);
};

const operationSpans = (tracer: RecordingTracer) =>
  tracer.spans.filter((span) => span.name.startsWith("graphql "));

describe.each(executors)("over NodeHttpServer ($name executor)", (executor) => {
  it("keeps one trace id per request: HTTP, operation, phases, resolvers, RPC, session read", async () => {
    const { served, tracer } = await start(executor);
    const query = 'query Trace { order(id: "o-1") { id label } }';
    for (let index = 0; index < executor.warmUp; index += 1) {
      await (await graphql(served.url, query)).text();
    }
    tracer.clear();
    const response = await graphql(served.url, query);
    expect(await response.json()).toEqual({
      data: { order: { id: "o-1", label: "o-1:open" } },
    });
    await until(() => tracer.open().length === 0);
    const http = tracer.spans.find((span) => span.name === "POST");
    const [operation] = tracer.named("graphql Trace");
    const [session] = tracer.named("session.read");
    const [resolver] = tracer.named("resolve Query.order");
    const [rpc] = tracer.named("rpc Api.order");
    expect(new Set(tracer.spans.map((span) => span.traceId)).size).toBe(1);
    expectChildOf(operation, http);
    expectChildOf(session, http);
    expectChildOf(resolver, operation);
    expectChildOf(rpc, resolver);
    expect(operation?.endCalls).toBe(1);
  });

  it("ends a real HEAD request's span exactly once", async () => {
    const { served, tracer } = await start(executor);
    const response = await fetch(served.url, { method: "HEAD" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await until(() => tracer.open().length === 0);
    const [operation] = operationSpans(tracer);
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("error");
  });

  it("answers the method and content-type rows of the HTTP matrix", async () => {
    const { served } = await start(executor);
    const get = await fetch(served.url);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(await get.text()).toBe("");
    const put = await fetch(served.url, { method: "PUT", body: "{}" });
    expect(put.status).toBe(405);
    const text = await fetch(served.url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"query":"{ greeting }"}',
    });
    expect(text.status).toBe(415);
    const broken = await fetch(served.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(broken.status).toBe(400);
    const html = await graphql(served.url, "{ greeting }", { accept: "text/html" });
    expect(html.status).toBe(406);
    const ok = await graphql(served.url, "{ greeting }");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { greeting: "hello ada" } });
  });

  it("closes a subscription whose client closes the socket mid-SSE, and reports nothing", async () => {
    const { served, tracer, journal, reported } = await start(executor);
    const controller = new AbortController();
    // NodeHttpServer sends a streamed response's headers with its first chunk: the response
    // arrives with the first event, so the event is published before it is awaited.
    const pending = graphql(served.url, 'subscription { orderChanged(id: "o-1") { id status } }', {
      accept: "text/event-stream",
      signal: controller.signal,
    });
    // The stream's setup has subscribed to the bus once the transport pulls the body: an event
    // published before it would be lost (the bus keeps no replay).
    await until(() => journal.entries.includes("orderChanged subscribed o-1"));
    const write = await graphql(
      served.url,
      'mutation { setStatus(id: "o-1", status: "shipped") { id } }',
    );
    expect(await write.json()).toEqual({ data: { setStatus: { id: "o-1" } } });
    const body = (await pending).body;
    if (body === null) {
      throw new Error("no body");
    }
    const { text } = await readUntil(body, (read) => read.includes("event: next"));
    expect(text).toContain('"status":"shipped"');
    controller.abort();
    await until(() => journal.entries.includes("orderChanged released o-1"));
    await until(() => tracer.open().length === 0);
    expect(reported).toEqual([]);
    const subscription = operationSpans(tracer).find(
      (span) => span.attributes.get("graphql.operation.type") === "subscription",
    );
    expect(subscription?.endCalls).toBe(1);
    expect(subscription?.outcome).toBe("cancel");
  });

  it("runs an idle subscription's acquireRelease finalizer when the client closes the socket", async () => {
    const { served, tracer, journal } = await start(executor);
    const controller = new AbortController();
    // The transport pulls the body, so the stream's setup runs; then it has nothing to yield (and
    // NodeHttpServer sends no headers before a first chunk, so the fetch stays pending).
    const pending = graphql(served.url, "subscription { watch }", {
      accept: "text/event-stream",
      signal: controller.signal,
    });
    await until(() => journal.entries.includes("watch acquired ada"));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await until(() => journal.entries.includes("watch released ada"));
    await until(() => tracer.open().length === 0);
  });

  it("ends the span of a client that leaves mid-SSE once its Stream's held finalizer ran, with cancel", async () => {
    const { served, tracer, journal, reported } = await start(executor);
    const hold = Promise.withResolvers<void>();
    journal.holds.set("heldWatch", hold.promise);
    releases.push(hold.resolve);
    const controller = new AbortController();
    const response = await graphql(served.url, "subscription Held { heldWatch }", {
      accept: "text/event-stream",
      signal: controller.signal,
    });
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const { text } = await readUntil(body, (read) => read.includes("event: next"));
    expect(text).toContain('"heldWatch":"first"');
    controller.abort();
    await until(() => journal.entries.includes("releasing heldWatch"));
    const [operation] = tracer.named("graphql Held");
    // The client has left and the transport is done, but the Stream's scope is still closing.
    expect(operation?.ended).toBe(false);
    hold.resolve();
    await until(() => tracer.open().length === 0);
    const [release] = tracer.named("release heldWatch");
    expectChildOf(release, operation);
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("cancel");
    expect((operation?.endTime ?? 0n) >= (release?.endTime ?? 1n)).toBe(true);
    expect((operation?.endedAtPerf ?? 0) >= (release?.endedAtPerf ?? 1)).toBe(true);
    expect(reported).toEqual([]);
  });

  it("leaves no span open when the client leaves during a slow runInRequest context", async () => {
    const { served, tracer, reported } = await start(executor);
    const controller = new AbortController();
    const pending = graphql(served.url, "{ greeting }", {
      headers: { "x-session-delay-ms": "60000" },
      signal: controller.signal,
    });
    await until(() => tracer.named("session.read").length > 0);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await until(() => tracer.open().length === 0);
    const [operation] = operationSpans(tracer);
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("cancel");
    expect(tracer.named("session.read")[0]?.outcome).toBe("cancel");
    expect(reported).toEqual([]);
  });

  it("never runs a mutation whose client leaves during a slow context: zero executor calls, one cancel", async () => {
    let executorCalls = 0;
    const counting: Plugin<Ctx> = {
      onExecute: () => (next) => {
        executorCalls += 1;
        return next();
      },
    };
    const { served, tracer, journal } = await start(executor, [counting]);
    const controller = new AbortController();
    const pending = graphql(
      served.url,
      'mutation { setStatus(id: "o-1", status: "never") { id } }',
      { headers: { "x-session-delay-ms": "60000" }, signal: controller.signal },
    );
    await until(() => tracer.named("session.read").length > 0);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await until(() => tracer.open().length === 0);
    const [operation] = operationSpans(tracer);
    expect(executorCalls).toBe(0);
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("cancel");
    expect(journal.entries.filter((entry) => entry.startsWith("commit"))).toEqual([]);
  });
});

describe("over NodeHttpServer, incremental delivery", () => {
  it("interrupts the deferred resolver of a client that disconnects after the first payload", async () => {
    const executor = executors[2];
    if (executor === undefined) {
      throw new Error("no incremental executor");
    }
    const { served, tracer, journal, reported } = await start(executor);
    const controller = new AbortController();
    const response = await graphql(
      served.url,
      'query Deferred { order(id: "o-1") { id ... @defer { slowNote } } }',
      { accept: "multipart/mixed", signal: controller.signal },
    );
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const { text } = await readUntil(body, (read) => read.includes('"hasNext":true'));
    expect(text).toContain('"id":"o-1"');
    await until(() => journal.entries.includes("note started o-1"));
    controller.abort();
    await until(() => journal.entries.includes("note interrupted o-1"));
    await until(() => tracer.open().length === 0);
    expect(reported).toEqual([]);
    const [operation] = tracer.named("graphql Deferred");
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("cancel");
  });

  it("ends the span of a client that leaves mid-multipart once its interrupted resolver's held finalizer ran", async () => {
    const executor = executors[2];
    if (executor === undefined) {
      throw new Error("no incremental executor");
    }
    const { served, tracer, journal, reported } = await start(executor);
    const hold = Promise.withResolvers<void>();
    journal.holds.set("note o-1", hold.promise);
    releases.push(hold.resolve);
    const controller = new AbortController();
    const response = await graphql(
      served.url,
      'query HeldDefer { order(id: "o-1") { id ... @defer { heldNote } } }',
      { accept: "multipart/mixed", signal: controller.signal },
    );
    const body = response.body;
    if (body === null) {
      throw new Error("no body");
    }
    const { text } = await readUntil(body, (read) => read.includes('"hasNext":true'));
    expect(text).toContain('"id":"o-1"');
    await until(() => journal.entries.includes("acquired note o-1"));
    controller.abort();
    await until(() => journal.entries.includes("releasing note o-1"));
    const [operation] = tracer.named("graphql HeldDefer");
    // The client has left, but the interrupted resolver's fiber is still in its finalizer.
    expect(operation?.ended).toBe(false);
    hold.resolve();
    await until(() => tracer.open().length === 0);
    const [resolver] = tracer.named("resolve Order.heldNote");
    const [release] = tracer.named("release note o-1");
    expectChildOf(resolver, operation);
    expectChildOf(release, resolver);
    expect(resolver?.outcome).toBe("cancel");
    expect(operation?.endCalls).toBe(1);
    expect(operation?.outcome).toBe("cancel");
    expect((operation?.endTime ?? 0n) >= (resolver?.endTime ?? 1n)).toBe(true);
    expect((operation?.endedAtPerf ?? 0) >= (resolver?.endedAtPerf ?? 1)).toBe(true);
    expect(reported).toEqual([]);
  });
});

/** Sends `method` with node:http (fetch refuses TRACE), and reads the status and Allow. */
const rawRequest = (url: string, method: string) =>
  new Promise<{ readonly status: number | undefined; readonly allow: string | undefined }>(
    (resolve, reject) => {
      const outgoing = httpRequest(url, { method }, (incoming) => {
        incoming.resume();
        resolve({ status: incoming.statusCode, allow: incoming.headers.allow });
      });
      outgoing.on("error", reject);
      outgoing.end();
    },
  );

describe("over NodeHttpServer, effectRoute's conversions", () => {
  const executor = executors[0];
  if (executor === undefined) {
    throw new Error("no default executor");
  }

  it("answers a method no Web Request can carry (TRACE) with the core's 405", async () => {
    const { served } = await start(executor);
    expect(await rawRequest(served.url, "TRACE")).toEqual({ status: 405, allow: "POST" });
  });

  it("cancels the body of a HEAD response, which the transport never reads", async () => {
    let cancelled = false;
    const streaming: Plugin<Ctx> = {
      onRequest: (request) =>
        request.method === "HEAD"
          ? new Response(
              new ReadableStream({
                cancel: () => {
                  cancelled = true;
                },
              }),
              { status: 200, headers: { "content-type": "text/plain" } },
            )
          : undefined,
    };
    const { served } = await start(executor, [streaming]);
    const response = await fetch(served.url, { method: "HEAD" });
    expect(response.status).toBe(200);
    await until(() => cancelled);
  });

  it("keeps every Set-Cookie field, also two for the same cookie name", async () => {
    const cookies: Plugin<Ctx> = {
      onResponse: (response) => {
        const headers = new Headers(response.headers);
        headers.append("set-cookie", "session=old; Path=/old; Max-Age=0");
        headers.append("set-cookie", "session=new; Path=/");
        return new Response(response.body, { status: response.status, headers });
      },
    };
    const { served } = await start(executor, [cookies]);
    const response = await graphql(served.url, "{ greeting }");
    expect(await response.json()).toEqual({ data: { greeting: "hello ada" } });
    const fields = response.headers.getSetCookie();
    expect(fields).toHaveLength(2);
    expect(fields[0]).toContain("session=old");
    expect(fields[0]).toContain("Path=/old");
    expect(fields[0]).toContain("Max-Age=0");
    expect(fields[1]).toContain("session=new");
    expect(fields[1]).toContain("Path=/");
  });
});
