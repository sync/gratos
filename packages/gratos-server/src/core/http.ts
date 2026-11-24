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

/** 0 when the range does not match, else its specificity (3 exact, 2 type/*, 1 star/star). */
const specificity = (range: string, mediaType: MediaType): number => {
  if (range === mediaType) {
    return 3;
  }
  if (range === "application/*") {
    return 2;
  }
  return range === "*/*" ? 1 : 0;
};

/**
 * Picks the response media type from an Accept header: the supported type with the highest
 * quality (taken from its most specific matching range), preferring
 * application/graphql-response+json on ties. No Accept header means the default. `undefined`
 * means nothing acceptable (406).
 */
export const negotiate = (accept: string | null): MediaType | undefined => {
  if (accept === null || accept.trim() === "") {
    return GRAPHQL_RESPONSE_JSON;
  }
  const ranges = accept.split(",").map((part) => {
    const [range = "", ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase());
    const q = parameters.find((parameter) => parameter.startsWith("q="));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    return { range, quality: Number.isFinite(quality) ? quality : 0 };
  });
  let best: { mediaType: MediaType; quality: number } | undefined;
  for (const mediaType of SUPPORTED) {
    let matched: { quality: number; specificity: number } | undefined;
    for (const { range, quality } of ranges) {
      const rank = specificity(range, mediaType);
      if (rank > 0 && (matched === undefined || rank > matched.specificity)) {
        matched = { quality, specificity: rank };
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
