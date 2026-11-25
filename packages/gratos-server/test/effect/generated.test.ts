// The Effect layer on a schema Grats generated (test/app), on standalone handle(Request), once per
// executor (docs/plan.html M5 "Done when": semantic non-null for a generated
// strictSemanticNullability subscription, Promise-wrapped Effects and Streams from an async
// derived context, and the graphql 17.1 late-source case).
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Server } from "../../src/index.ts";
import { makeServer, servicesLayer } from "../app/src/server.ts";
import type { Services } from "../app/src/server.ts";
import { makeJournal } from "../app/src/services.ts";
import type { DerivedHold } from "../app/src/context.ts";
import { flush, gate, gql, post, send } from "../support/http.ts";
import { readSse } from "../support/stream.ts";
import { executors, recordingTracer, until } from "./support.ts";

const journal = makeJournal();
const scope = Effect.runSync(Scope.make());
let services: Context.Context<Services>;

beforeAll(async () => {
  services = await Effect.runPromise(Layer.buildWithScope(servicesLayer(journal), scope));
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const subscribe = async (server: Server, query: string, headers: Record<string, string> = {}) => {
  const request = post({ query }, { accept: "text/event-stream" });
  for (const [name, value] of Object.entries(headers)) {
    request.headers.set(name, value);
  }
  const response = await server.handle(request);
  return readSse(await response.text());
};

describe.each(executors)("a generated schema ($name executor)", (executor) => {
  const build = (derivedHold?: DerivedHold) => {
    const tracer = recordingTracer();
    const server = makeServer(services, {
      journal,
      plugins: executor.plugins(),
      context: Context.merge(services, tracer.context),
      derivedHold,
    });
    return { server, tracer };
  };

  it("gives a null item of a strictSemanticNullability subscription one error event, then goes on", async () => {
    const { server } = build();
    const read = await subscribe(server, "subscription { labels }");
    expect(read.names).toEqual(["next", "next", "complete"]);
    expect(read.payloads[0]).toEqual({
      data: { labels: null },
      errors: [
        {
          message: "Cannot return null for semantically non-nullable field.",
          locations: [{ line: 1, column: 16 }],
          path: ["labels"],
        },
      ],
    });
    expect(read.payloads[1]).toEqual({ data: { labels: "o-1:open" } });
  });

  it("turns a null success of a generated Effect field into a field error", async () => {
    const { server } = build();
    for (let index = 0; index < executor.warmUp; index += 1) {
      await gql(server, "{ missingLabel }");
    }
    const sent = await gql(server, "{ missingLabel }");
    expect(sent.body).toEqual({
      data: { missingLabel: null },
      errors: [
        {
          message: "Cannot return null for semantically non-nullable field.",
          locations: [{ line: 1, column: 3 }],
          path: ["missingLabel"],
        },
      ],
    });
  });

  it("runs an Effect that reaches it inside a Promise (an async derived context)", async () => {
    const { server } = build();
    for (let index = 0; index < executor.warmUp; index += 1) {
      await gql(server, "{ greeting }");
    }
    const sent = await gql(server, "{ greeting }");
    expect(sent.body).toEqual({ data: { greeting: "hello ada" } });
  });

  it("subscribes to a Stream that reaches it inside a Promise (an async derived context)", async () => {
    const { server } = build();
    const read = await subscribe(server, "subscription { greetings }");
    expect(read.names).toEqual(["next", "next", "complete"]);
    expect(read.payloads.map((payload) => payload.data)).toEqual([
      { greetings: "hello ada" },
      { greetings: "bye ada" },
    ]);
  });

  it("runs the generated guarded query, and maps its typed failure and its refusal", async () => {
    const { server } = build();
    const found = '{ order(id: "o-1") { id label } }';
    const missing = '{ order(id: "nope") { id } }';
    const refusedQuery = '{ order(id: "o-1") { id } }';
    // Warmed with the default (authorized) session, so jit runs the measured requests.
    for (let index = 0; index < executor.warmUp; index += 1) {
      for (const query of [found, missing, refusedQuery]) {
        await gql(server, query);
      }
    }
    expect((await gql(server, found)).body).toEqual({
      data: { order: { id: "o-1", label: "o-1:open" } },
    });
    expect((await gql(server, missing)).error).toMatchObject({
      message: "Order nope not found.",
      extensions: { code: "NOT_FOUND", http: { status: 404 } },
    });
    const refused = post({ query: refusedQuery });
    refused.headers.set("x-scopes", "orders:write");
    expect((await send(server, refused)).error).toMatchObject({
      message: "Forbidden.",
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  });

  it("acquires nothing for a source that settles after the client left (graphql 17.1 drops it)", async () => {
    const reached = gate();
    const hold = gate();
    const { server, tracer } = build({ reached: reached.resolve, hold: hold.promise });
    const viewer = `late-${executor.name}`;
    const controller = new AbortController();
    const request = post(
      { query: "subscription { watch }" },
      { accept: "text/event-stream", signal: controller.signal },
    );
    request.headers.set("x-viewer", viewer);
    const pending = server.handle(request);
    await reached.promise;
    controller.abort();
    expect((await pending).status).toBe(499);
    // The derived context settles after the abort: graphql drops the source it returns.
    hold.resolve();
    await flush();
    await flush();
    expect(journal.entries.filter((entry) => entry.includes(viewer))).toEqual([]);
    expect(tracer.open()).toEqual([]);
  });

  it("releases an idle source's setup when its body is cancelled", async () => {
    const { server } = build();
    const viewer = `idle-${executor.name}`;
    const request = post({ query: "subscription { watch }" }, { accept: "text/event-stream" });
    request.headers.set("x-viewer", viewer);
    const response = await server.handle(request);
    const body = response.body;
    expect(body).not.toBeNull();
    if (body === null) {
      return;
    }
    // Pull once: the stream starts (its setup runs), and stays idle.
    const reader = body.getReader();
    const firstRead = reader.read();
    await until(() => journal.entries.includes(`watch acquired ${viewer}`));
    await reader.cancel();
    await firstRead;
    await until(() => journal.entries.includes(`watch released ${viewer}`));
    expect(journal.entries.filter((entry) => entry.includes(viewer))).toEqual([
      `watch acquired ${viewer}`,
      `watch released ${viewer}`,
    ]);
  });
});
