// maskErrors(): replaces the message of every unexpected error (one whose original error is not a
// GraphQLError, such as a plain Error thrown by a resolver) with a generic one, keeping its path
// and locations and dropping its extensions. Errors raised on purpose (a GraphQLError, gqlError)
// pass unchanged. It also turns on hideSuggestions for validation and execution.
import { GraphQLError } from "graphql";

import type { Plugin } from "../core/types.ts";

export interface MaskErrorsOptions {
  /** The message unexpected errors get. Default "Unexpected error." */
  readonly message?: string;
}

/** True when the error was not raised on purpose. */
export const isUnexpectedError = (error: GraphQLError): boolean =>
  error.originalError !== undefined && !(error.originalError instanceof GraphQLError);

export const maskErrors = (options: MaskErrorsOptions = {}): Plugin => {
  const message = options.message ?? "Unexpected error.";
  return {
    name: "maskErrors",
    hideSuggestions: true,
    onResult: (payload) => {
      const { errors } = payload;
      if (errors === undefined || !errors.some(isUnexpectedError)) {
        return undefined;
      }
      return {
        ...payload,
        errors: errors.map((error) =>
          isUnexpectedError(error)
            ? new GraphQLError(message, {
                nodes: error.nodes,
                source: error.source,
                positions: error.positions,
                path: error.path,
              })
            : error,
        ),
      };
    },
  };
};
