// The optional OTLP tracer of src/tracing.ts (docs/plan.html F6), on the app's own wiring: with
// OTEL_EXPORTER_OTLP_ENDPOINT set, the tracer layer is built, a request is served, and shutdown
// posts its trace; without it, nothing is exported. The exporter posts through a controlled
// HttpClient that answers every export with 400, a status the exporter never retries, so the one
// export the client sees is the shutdown flush and shutdown completes once that answer is seen.
// Periodic exports are off and shutdownTimeout is short, so no network timeout can hide a hang.
// (A refused port would not do: Effect 4.1.5's exporter retries transport errors.)
import { ConfigProvider, Duration, Effect, Layer, Logger, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";

import { tracingLayer } from "../src/tracing.ts";
import { AUTHORIZATION } from "./support/app.ts";
import { serve } from "./support/serve.ts";

interface Export {
  readonly url: string;
  /** The body's text (OTLP/JSON). */
  readonly body: string | undefined;
}

/** An HttpClient that records each request and answers it with 400, at once. */
const refusingClient = (journal: Array<string>) => {
  const exports: Array<Export> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      exports.push({
        url: url.href,
        body: request.body._tag === "Uint8Array" ? request.body.text : undefined,
      });
      journal.push("export answered");
      return HttpClientResponse.fromWeb(request, new Response("no", { status: 400 }));
    }),
  );
  return { exports, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

/** The app served with tracingLayer, reading `env` instead of the process's environment. */
const serveTraced = async (env: Record<string, string>) => {
  const journal: Array<string> = [];
  const warnings: Array<string> = [];
  const client = refusingClient(journal);
  const tracing = tracingLayer({
    exportInterval: Duration.infinity,
    shutdownTimeout: "1 second",
  }).pipe(
    Layer.provide(client.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provide(
      Logger.layer([
        Logger.make(({ message, logLevel }) => {
          if (logLevel === "Warn") {
            warnings.push(String(Array.isArray(message) ? message[0] : message));
          }
        }),
      ]),
    ),
  );
  const served = await serve({ tracing });
  try {
    const response = await fetch(served.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/graphql-response+json",
        authorization: AUTHORIZATION,
      },
      body: JSON.stringify({ query: 'query Traced { order(id: "o-1") { id } }' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(await response.json()).toEqual({ data: { order: { id: "o-1" } } });
    // Nothing is exported while the server runs: periodic exports are off.
    expect(client.exports).toEqual([]);
  } catch (error) {
    // A failed request or assertion still releases the server and its listener.
    await served.close();
    throw error;
  }
  await served.close();
  journal.push("closed");
  return { exports: client.exports, journal, warnings };
};

/** The parts of an OTLP/JSON traces body these tests read. */
const TracesBody = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                traceId: Schema.String,
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

/** The spans of an OTLP/JSON traces body. */
const spansOf = (body: string | undefined) =>
  Schema.decodeUnknownSync(TracesBody)(body).resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );

describe("the app's OTLP tracer", () => {
  it("is built when OTEL_EXPORTER_OTLP_ENDPOINT is set, and shutdown posts the trace once", async () => {
    const { exports, journal, warnings } = await serveTraced({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318",
    });

    // One export, the shutdown flush, answered before shutdown completed: the 400 was not
    // retried, and the exporter took it as a failure (no shutdown timeout cut it short).
    expect(exports.map((posted) => posted.url)).toEqual(["http://collector.test:4318/v1/traces"]);
    expect(journal).toEqual(["export answered", "closed"]);
    expect(warnings).toEqual(["Disabling exporter for 60 seconds"]);

    const spans = spansOf(exports[0]?.body);
    const names = spans.map((span) => span.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "POST",
        "session.read",
        "graphql Traced",
        "parse",
        "validate",
        "resolve Query.order",
        "rpc order_get",
      ]),
    );
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    const http = spans.find((span) => span.name === "POST");
    const operation = spans.find((span) => span.name === "graphql Traced");
    expect(operation?.parentSpanId).toBe(http?.spanId);
  });

  it("exports nothing without OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
    const { exports, journal, warnings } = await serveTraced({});

    expect(exports).toEqual([]);
    expect(journal).toEqual(["closed"]);
    expect(warnings).toEqual([]);
  });
});
