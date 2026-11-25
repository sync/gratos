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

/** Splits an SSE body into its events. */
export const parseSse = (text: string): Array<SseEvent> =>
  text
    .split("\n\n")
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

/** The JSON payloads of a multipart/mixed body with boundary "-". */
export const readMultipart = (text: string): Array<WirePayload> =>
  text
    .split("\r\n---")
    .map((part) => part.slice(part.indexOf("\r\n\r\n") + 4))
    .filter((part) => part.startsWith("{"))
    .map((part) => parsePayload(part.trim()));

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
  readonly close: () => Promise<void>;
}

/**
 * Serves `handle(Request)` over node:http. Like the Effect platform's server, a client that
 * leaves before the Response exists aborts the Request's signal; once the Response is being
 * written, a disconnect is visible only as a cancel of its body (the pipeline destroys the
 * readable, which cancels the web stream).
 */
export const listen = async (server: Server): Promise<Listening> => {
  const http = createHttpServer((req, res) => {
    void (async () => {
      const controller = new AbortController();
      let responded = false;
      res.on("close", () => {
        if (!responded) {
          controller.abort();
        }
      });
      const bytes = await buffer(req);
      const method = req.method ?? "GET";
      const init: RequestInit = {
        method,
        headers: toHeaders(req.headers),
        signal: controller.signal,
      };
      if (method !== "GET" && method !== "HEAD") {
        init.body = bytes;
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
      try {
        await pipeline(Readable.fromWeb(response.body), res);
      } catch {
        // The client left mid-body: the pipeline cancelled the body.
      }
    })();
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
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
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
