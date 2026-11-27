// An in-memory tracer for the example's trace tests: it keeps every span it creates, and counts
// each span's `end` calls (a span ends exactly once). Provided as a layer where src/server.ts
// provides the OTLP tracer (appLayer's `tracing`).
import { Exit, Layer, Tracer } from "effect";

export class RecordedSpan extends Tracer.NativeSpan {
  endCalls = 0;

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.endCalls += 1;
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
    spans,
    /** The tracer as appLayer's `tracing`. */
    layer: Layer.succeed(Tracer.Tracer, tracer),
    named: (name: string) => spans.filter((span) => span.name === name),
    open: () => spans.filter((span) => !span.ended),
    /** The spans below `root`, at any depth. */
    descendantsOf: (root: RecordedSpan): Array<RecordedSpan> => {
      const below = new Set([root.spanId]);
      const found: Array<RecordedSpan> = [];
      // Spans are recorded parent first: one pass in creation order finds every depth.
      for (const span of spans) {
        if (span.parentId !== undefined && below.has(span.parentId)) {
          below.add(span.spanId);
          found.push(span);
        }
      }
      return found;
    },
  };
};

export type RecordingTracer = ReturnType<typeof recordingTracer>;
