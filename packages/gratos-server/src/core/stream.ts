// The streamed encoders (docs/plan.html M4b): incremental (`@defer`/`@stream`) results as
// multipart/mixed; deferSpec=20220824 (the format Apollo Client reads), and subscription events as
// GraphQL-over-SSE "distinct connections" (`event: next` per payload, then `event: complete`).
//
// Both share one pull loop over the executor's payloads:
// - each payload goes through the result hooks (`process`: onResult masking and reporting) before
//   it is framed;
// - a rejected pull (a source that failed) aborts the core signal, becomes a GraphQL error
//   payload, goes through the same hooks, and is sent as the final payload, then the stream ends
//   (`complete`, or the closing boundary) and the iterator's `return()` is awaited;
// - an incremental result whose payloads end after one that said `hasNext: true` gets a last
//   payload with an error and `hasNext: false`, through the same hooks, so the client (Apollo
//   Client) marks the result complete;
// - once the core signal is aborted (the client left), the body ends at once, even with a payload
//   still queued, and a rejected pull is a cancellation (graphql's AbortError, or a cancelled()
//   sentinel): it skips the hooks and nothing more is sent;
// - closing the stream early (a body cancel, or the core signal aborting) aborts the core signal
//   first, so cooperative sources stop (one waiting on `info.getAbortSignal()`), and only then
//   awaits the iterator's `return()`: a `return()` alone can wait forever on a pending pull.
import { GraphQLError } from "graphql";
import type { ExecutionResult } from "graphql";

import { DEFER_SPEC, MULTIPART_BOUNDARY, MULTIPART_MIXED, TEXT_EVENT_STREAM } from "./http.ts";
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
  /**
   * Whether the client needs a payload with `hasNext: false` before the stream ends (multipart:
   * Apollo Client marks the result complete only then).
   */
  readonly lastPayloadRequired: boolean;
}

/** The terminal payload of an incremental result that ended after a `hasNext: true` payload. */
const prematureEnd = (): ExecutionResult => ({
  errors: [new GraphQLError("The incremental result ended before its last payload.")],
});

/**
 * multipart/mixed with boundary "-". Every chunk ends with a delimiter (`\r\n---`): a client
 * that splits on the delimiter (Apollo Client) reads a part only once the delimiter after it has
 * arrived, so a part must never wait for the next one. A part therefore starts with the CRLF that
 * ends its delimiter line, and the stream ends with `--` (the close delimiter). On the wire this
 * is byte for byte Apollo Server's framing; only the chunk edges differ, so the close delimiter
 * never needs an empty part before it.
 */
const multipartFraming: Framing = {
  contentType: `${MULTIPART_MIXED}; boundary="${MULTIPART_BOUNDARY}"; deferSpec=${DEFER_SPEC}`,
  start: "\r\n---",
  frame: ({ result, hasNext }) =>
    `\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ ...result, hasNext })}\r\n---`,
  end: "--\r\n",
  lastPayloadRequired: true,
};

const sseFraming: Framing = {
  contentType: `${TEXT_EVENT_STREAM}; charset=utf-8`,
  start: "",
  frame: ({ result }) => `event: next\ndata: ${JSON.stringify(result)}\n\n`,
  end: "event: complete\ndata:\n\n",
  lastPayloadRequired: false,
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
      start: (stream) => {
        // The client left (the core signal aborted) while nothing cancelled the body: the body
        // ends at once, so nothing still queued (the initial result, a closing delimiter) goes
        // out, and the executor stops. The signal is aborted already, so `return()` comes after.
        const leave = (): void => {
          if (finished) {
            return;
          }
          finished = true;
          pendingFirst = undefined;
          stream.close();
          void stop();
        };
        if (signal.aborted) {
          leave();
          return;
        }
        signal.addEventListener("abort", leave, { once: true, signal: listening.signal });
      },
      pull: async (stream) => {
        if (finished) {
          return;
        }
        /** Sends the last chunk and ends the stream normally. */
        const end = async (text: string): Promise<void> => {
          finished = true;
          stream.enqueue(chunk(text));
          stream.close();
          await release();
        };
        /**
         * Fails the stream (a throwing result hook, a payload that cannot be serialized) and stops
         * the executor, as a cancel would: the core signal first, then `return()`.
         */
        const fail = async (message: string, error: unknown): Promise<void> => {
          finished = true;
          logger.error(message, error);
          stream.error(error);
          await stop();
        };
        /** Runs the result hooks on a payload, or fails the stream when one throws. */
        const processed = async (result: ExecutionResult): Promise<ExecutionResult | undefined> => {
          try {
            return process(result);
          } catch (hookError) {
            await fail("gratos-server: a result hook failed on a streamed payload.", hookError);
            return undefined;
          }
        };
        /**
         * Sends one payload, and ends the stream after the last one. Once the body has ended (the
         * client left while a result hook ran, say), the payload is not serialized, and a failure
         * to serialize it concerns no one.
         */
        const sendPayload = async (payload: StreamPayload): Promise<void> => {
          if (finished) {
            return;
          }
          let framed: string;
          try {
            framed = framing.frame(payload);
          } catch (error) {
            if (finished) {
              return;
            }
            // JSON.stringify throws on a bigint or a cycle (in extensions a hook added, say).
            await fail("gratos-server: a streamed payload could not be serialized.", error);
            return;
          }
          // Serializing runs user code (toJSON), which may have ended the body too.
          if (finished) {
            return;
          }
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
        if (rest === undefined) {
          return;
        }
        let pulled: IteratorResult<StreamPayload, void>;
        try {
          pulled = await rest.next();
        } catch (error) {
          // Once the client has left (the body already ended), a rejected pull is a cancellation
          // (graphql's AbortError, a cancelled() sentinel), not a failure: nothing is reported.
          if (finished) {
            return;
          }
          // The source failed. The executor is stopped as a cancel stops it: the core signal
          // first (its listener here detached, the body still sends the error), so a cleanup
          // that waits on the signal ends; `return()` comes once the last payload is sent. The
          // source's error is that last payload, through the same result hooks.
          listening.abort();
          controller.abort();
          const result = await processed({ errors: [failure(error)] });
          if (result !== undefined) {
            await sendPayload({ result, hasNext: false });
          }
          return;
        }
        if (finished) {
          return;
        }
        if (pulled.done === true) {
          if (framing.lastPayloadRequired) {
            // Every payload sent so far said `hasNext: true` (the stream ends at the first that
            // does not): the client gets a last one, with an error, through the result hooks.
            const result = await processed(prematureEnd());
            if (result !== undefined) {
              await sendPayload({ result, hasNext: false });
            }
            return;
          }
          await end(framing.end);
          return;
        }
        const result = await processed(pulled.value.result);
        if (result !== undefined) {
          await sendPayload({ result, hasNext: pulled.value.hasNext });
        }
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
