// reportErrors(log): hands every error of every execution payload to `log`, with the request's
// context: a result's errors, those of each incremental entry, and those of each subscription
// event (including the error a failing source ends with). It sees results only (the core skips
// it when the client has gone and execution was aborted). List it before maskErrors() so it sees
// the unmasked errors.
import type { GraphQLError } from "graphql";

import { payloadErrors } from "../core/payload.ts";
import type { Plugin } from "../core/types.ts";

export const reportErrors = <Ctx = unknown>(
  log: (error: GraphQLError, ctx: Ctx, request: Request) => void,
): Plugin<Ctx> => ({
  name: "reportErrors",
  onResult: (payload, ctx, request) => {
    for (const error of payloadErrors(payload)) {
      log(error, ctx, request);
    }
    return undefined;
  },
});
