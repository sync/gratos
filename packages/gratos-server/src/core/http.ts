// GraphQL-over-HTTP for the JSON path (docs/plan.html M4a, "HTTP matrix"): POST only, JSON
// bodies, Accept negotiation between application/graphql-response+json (the default) and
// application/json, and the status rules for each.
import type { ExecutionResult, GraphQLError } from "graphql";

import { statusFromErrors } from "./errors.ts";
import type { JsonObject, JsonValue, Params } from "./types.ts";

export const GRAPHQL_RESPONSE_JSON = "application/graphql-response+json";
export const APPLICATION_JSON = "application/json";

export type MediaType = typeof GRAPHQL_RESPONSE_JSON | typeof APPLICATION_JSON;

const SUPPORTED: ReadonlyArray<MediaType> = [GRAPHQL_RESPONSE_JSON, APPLICATION_JSON];

/** 0 when the range does not name the type, else its rank (3 exact, 2 type/*, 1 star/star). */
const rangeRank = (range: string, mediaType: MediaType): number => {
  if (range === mediaType) {
    return 3;
  }
  if (range === "application/*") {
    return 2;
  }
  return range === "*/*" ? 1 : 0;
};

/** The charset the core encodes in (`utf-8`, also spelt `utf8`). */
const UTF8 = /^utf-?8$/;

/** A quoted-string's content: the quotes removed and each backslash escape read as the escaped character. */
const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replaceAll(/\\(.)/g, "$1")
    : value;

/**
 * Splits a header value on `separator`, except inside a quoted-string (RFC 9110 §5.6.4), where a
 * backslash escapes the next character. A comma in a quoted parameter value therefore stays in
 * its media range.
 */
const splitOutsideQuotes = (value: string, separator: "," | ";"): Array<string> => {
  const parts: Array<string> = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
    } else if (quoted && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
};

/** One media range of an Accept header. */
interface MediaRange {
  readonly range: string;
  /** The `charset` parameter, lowercased and unquoted, when the range names one. */
  readonly charset: string | undefined;
  /** A parameter other than `charset` and `q`, which no representation of the core carries. */
  readonly hasOtherParameters: boolean;
  readonly quality: number;
}

const parseRange = (part: string): MediaRange => {
  const [range = "", ...pieces] = splitOutsideQuotes(part, ";").map((piece) =>
    piece.trim().toLowerCase(),
  );
  let charset: string | undefined;
  let hasOtherParameters = false;
  let quality = 1;
  // Every parameter is read, wherever `q` sits: clients write `charset` after `q` too.
  for (const piece of pieces) {
    const equals = piece.indexOf("=");
    const name = (equals === -1 ? piece : piece.slice(0, equals)).trim();
    const value = unquote(equals === -1 ? "" : piece.slice(equals + 1).trim());
    if (name === "") {
      continue;
    }
    if (name === "q") {
      const parsed = Number(value);
      quality = Number.isFinite(parsed) ? parsed : 0;
    } else if (name === "charset") {
      charset = value;
    } else {
      hasOtherParameters = true;
    }
  }
  return { range, charset, hasOtherParameters, quality };
};

/**
 * 0 when the range does not match the type as the core sends it (`; charset=utf-8`), else its
 * specificity: the rank, doubled, plus one when the range names the charset (RFC 9110 §12.5.1: a
 * more specific range takes precedence). A range with a charset other than utf-8, or with any
 * other parameter (the core's representations carry none), does not match, so it can neither
 * accept nor, with q=0, refuse what the core sends.
 */
const specificity = (
  { range, charset, hasOtherParameters }: MediaRange,
  mediaType: MediaType,
): number => {
  const rank = rangeRank(range, mediaType);
  if (rank === 0 || hasOtherParameters || (charset !== undefined && !UTF8.test(charset))) {
    return 0;
  }
  return rank * 2 + (charset === undefined ? 0 : 1);
};

/**
 * Picks the response media type from an Accept header: the supported type with the highest
 * quality (taken from its most specific matching range), preferring
 * application/graphql-response+json on ties. A range asking for a charset other than utf-8 does
 * not match. No Accept header means the default. `undefined` means nothing acceptable (406).
 */
export const negotiate = (accept: string | null): MediaType | undefined => {
  if (accept === null || accept.trim() === "") {
    return GRAPHQL_RESPONSE_JSON;
  }
  const ranges = splitOutsideQuotes(accept, ",").map(parseRange);
  let best: { mediaType: MediaType; quality: number } | undefined;
  for (const mediaType of SUPPORTED) {
    let matched: { quality: number; specificity: number } | undefined;
    for (const range of ranges) {
      const rank = specificity(range, mediaType);
      if (rank > 0 && (matched === undefined || rank > matched.specificity)) {
        matched = { quality: range.quality, specificity: rank };
      }
    }
    if (matched !== undefined && matched.quality > 0) {
      if (best === undefined || matched.quality > best.quality) {
        best = { mediaType, quality: matched.quality };
      }
    }
  }
  return best?.mediaType;
};

/** True when the Content-Type is application/json (any parameters). */
export const isJsonContentType = (contentType: string | null): boolean =>
  contentType !== null &&
  (contentType.split(";")[0] ?? "").trim().toLowerCase() === APPLICATION_JSON;

/** Why a body is not a well-formed GraphQL-over-HTTP request, or the params it holds. */
export type ReadParams =
  | { readonly _tag: "ok"; readonly params: Params }
  | { readonly _tag: "bad"; readonly message: string };

const isString = (value: JsonValue | undefined): value is string => typeof value === "string";

/** A JSON object (the value comes from `JSON.parse`, so any plain object is one). */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A member that may be absent or null, else must pass `is`. */
const optional = <T extends JsonValue>(
  body: JsonObject,
  key: string,
  is: (value: JsonValue | undefined) => value is T,
): { readonly ok: true; readonly value: T | undefined } | { readonly ok: false } => {
  const value = body[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  return is(value) ? { ok: true, value } : { ok: false };
};

/** Reads and checks the JSON body. */
export const readParams = async (request: Request): Promise<ReadParams> => {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return { _tag: "bad", message: "The request body is not valid JSON." };
  }
  if (!isJsonObject(body)) {
    return { _tag: "bad", message: "The request body must be a JSON object." };
  }
  const query = optional(body, "query", isString);
  if (!query.ok) {
    return { _tag: "bad", message: "`query` must be a string." };
  }
  const operationName = optional(body, "operationName", isString);
  if (!operationName.ok) {
    return { _tag: "bad", message: "`operationName` must be a string." };
  }
  const variables = optional(body, "variables", isJsonObject);
  if (!variables.ok) {
    return { _tag: "bad", message: "`variables` must be an object." };
  }
  const extensions = optional(body, "extensions", isJsonObject);
  if (!extensions.ok) {
    return { _tag: "bad", message: "`extensions` must be an object." };
  }
  return {
    _tag: "ok",
    params: {
      query: query.value,
      operationName: operationName.value,
      variables: variables.value,
      extensions: extensions.value,
    },
  };
};

/**
 * The HTTP status of a single result. A `gqlError` status applies when there is no data (absent
 * or null). Otherwise: under application/graphql-response+json a result without `data` (parse,
 * validation, variable-coercion or refusal errors) is a 400, and any result with a `data` entry
 * is a 200; under application/json every well-formed request gets 200.
 */
export const statusOf = (result: ExecutionResult, mediaType: MediaType): number => {
  const hasData = "data" in result && result.data !== undefined;
  if (!hasData || result.data === null) {
    const status = statusFromErrors(result.errors);
    if (status !== undefined) {
      return status;
    }
  }
  if (mediaType === GRAPHQL_RESPONSE_JSON && !hasData) {
    return 400;
  }
  return 200;
};

/**
 * A one-chunk JSON body that calls `onCancel` when the consumer cancels it. It is pulled only on
 * demand (highWaterMark 0), so a cancel that comes before the transport reads still reaches it.
 */
const jsonBody = (text: string, onCancel: () => void): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
      cancel: () => {
        onCancel();
      },
    },
    { highWaterMark: 0 },
  );
};

export const jsonResponse = (
  result: ExecutionResult,
  status: number,
  mediaType: MediaType,
  onCancel: () => void,
): Response =>
  new Response(jsonBody(JSON.stringify(result), onCancel), {
    status,
    headers: { "content-type": `${mediaType}; charset=utf-8` },
  });

/** An errors-only result. */
export const errorResult = (errors: ReadonlyArray<GraphQLError>): ExecutionResult => ({ errors });
