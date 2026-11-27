// Helpers for the Effect layer's tests: an in-memory tracer, the three executors the M5 suite
// runs on, and a NodeHttpServer built from a layer with a scope the test closes.
import { createServer as createHttpServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope, Tracer } from "effect";
import type { Duration } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { expect } from "vitest";

import { incremental } from "../../src/index.ts";
import type { Plugin } from "../../src/index.ts";
import { jit } from "../../src/jit.ts";

/** A span that counts its `end` calls (a span must end exactly once). */
export class RecordedSpan extends Tracer.NativeSpan {
  endCalls = 0;
  /** `performance.now()` when `end` was first called. */
  endedAtPerf: number | undefined;

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.endCalls += 1;
    this.endedAtPerf ??= performance.now();
    super.end(endTime, exit);
  }

  get ended(): boolean {
    return this.status._tag === "Ended";
  }

  get endTime(): bigint | undefined {
    return this.status._tag === "Ended" ? this.status.endTime : undefined;
  }

  /** "ok", "error" or "cancel" (an interrupt), once ended. */
  get outcome(): "ok" | "error" | "cancel" | "open" {
    if (this.status._tag !== "Ended") {
      return "open";
    }
    const { exit } = this.status;
    if (Exit.isSuccess(exit)) {
      return "ok";
    }
    return exit.cause.reasons.every((reason) => reason._tag === "Interrupt") ? "cancel" : "error";
  }

  get parentId(): string | undefined {
    return this.parent._tag === "Some" ? this.parent.value.spanId : undefined;
  }
}

/** A tracer that keeps every span it creates. */
export const recordingTracer = () => {
  const spans: Array<RecordedSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new RecordedSpan(options);
      spans.push(span);
      return span;
    },
  });
  return {
    tracer,
    spans,
    named: (name: string) => spans.filter((span) => span.name === name),
    open: () => spans.filter((span) => !span.ended),
    context: Context.make(Tracer.Tracer, tracer),
    clear: () => {
      spans.length = 0;
    },
  };
};

export type RecordingTracer = ReturnType<typeof recordingTracer>;

/** The executors the M5 suite runs on (docs/plan.html M5 "Done when"). */
export interface ExecutorCase {
  readonly name: "default" | "jit" | "incremental";
  /** Plugins that select the executor (listed before effect()). */
  readonly plugins: () => ReadonlyArray<Plugin>;
  /** Requests per document before the measured one (jit compiles on the second use). */
  readonly warmUp: number;
}

export const executors: ReadonlyArray<ExecutorCase> = [
  { name: "default", plugins: () => [], warmUp: 0 },
  { name: "jit", plugins: () => [jit({ after: 2 })], warmUp: 1 },
  { name: "incremental", plugins: () => [incremental()], warmUp: 0 },
];

/** A served layer: its GraphQL URL and its scope (closing it shuts the server down). */
export interface Served {
  readonly url: string;
  readonly scope: Scope.Closeable;
  readonly close: () => Promise<void>;
}

/** Builds a layer that provides HttpServer, with a scope the caller closes. */
export const buildServed = async <E>(
  layer: Layer.Layer<HttpServer.HttpServer, E>,
  path = "/graphql",
): Promise<Served> => {
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const { address } = Context.get(context, HttpServer.HttpServer);
  if (address._tag === "UnixPathAddress") {
    // Not handed to the caller: release the server it bound before rejecting it.
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error("expected a TCP address");
  }
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    scope,
    close: () => (closed ??= Effect.runPromise(Scope.close(scope, Exit.void))),
  };
};

/** Serves an HttpRouter app layer on NodeHttpServer (port 0). */
export const serveApp = <E>(
  app: Layer.Layer<never, E, HttpRouter.HttpRouter>,
  options: {
    readonly provide?: Layer.Layer<never>;
    readonly gracefulShutdownTimeout?: Duration.Input;
  } = {},
): Promise<Served> =>
  buildServed(
    HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(options.provide ?? Layer.empty),
      Layer.provideMerge(
        NodeHttpServer.layer(() => createHttpServer(), {
          port: 0,
          host: "127.0.0.1",
          gracefulShutdownTimeout: options.gracefulShutdownTimeout ?? "100 millis",
        }),
      ),
    ),
  );

/**
 * Asserts that `child` is a child span of `parent`, on its trace: both must exist, so two
 * missing spans never compare equal as `undefined`.
 */
export const expectChildOf = (
  child: RecordedSpan | undefined,
  parent: Tracer.AnySpan | undefined,
): void => {
  expect(child, "the child span").toBeDefined();
  expect(parent, "the parent span").toBeDefined();
  expect(child?.parentId).toBe(parent?.spanId);
  expect(child?.traceId).toBe(parent?.traceId);
};

/** Resolves once `check()` holds, polling every millisecond (fails after `timeoutMs`). */
export const until = async (check: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
};
