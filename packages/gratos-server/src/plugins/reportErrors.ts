// reportErrors(log): hands every error of every execution payload to `log`, with the request's
// context: a result's errors, those of each incremental entry, and those of each subscription
// event (including the error a failing source ends with). It sees results only (the core skips
// it when the client has gone and execution was aborted), and skips `cancelled()` errors (work
// stopped because the client left, such as an Effect resolver interrupted on the abort, which a
// custom executor that ignores the signal still puts in its result). List it before
// maskErrors() so it sees the unmasked errors.
import type { GraphQLError } from "graphql";

import { isCancelled } from "../core/errors.ts";
import { payloadErrors } from "../core/payload.ts";
import type { Plugin } from "../core/types.ts";

export const reportErrors = <Ctx = unknown>(
  log: (error: GraphQLError, ctx: Ctx, request: Request) => void,
): Plugin<Ctx> => ({
  name: "reportErrors",
  onResult: (payload, ctx, request) => {
    for (const error of payloadErrors(payload)) {
      if (!isCancelled(error)) {
        log(error, ctx, request);
      }
    }
    return undefined;
  },
});
