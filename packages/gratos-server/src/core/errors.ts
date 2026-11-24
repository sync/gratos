import { GraphQLError } from "graphql";
import type { GraphQLErrorExtensions } from "graphql";

/**
 * A GraphQL error that carries an HTTP status in `extensions.http.status`. The status changes the
 * response's HTTP status only when the result has no data (`data` absent or null).
 */
export const gqlError = (
  message: string,
  status: number,
  extensions: GraphQLErrorExtensions = {},
): GraphQLError => new GraphQLError(message, { extensions: { ...extensions, http: { status } } });

/** The `extensions.http.status` of an error, if it carries a valid one. */
export const httpStatusOf = (error: { readonly extensions?: unknown }): number | undefined => {
  const { extensions } = error;
  const http =
    typeof extensions === "object" && extensions !== null && "http" in extensions
      ? extensions.http
      : undefined;
  const status =
    typeof http === "object" && http !== null && "status" in http ? http.status : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 200 && status <= 599
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
