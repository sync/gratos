// The streamed encoders (docs/plan.html M4b): incremental (`@defer`/`@stream`) results as
// multipart/mixed; deferSpec=20220824 (the format Apollo Client reads), and subscription events as
// GraphQL-over-SSE "distinct connections" (`event: next` per payload, then `event: complete`).
//
// Both share one pull loop over the executor's payloads:
// - each payload goes through the result hooks (`process`: onResult masking and reporting) before
//   it is framed;
// - a rejected pull (a source that failed) becomes a GraphQL error payload, goes through the same
//   hooks, and is sent as the final payload, then the stream ends (`complete`, or the closing
//   boundary);
// - once the core signal is aborted (the client left), a rejected pull is a cancellation
//   (graphql's AbortError, or a cancelled() sentinel): it skips the hooks and nothing more is sent;
// - closing the stream early (a body cancel, or the core signal aborting) aborts the core signal
//   first, so cooperative sources stop (one waiting on `info.getAbortSignal()`), and only then
//   awaits the iterator's `return()`: a `return()` alone can wait forever on a pending pull.
import type { ExecutionResult, GraphQLError } from "graphql";

import { DEFER_SPEC, MULTIPART_MIXED, TEXT_EVENT_STREAM } from "./http.ts";
import type { Logger } from "./types.ts";

/** A payload on its way out, with the `hasNext` the executor gave it (multipart only). */
export interface StreamPayload {
  readonly result: ExecutionResult;
  readonly hasNext: boolean;
}

/** The payloads still to come, pulled one at a time. */
export interface PayloadSource {
  readonly next: () => Promise<IteratorResult<StreamPayload, void>>;
  /** Closes the executor's iterator (its source's `finally`, cleanup). */
  readonly return: () => Promise<void>;
}

/** What one streamed response needs from the core. */
export interface StreamOptions {
  /** The first payload, already through the result hooks (the initial incremental result). */
  readonly first: StreamPayload | undefined;
  readonly rest: PayloadSource | undefined;
  /** The result hooks (onResult), run on every later payload. */
  readonly process: (result: ExecutionResult) => ExecutionResult;
  /** Turns a rejected pull into the GraphQL error the client gets (before `process`). */
  readonly failure: (error: unknown) => GraphQLError;
  /** The core's request signal, and the controller that aborts it. */
  readonly controller: AbortController;
  readonly logger: Logger;
}

const encoder = new TextEncoder();

/** How a stream type frames its payloads. */
interface Framing {
  readonly contentType: string;
  /** What comes before the first payload (or before `end`, when there is none). */
  readonly start: string;
  /** One payload, ready for the client to read as soon as it arrives. */
  readonly frame: (payload: StreamPayload) => string;
  /** What ends the stream, after the last payload. */
  readonly end: string;
}

/**
 * multipart/mixed with boundary "-". Every chunk ends with a delimiter (`\r\n---`): a client
 * that splits on the delimiter (Apollo Client) reads a part only once the delimiter after it has
 * arrived, so a part must never wait for the next one. A part therefore starts with the CRLF that
 * ends its delimiter line, and the stream ends with `--` (the close delimiter). On the wire this
 * is byte for byte Apollo Server's framing; only the chunk edges differ, so a stream that ends
 * without a `hasNext: false` part still closes cleanly instead of sending an empty part.
 */
const multipartFraming: Framing = {
  contentType: `${MULTIPART_MIXED}; boundary="-"; deferSpec=${DEFER_SPEC}`,
  start: "\r\n---",
  frame: ({ result, hasNext }) =>
    `\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ ...result, hasNext })}\r\n---`,
  end: "--\r\n",
};

const sseFraming: Framing = {
  contentType: `${TEXT_EVENT_STREAM}; charset=utf-8`,
  start: "",
  frame: ({ result }) => `event: next\ndata: ${JSON.stringify(result)}\n\n`,
  end: "event: complete\ndata:\n\n",
};

const streamResponse = (framing: Framing, options: StreamOptions): Response => {
  const { first, rest, process, failure, controller, logger } = options;
  const { signal } = controller;
  /** Set once the stream has ended or was cancelled: nothing more may touch its controller. */
  let finished = false;
  /** Whether `framing.start` has been sent. */
  let started = false;
  let pendingFirst = first;
  /** The bytes of one chunk, preceded by `framing.start` in the first one. */
  const chunk = (text: string): Uint8Array => {
    const prefix = started ? "" : framing.start;
    started = true;
    return encoder.encode(prefix + text);
  };
  /** Removes the abort listener once the stream has ended. */
  const listening = new AbortController();
  let closing: Promise<void> | undefined;

  /** Closes the executor's iterator once; its own failure is not the client's concern. */
  const release = (): Promise<void> => {
    listening.abort();
    closing ??= (async () => {
      try {
        await rest?.return();
      } catch (error) {
        logger.error("gratos-server: closing a streamed result failed.", error);
      }
    })();
    return closing;
  };

  /**
   * Stops an executor that is still running: the core signal first (cooperative sources stop, a
   * pending pull rejects), then `return()`.
   */
  const stop = (): Promise<void> => {
    listening.abort();
    controller.abort();
    return release();
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start: () => {
        // A client that left while nothing reads or cancels the body still stops the executor.
        if (rest !== undefined) {
          signal.addEventListener("abort", () => void stop(), {
            once: true,
            signal: listening.signal,
          });
        }
      },
      pull: async (stream) => {
        /** Sends the last chunk and ends the stream normally. */
        const end = async (text: string): Promise<void> => {
          finished = true;
          stream.enqueue(chunk(text));
          stream.close();
          await release();
        };
        /** Fails the stream (a throwing result hook) and stops the executor. */
        const fail = async (error: unknown): Promise<void> => {
          finished = true;
          logger.error("gratos-server: a result hook failed on a streamed payload.", error);
          stream.error(error);
          await stop();
        };
        /** Sends one payload, and ends the stream after the last one. */
        const sendPayload = async (payload: StreamPayload): Promise<void> => {
          const framed = framing.frame(payload);
          if (rest === undefined || !payload.hasNext) {
            await end(framed + framing.end);
          } else {
            stream.enqueue(chunk(framed));
          }
        };

        if (pendingFirst !== undefined) {
          const payload = pendingFirst;
          pendingFirst = undefined;
          await sendPayload(payload);
          return;
        }
        if (rest === undefined || finished) {
          return;
        }
        let pulled: IteratorResult<StreamPayload, void>;
        try {
          pulled = await rest.next();
        } catch (error) {
          if (finished) {
            return;
          }
          if (signal.aborted) {
            // The client left: a cancellation, not a failure. Nothing is reported or sent.
            finished = true;
            stream.close();
            await stop();
            return;
          }
          // The source failed: its error is the last payload, through the same result hooks.
          let result: ExecutionResult;
          try {
            result = process({ errors: [failure(error)] });
          } catch (hookError) {
            await fail(hookError);
            return;
          }
          await end(framing.frame({ result, hasNext: false }) + framing.end);
          return;
        }
        if (finished) {
          return;
        }
        if (pulled.done === true) {
          await end(framing.end);
          return;
        }
        let result: ExecutionResult;
        try {
          result = process(pulled.value.result);
        } catch (hookError) {
          await fail(hookError);
          return;
        }
        await sendPayload({ result, hasNext: pulled.value.hasNext });
      },
      cancel: async () => {
        finished = true;
        await stop();
      },
    },
    { highWaterMark: 0 },
  );
  // No proxy or browser may cache or buffer a stream.
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": framing.contentType,
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
};

/** An incremental result (or a single result for a multipart-only client) as multipart/mixed. */
export const multipartResponse = (options: StreamOptions): Response =>
  streamResponse(multipartFraming, options);

/** Subscription events (or a single result for an SSE client) as GraphQL-over-SSE. */
export const sseResponse = (options: StreamOptions): Response =>
  streamResponse(sseFraming, options);
