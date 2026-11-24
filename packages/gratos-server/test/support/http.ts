// Request helpers for driving `handle(Request)` directly.
import type { JsonObject, JsonValue, Server } from "../../src/index.ts";

export const URL_ = "http://localhost/graphql";

export interface PostOptions {
  readonly accept?: string | null;
  readonly contentType?: string | null;
  readonly signal?: AbortSignal;
}

/**
 * A POST with a JSON body (or a raw string body). With `contentType: null` the body is sent as
 * bytes, so the Request has no Content-Type at all (a string body would get `text/plain`).
 */
export const post = (body: unknown, options: PostOptions = {}): Request => {
  const headers = new Headers();
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }
  if (options.accept !== undefined && options.accept !== null) {
    headers.set("accept", options.accept);
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const init: RequestInit = {
    method: "POST",
    headers,
    body: contentType === null ? new TextEncoder().encode(text) : text,
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  return new Request(URL_, init);
};

/** A GraphQL error as it travels on the wire. */
export interface WireError {
  readonly message: string;
  readonly path?: ReadonlyArray<string | number>;
  readonly locations?: ReadonlyArray<{ readonly line: number; readonly column: number }>;
  readonly extensions?: JsonObject;
}

/** A GraphQL response body. */
export interface WireBody {
  readonly data?: JsonValue;
  readonly errors?: ReadonlyArray<WireError>;
  readonly extensions?: JsonObject;
}

export interface Sent {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed body, or null for an empty body. */
  readonly body: WireBody | null;
  /** The first GraphQL error of the body. */
  readonly error: WireError | undefined;
}

const isWireBody = (value: unknown): value is WireBody =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sends a request and reads the JSON body. */
export const send = async (server: Server, request: Request): Promise<Sent> => {
  const response = await server.handle(request);
  const text = await response.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  if (parsed !== null && !isWireBody(parsed)) {
    throw new Error(`Not a GraphQL response body: ${text}`);
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parsed,
    error: parsed?.errors?.[0],
  };
};

/** Sends `{ query, variables, operationName }`. */
export const gql = (
  server: Server,
  query: string,
  extra: { variables?: unknown; operationName?: string } & PostOptions = {},
): Promise<Sent> => {
  const { variables, operationName, ...options } = extra;
  return send(server, post({ query, variables, operationName }, options));
};

/** A promise plus its resolve, for holding resolvers and context factories. */
export const gate = <T = void>() => Promise.withResolvers<T>();

/** Lets pending microtasks and immediate callbacks run. */
export const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Waits `ms` milliseconds. */
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
