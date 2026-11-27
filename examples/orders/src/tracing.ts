// The app's optional OTLP tracer: Effect's own exporter (effect/observability), switched on by
// OTEL_EXPORTER_OTLP_ENDPOINT, the base URL of an OTLP/HTTP collector (http://localhost:4318, say).
// Each request's trace then goes to <endpoint>/v1/traces as JSON. Without the variable this layer
// is empty and the exporter is never loaded: its modules are imported only once the variable is
// set, so a production start without it pays nothing.
//
// The exporter batches spans and posts them every 5 s and when the layer is released; on shutdown
// it waits for that last export up to `shutdownTimeout` (3 s by default). Effect marks these modules
// unstable in 4.1.5.
import { Config, Effect, Layer, Option } from "effect";
import type { Duration } from "effect";
import type { HttpClient } from "effect/http";

export interface TracingOptions {
  /** How often buffered spans are posted (default 5 s; `Duration.infinity`: only at shutdown). */
  readonly exportInterval?: Duration.Input | undefined;
  /** How long shutdown waits for the last export (default 3 s). */
  readonly shutdownTimeout?: Duration.Input | undefined;
}

/** `<endpoint>/v1/traces`, the OTLP/HTTP path, as OpenTelemetry's own exporters build it. */
const tracesUrl = (endpoint: URL): string => {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  return url.href;
};

/**
 * The OTLP tracer when OTEL_EXPORTER_OTLP_ENDPOINT is set, otherwise nothing. Provide it to the
 * app with its services (`appLayer`'s `tracing`), so the last export runs after the drain. It posts
 * through the HttpClient it is given (`FetchHttpClient.layer` in `src/server.ts`).
 */
export const tracingLayer = (
  options: TracingOptions = {},
): Layer.Layer<never, never, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const endpoint = yield* Config.option(Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT"));
      if (Option.isNone(endpoint)) {
        return Layer.empty;
      }
      const { OtlpSerialization, OtlpTracer } = yield* Effect.promise(
        () => import("effect/observability"),
      );
      return OtlpTracer.layer({
        url: tracesUrl(endpoint.value),
        resource: { serviceName: "orders-example" },
        exportInterval: options.exportInterval,
        shutdownTimeout: options.shutdownTimeout,
      }).pipe(Layer.provide(OtlpSerialization.layerJson));
    }).pipe(Effect.orDie),
  );
