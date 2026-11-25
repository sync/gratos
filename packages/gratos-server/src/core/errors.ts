import { GraphQLError } from "graphql";
import type { GraphQLErrorExtensions } from "graphql";

/**
 * A GraphQL error that carries an HTTP status in `extensions.http.status`. The status changes the
 * response's HTTP status only when the result has no data (`data` absent or null). A status outside
 * 200–599, or one that cannot carry the JSON body (204, 205, 304), is ignored.
 */
export const gqlError = (
  message: string,
  status: number,
  extensions: GraphQLErrorExtensions = {},
): GraphQLError => new GraphQLError(message, { extensions: { ...extensions, http: { status } } });

/** Statuses whose Response cannot carry a body (the Response constructor throws for one). */
const BODILESS = new Set([204, 205, 304]);

/**
 * The `extensions.http.status` of an error, if it carries a valid one: an integer in 200–599 that
 * can carry the JSON body of a GraphQL response (not 204, 205 or 304).
 */
export const httpStatusOf = (error: { readonly extensions?: unknown }): number | undefined => {
  const { extensions } = error;
  const http =
    typeof extensions === "object" && extensions !== null && "http" in extensions
      ? extensions.http
      : undefined;
  const status =
    typeof http === "object" && http !== null && "status" in http ? http.status : undefined;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 599 &&
    !BODILESS.has(status)
    ? status
    : undefined;
};

/** The first HTTP status carried by one of the errors. */
export const statusFromErrors = (
  errors: ReadonlyArray<{ readonly extensions?: unknown }> | undefined,
): number | undefined => {
  for (const error of errors ?? []) {
    const status = httpStatusOf(error);
    if (status !== undefined) {
      return status;
    }
  }
  return undefined;
};

/** A thrown value as a GraphQLError: GraphQLErrors as they are, anything else under `message`. */
export const asGraphQLError = (error: unknown, message: string): GraphQLError =>
  error instanceof GraphQLError
    ? error
    : new GraphQLError(message, { originalError: error instanceof Error ? error : undefined });

/** The draining refusal of a mutation (docs/plan.html appendix, M4a). */
export const serverDraining = (): GraphQLError =>
  gqlError("The server is shutting down and accepts no new mutations.", 503, {
    code: "SERVER_DRAINING",
  });

/** The errors made by `cancelled()`. */
const cancellations = new WeakSet<object>();

/**
 * The sentinel for work stopped because the client left (docs/plan.html M5): a resolver
 * interrupted on a client abort rejects with it. It is not a failure: `reportErrors()` and the
 * Effect layer's error counter skip it, wherever graphql-js puts it (as the error itself, or as
 * the `originalError` of the located error it builds).
 */
export const cancelled = (): GraphQLError => {
  const error = new GraphQLError("The client closed the request.", {
    extensions: { code: "CLIENT_CLOSED_REQUEST" },
  });
  cancellations.add(error);
  return error;
};

/** True for a `cancelled()` error, or a GraphQL error located from one. */
export const isCancelled = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (cancellations.has(error) ||
    ("originalError" in error &&
      typeof error.originalError === "object" &&
      error.originalError !== null &&
      cancellations.has(error.originalError)));
