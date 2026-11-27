// @dblechoc/gratos-server: the GraphQL server core and its plugins (docs/plan.html M4a, M4b). The core
// never imports `effect`; the Effect layer is the separate `@dblechoc/gratos-server/effect` entry
// (M5, src/effect/index.ts). The jit() plugin is the `@dblechoc/gratos-server/jit` entry (src/jit.ts),
// so this entry never loads graphql-jit, an optional peer.
export { CLIENT_CLOSED_REQUEST, createServer } from "./core/server.ts";
export { mutationOf, signalOf, startOf } from "./core/requestState.ts";
export { cancelled, gqlError, httpStatusOf, isCancelled } from "./core/errors.ts";
export {
  APPLICATION_JSON,
  DEFER_SPEC,
  GRAPHQL_RESPONSE_JSON,
  MULTIPART_MIXED,
  TEXT_EVENT_STREAM,
} from "./core/http.ts";
export { isIncrementalPayload, mapPayloadErrors, payloadErrors } from "./core/payload.ts";
export type { IncrementalPayload, MappedPayload } from "./core/payload.ts";
export type {
  BaseServerOptions,
  ContextFactory,
  ContextInput,
  ContextServerOptions,
  DrainOptions,
  ExecuteInput,
  ExecutionWrapper,
  Executor,
  ExecutorResult,
  IncrementalResults,
  JsonObject,
  JsonValue,
  Logger,
  MutationState,
  NextExecutor,
  NoContextServerOptions,
  Params,
  Phase,
  PhaseName,
  Plugin,
  PromiseOrValue,
  Server,
  ServerControl,
  ServerInit,
  ServerOptions,
} from "./core/types.ts";

export { apq, sha256Hex } from "./plugins/apq.ts";
export { NoIncrementalMutationsRule } from "./core/incremental.ts";
export {
  incremental,
  usesIncrementalDelivery,
  withIncrementalDirectives,
} from "./plugins/incremental.ts";
export type { ApqOptions, ApqStore } from "./plugins/apq.ts";
export { isUnexpectedError, maskErrors } from "./plugins/maskErrors.ts";
export type { MaskErrorsOptions } from "./plugins/maskErrors.ts";
export { maxDepth, selectionDepth } from "./plugins/maxDepth.ts";
export { readOnly } from "./plugins/readOnly.ts";
export { reportErrors } from "./plugins/reportErrors.ts";
export { serverTiming } from "./plugins/serverTiming.ts";
