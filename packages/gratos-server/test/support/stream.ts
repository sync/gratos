// Helpers for streamed responses: GraphQL-over-SSE and multipart/mixed readers, and a plain
// node:http adapter (no Effect) that serves `handle(Request)` over a real socket.
import { createServer as createHttpServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";

import type { Server } from "../../src/index.ts";
import type { WireBody, WireError } from "./http.ts";

/** One entry of a subsequent incremental payload. */
export interface WireIncremental {
  readonly data?: unknown;
  readonly items?: ReadonlyArray<unknown>;
  readonly errors?: ReadonlyArray<WireError>;
  readonly path: ReadonlyArray<string | number>;
  readonly label?: string;
}

/** A streamed payload: a result, or a subsequent incremental payload. */
export interface WirePayload extends WireBody {
  readonly incremental?: ReadonlyArray<WireIncremental>;
  readonly hasNext?: boolean;
}

/** One server-sent event. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Splits an SSE body into its events. Only events terminated by a blank line count, as a client
 * dispatches an event only then: an unterminated trailing block (a partial read) is ignored.
 */
export const parseSse = (text: string): Array<SseEvent> =>
  text
    .split("\n\n")
    .slice(0, -1)
    .filter((block) => block !== "")
    .map((block) => {
      let event = "message";
      const data: Array<string> = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice("data:".length).trimStart());
        }
      }
      return { event, data: data.join("\n") };
    });

const isWirePayload = (value: unknown): value is WirePayload =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a JSON payload (an SSE `next` event, a multipart part). */
export const parsePayload = (text: string): WirePayload => {
  const parsed: unknown = JSON.parse(text);
  if (!isWirePayload(parsed)) {
    throw new Error(`Not a GraphQL payload: ${text}`);
  }
  return parsed;
};

/** The payloads of the `next` events, and the name of every event in order. */
export const readSse = (text: string) => {
  const events = parseSse(text);
  return {
    names: events.map(({ event }) => event),
    payloads: events.filter(({ event }) => event === "next").map(({ data }) => parsePayload(data)),
  };
};

/** The multipart/mixed delimiter for boundary "-", as Apollo Client searches for it. */
const DELIMITER = "\r\n---";

/** What Apollo Client has read of a multipart/mixed body. */
export interface ApolloMultipart {
  readonly parts: Array<WirePayload>;
  readonly closed: boolean;
}

/**
 * Reads a multipart/mixed body (boundary "-") the way Apollo Client 4.1 does
 * (`consumeMultipartBody` in link/http/parseAndCheckHttpResponse.js): a part is delivered only
 * once the delimiter after it has arrived, and the body ends at the close delimiter (`--` right
 * after a delimiter). `parts` are the payloads a client holding `text` so far has delivered;
 * `closed` says whether it saw the close delimiter.
 */
export const readApolloMultipart = (text: string): ApolloMultipart => {
  const parts: Array<WirePayload> = [];
  let buffer = text;
  let encountered = false;
  const passedFinal = () => encountered && buffer.startsWith("--");
  let index = buffer.indexOf(DELIMITER);
  while (index > -1 && !passedFinal()) {
    encountered = true;
    const message = buffer.slice(0, index);
    buffer = buffer.slice(index + DELIMITER.length);
    const headersEnd = message.indexOf("\r\n\r\n");
    const body = message.slice(headersEnd);
    if (body !== "") {
      if (!message.slice(0, headersEnd).toLowerCase().includes("content-type: application/json")) {
        throw new Error(`A part without a JSON content type: ${JSON.stringify(message)}`);
      }
      parts.push(parsePayload(body.trim()));
    }
    index = buffer.indexOf(DELIMITER);
  }
  return { parts, closed: passedFinal() };
};

/** The JSON payloads Apollo Client delivers from a multipart/mixed body (boundary "-"). */
export const readMultipart = (text: string): Array<WirePayload> => readApolloMultipart(text).parts;

/** Every error of a payload: its own, then those of each incremental entry. */
export const wireErrors = (payload: WirePayload): ReadonlyArray<WireError> => [
  ...(payload.errors ?? []),
  ...(payload.incremental ?? []).flatMap((entry) => entry.errors ?? []),
];

/** Reads a body chunk by chunk until `until(text so far)` holds, and returns the text. */
export const readUntil = async (
  body: ReadableStream<Uint8Array>,
  until: (text: string) => boolean,
): Promise<{ readonly text: string; readonly reader: ReadableStreamDefaultReader<Uint8Array> }> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!until(text)) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text, reader };
};

const toHeaders = (incoming: IncomingHttpHeaders): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        headers.append(name, item);
      }
    }
  }
  return headers;
};

/** A running node:http server and the URL of its GraphQL endpoint. */
export interface Listening {
  readonly url: string;
  /** Stops the server; rejects with what failed in the adapter itself, if anything did. */
  readonly close: () => Promise<void>;
}

export interface ListenOptions {
  /**
   * Hands `handle` the request body as a stream (`Readable.toWeb`) instead of buffering it
   * first, as NodeHttpServer's route does: the core reads it as it arrives, and a client still
   * uploading reaches `handle`.
   */
  readonly streamBody?: boolean;
}

/**
 * Serves `handle(Request)` over node:http. Like the Effect platform's server, a client that
 * leaves before the Response exists aborts the Request's signal; once the Response is being
 * written, a disconnect is visible only as a cancel of its body (the pipeline destroys the
 * readable, which cancels the web stream). With the body buffered (the default), a client that
 * leaves during its upload is a cancellation: its request never reaches `handle`. Any other
 * failure of the adapter fails the test through `close()`, told apart by where it came from (not
 * by the final socket state: a body error makes the pipeline destroy the socket too).
 */
export const listen = async (server: Server, options: ListenOptions = {}): Promise<Listening> => {
  const failures: Array<unknown> = [];
  const http = createHttpServer((req, res) => {
    const controller = new AbortController();
    let responded = false;
    /** The Response body itself errored: an adapter failure, whatever the socket's state after. */
    let bodyFailed = false;
    /** The client left: its socket closed before the response finished (not a body error). */
    let clientLeft = false;
    req.on("aborted", () => {
      clientLeft = true;
    });
    res.on("close", () => {
      if (!res.writableFinished && !bodyFailed) {
        clientLeft = true;
      }
      if (!responded) {
        controller.abort();
      }
    });

    const serve = async (): Promise<void> => {
      const method = req.method ?? "GET";
      const init: RequestInit & { duplex?: "half" } = {
        method,
        headers: toHeaders(req.headers),
        signal: controller.signal,
      };
      if (options.streamBody === true) {
        if (method !== "GET" && method !== "HEAD") {
          init.body = Readable.toWeb(req);
          init.duplex = "half";
        }
      } else {
        const bytes = await buffer(req);
        if (method !== "GET" && method !== "HEAD") {
          init.body = bytes;
        }
      }
      const request = new Request(`http://localhost${req.url ?? "/"}`, init);
      const response = await server.handle(request);
      responded = true;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body === null) {
        res.end();
        return;
      }
      res.flushHeaders();
      const readable = Readable.fromWeb(response.body);
      readable.once("error", () => {
        // Recorded before the pipeline tears the response (and its socket) down.
        if (!clientLeft) {
          bodyFailed = true;
        }
      });
      await pipeline(readable, res);
    };
    serve().catch((error: unknown) => {
      if (clientLeft && !bodyFailed) {
        // A cancellation: the client left (during the upload, or mid-body).
        return;
      }
      failures.push(error);
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("node:http is not listening on a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    close: async () => {
      await new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      });
      if (failures.length > 0) {
        throw new AggregateError(failures, "the node:http adapter failed");
      }
    },
  };
};

/** POSTs a GraphQL request over the network with fetch. */
export const fetchGraphQL = (
  url: string,
  body: unknown,
  options: { readonly accept: string; readonly signal?: AbortSignal },
): Promise<Response> => {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", accept: options.accept },
    body: JSON.stringify(body),
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  return fetch(url, init);
};
