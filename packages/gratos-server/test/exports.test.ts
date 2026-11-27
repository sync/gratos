// The package's public entries export exactly these values (docs/plan.html F5): the core's abort
// reasons (core/abortReason.ts) and the Effect layer's RequestEnded annotation stay internal until
// publishing decides a public API, and any new export has to be added here on purpose.
import { describe, expect, it } from "vitest";

/** The names a module exports, sorted. */
const exportsOf = async (load: () => Promise<object>): Promise<Array<string>> =>
  Object.keys(await load()).toSorted();

describe("@dblechoc/gratos-server's public entries", () => {
  it("export only the listed values from the core entry, no abort reason", async () => {
    expect(await exportsOf(() => import("../src/index.ts"))).toEqual([
      "APPLICATION_JSON",
      "CLIENT_CLOSED_REQUEST",
      "DEFER_SPEC",
      "GRAPHQL_RESPONSE_JSON",
      "MULTIPART_MIXED",
      "NoIncrementalMutationsRule",
      "TEXT_EVENT_STREAM",
      "apq",
      "cancelled",
      "createServer",
      "gqlError",
      "httpStatusOf",
      "incremental",
      "isCancelled",
      "isIncrementalPayload",
      "isJitDisabled",
      "isSelectionSafe",
      "isUnexpectedError",
      "jit",
      "mapPayloadErrors",
      "maskErrors",
      "maxDepth",
      "mutationOf",
      "payloadErrors",
      "readOnly",
      "reportErrors",
      "selectionDepth",
      "serverTiming",
      "sha256Hex",
      "signalOf",
      "startOf",
      "usesIncrementalDelivery",
      "usesOneOfVariable",
      "withIncrementalDirectives",
    ]);
  });

  it("export only the listed values from the Effect entry, no internal annotation", async () => {
    expect(await exportsOf(() => import("../src/effect/index.ts"))).toEqual([
      "GuardTimeout",
      "OperationType",
      "ResolverDefect",
      "effect",
      "effectRoute",
      "effectRouteLayer",
      "effectSchema",
      "fromCause",
      "isGuardTimeout",
      "makeGuard",
      "runInRequest",
      "wrapSubscribe",
    ]);
  });
});
