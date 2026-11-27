// The request body limit through effectRoute over a real NodeHttpServer (docs/plan.html,
// follow-up F1): an oversized POST gets the core's 413 and one `graphql anonymous` error span, a
// chunked upload that never ends is answered, and Effect's own MaxBodySize does not bound the
// stream the route reads (a pin: a change in Effect shows up here).
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import { ByteSize, Effect, Layer } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../src/index.ts";
import { effectRoute } from "../../src/effect/index.ts";
import { appLayer } from "../app/src/server.ts";
import { makeJournal } from "../app/src/services.ts";
import { basicSchema } from "../support/schema.ts";
import { buildServed, recordingTracer, until } from "./support.ts";
import type { Served } from "./support.ts";

const served: Array<Served> = [];
const sockets: Array<Socket> = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const app of served.splice(0)) {
    await app.close();
  }
});

const tooLarge = (limit: number) => ({
  errors: [{ message: `The request body is larger than ${limit} bytes.` }],
});

/** A `{ greeting }` request padded with an unused variable to exactly `bytes` bytes. */
const greetingBodyOf = (bytes: number): string => {
  const empty = JSON.stringify({ query: "{ greeting }", variables: { pad: "" } });
  return JSON.stringify({
    query: "{ greeting }",
    variables: { pad: "x".repeat(bytes - empty.length) },
  });
};

const post = (url: string, body: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/graphql-response+json" },
    body,
  });

const startApp = async (maxBodyBytes: number) => {
  const tracer = recordingTracer();
  const app = await buildServed(
    appLayer({ journal: makeJournal(), tracer: tracer.tracer, maxBodyBytes }),
  );
  served.push(app);
  return { app, tracer };
};

describe("effectRoute over NodeHttpServer", () => {
  it("answers an oversized POST with 413 and one graphql anonymous error span", async () => {
    const { app, tracer } = await startApp(1000);
    const response = await post(app.url, greetingBodyOf(1001));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(tooLarge(1000));
    await until(() => tracer.open().length === 0);
    const operations = tracer.spans.filter((span) => span.name.startsWith("graphql "));
    expect(operations.map((span) => span.name)).toEqual(["graphql anonymous"]);
    expect(operations[0]?.endCalls).toBe(1);
    expect(operations[0]?.outcome).toBe("error");
    // A body at the limit is served.
    const ok = await post(app.url, greetingBodyOf(1000));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { greeting: "hello ada" } });
  });

  it("answers a chunked upload over the limit that never ends", async () => {
    const { app } = await startApp(4096);
    const { hostname, port } = new URL(app.url);
    const socket = connect(Number(port), hostname);
    sockets.push(socket);
    await once(socket, "connect");
    socket.write(
      "POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    // More than the limit, and never the closing chunk: only a bounded read can answer.
    const chunk = " ".repeat(1000);
    for (let index = 0; index < 6; index += 1) {
      socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    }
    socket.setEncoding("utf8");
    let text = "";
    for await (const data of socket) {
      text += String(data);
      if (text.includes("}]}")) {
        break;
      }
    }
    expect(text).toMatch(/^HTTP\/1\.1 413 /);
    expect(text).toContain(JSON.stringify(tooLarge(4096)));
  });

  it("is the only limit: Effect's MaxBodySize does not bound the body the route reads", async () => {
    const limit = ByteSize.bytes(100);
    const withMaxBodySize = Effect.provideService(HttpIncomingMessage.MaxBodySize, limit);
    const server = createServer({ schema: basicSchema(), maxBodyBytes: 1000 });
    const graphql = effectRoute(server);
    const routes = Layer.mergeAll(
      HttpRouter.add("*", "/graphql", (req) => withMaxBodySize(graphql(req))),
      // The control: a buffered read under the same MaxBodySize is refused.
      HttpRouter.add("POST", "/buffered", (req) =>
        withMaxBodySize(
          req.text.pipe(
            Effect.map((text) => HttpServerResponse.text(`read ${text.length}`)),
            Effect.catch(() => Effect.succeed(HttpServerResponse.text("refused", { status: 413 }))),
          ),
        ),
      ),
    );
    const app = await buildServed(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => createHttpServer(), { port: 0, host: "127.0.0.1" }),
        ),
      ),
    );
    served.push(app);
    const body = JSON.stringify({ query: "{ count }", variables: { pad: "x".repeat(400) } });
    const buffered = await post(app.url.replace("/graphql", "/buffered"), body);
    expect(await buffered.text()).toBe("refused");
    const response = await post(app.url, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { count: 1 } });
  });
});
