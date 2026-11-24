// The hook contract of the server core (docs/plan.html, M4a "Contract types"). The core has no
// Effect dependency: everything here is plain TypeScript over graphql-js and Web standards.
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLSchema,
  LegacyExperimentalIncrementalExecutionResults,
  OperationDefinitionNode,
} from "graphql";

/** A value or a Promise of it. */
export type PromiseOrValue<T> = T | Promise<T>;

/** A JSON value, as `JSON.parse` returns it. */
export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | JsonObject;

/** A JSON object, as `JSON.parse` returns it. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** The GraphQL-over-HTTP request parameters, as read from the JSON body. */
export interface Params {
  readonly query?: string | undefined;
  readonly operationName?: string | undefined;
  readonly variables?: JsonObject | undefined;
  readonly extensions?: JsonObject | undefined;
}

/** The incremental (`@defer`/`@stream`) results an executor can return (encoded from M4b). */
export type IncrementalResults = LegacyExperimentalIncrementalExecutionResults;

/** What an executor produces: one result, incremental results, or a subscription's events. */
export type ExecutorResult =
  | ExecutionResult
  | IncrementalResults
  | AsyncGenerator<ExecutionResult, void, void>;

/**
 * Runs the selected operation. `onExecute` hooks return one to claim the operation; the first
 * hook (in list order) that returns an executor wins, and the core's default runs otherwise.
 */
export type Executor = () => PromiseOrValue<ExecutorResult>;

/** The phases the core reports to `onPhase`. Plugins may report their own (jit reports `jit`). */
export type PhaseName = "parse" | "validate" | "jit" | (string & {});

/** One finished phase, in `performance.now()` milliseconds. */
export interface Phase {
  readonly name: PhaseName;
  readonly start: number;
  readonly end: number;
}

/** The first argument of `onExecute`. */
export interface ExecuteInput {
  /** The selected operation, resolved by the core after the document cache and before context. */
  readonly operation: OperationDefinitionNode;
  readonly document: DocumentNode;
  /** The operation name the client sent (not the name in the document). */
  readonly operationName: string | undefined;
  /**
   * A stable identity for (schema generation, query text, selected operation name), for as long
   * as the document stays in the cache. Plugins key their per-operation state on it (a
   * `WeakMap<object, State>`), so a document holding a mutation and a query never shares state.
   */
  readonly operationKey: object;
  /** The incoming Request (the same object every hook sees; the core never clones it). */
  readonly request: Request;
  /** Reports a phase to every `onPhase` hook (jit uses it when it compiles). */
  readonly phase: (name: PhaseName, start: number, end: number) => void;
}

/** What `onServer` receives, once, when the server is created. */
export interface ServerInit {
  readonly schema: GraphQLSchema;
  readonly control: ServerControl;
}

/**
 * A server plugin. Every hook is optional; hook lists are built once at startup, so a hook that
 * no plugin defines costs nothing. `onPhase`, `onExecute` and `onResult` run in the hot loop and
 * must be synchronous; every other hook may return a Promise.
 *
 * Ordering: `apq()` first; plugins that only observe return nothing from `onExecute`;
 * `reportErrors()` before `maskErrors()`, so the report sees the unmasked errors.
 *
 * Body rule: a plugin that replaces the Response in `onResponse` must keep `res.body`, either
 * reusing it (`new Response(res.body, …)`) or wrapping it in a pass-through stream. It must never
 * drop it, because body wrappers (such as the Effect layer's span end) depend on it. With that
 * rule, plugin order does not matter for body wrappers. A wrapping stream should pull on demand
 * (`highWaterMark: 0`) and forward `cancel` to the original body, so a client that leaves reaches
 * the core (whose signal a body cancel aborts).
 */
export interface Plugin<Ctx = unknown> {
  readonly name?: string;
  /** Turns on `hideSuggestions` for validation and execution (`maskErrors()` sets it). */
  readonly hideSuggestions?: boolean;
  /** Once, at startup. May replace the schema through `control.replaceSchema`. */
  readonly onServer?: (init: ServerInit) => PromiseOrValue<void>;
  /** First, at `handle()` entry. Returning a Response answers the request (onResponse still runs). */
  readonly onRequest?: (request: Request) => PromiseOrValue<Response | undefined | void>;
  /**
   * After the body is read, before the "no query" check (so APQ hash-only requests get here).
   * Returns replacement params, or nothing. A throw becomes a 400 GraphQL error response.
   */
  readonly onParams?: (
    params: Params,
    request: Request,
  ) => PromiseOrValue<Params | undefined | void>;
  /** A finished phase (parse and validate on a cache miss, jit when it compiles). Synchronous. */
  readonly onPhase?: (phase: Phase, request: Request) => void;
  /** After the context factory, once the operation is known, before anything executes. */
  readonly onContext?: (
    ctx: Ctx,
    request: Request,
    operation: OperationDefinitionNode,
  ) => PromiseOrValue<void>;
  /**
   * Claims the operation by returning an executor, or returns nothing. Synchronous. A thrown
   * GraphQLError refuses the operation with that error (status from `gqlError`, else 400).
   */
  readonly onExecute?: (input: ExecuteInput, args: ExecutionArgs) => Executor | undefined | void;
  /**
   * Every payload an executor produces: the initial result, a subsequent incremental payload, or
   * a subscription event. Returns a replacement payload, or nothing. Synchronous.
   */
  readonly onResult?: (
    payload: ExecutionResult,
    ctx: Ctx,
    request: Request,
  ) => ExecutionResult | undefined | void;
  /**
   * Exactly once per request, on the Response before it goes to the transport (also for streamed
   * responses, whose headers it can still change). Not a "stream finished" hook. Returns a
   * replacement Response (which must keep `res.body`, see above), or nothing.
   */
  readonly onResponse?: (
    response: Response,
    request: Request,
    ctx: Ctx | undefined,
  ) => PromiseOrValue<Response | undefined | void>;
}

/** What the context factory receives besides the Request. */
export interface ContextInput {
  readonly operation: OperationDefinitionNode;
  readonly document: DocumentNode;
  readonly params: Params;
}

/** Logging used by the core (drain warnings, failing hooks). Defaults to `console`. */
export interface Logger {
  readonly warn: (message: string, details?: unknown) => void;
  readonly error: (message: string, details?: unknown) => void;
}

export interface ServerOptions<Ctx> {
  readonly schema: GraphQLSchema;
  /** Builds the per-request context, after the operation is resolved. Defaults to `undefined`. */
  readonly context?: (request: Request, input: ContextInput) => PromiseOrValue<Ctx>;
  readonly plugins?: ReadonlyArray<Plugin<Ctx>>;
  readonly rootValue?: unknown;
  /** Size of the validated-document LRU. Default 1000. */
  readonly documentCacheSize?: number;
  /** Maximum lexical tokens per document (graphql's `maxLexicalTokens`). Default 10000. */
  readonly maxTokens?: number;
  readonly logger?: Logger;
}

export interface DrainOptions {
  /**
   * Logs the still-running mutations once this many milliseconds have passed, then again every
   * `warnAfterMs` while the drain is blocked. It only reports: the drain has no deadline.
   */
  readonly warnAfterMs?: number;
}

export interface ServerControl {
  /** The current schema (the one new requests pin). */
  readonly schema: () => GraphQLSchema;
  /** The current schema generation. */
  readonly generation: () => number;
  /**
   * Starts a new schema generation. In-flight requests finish on the generation they pinned at
   * `handle()` entry; new requests use the new schema and a fresh set of cached documents.
   */
  readonly replaceSchema: (schema: GraphQLSchema) => void;
  /**
   * Stops accepting new mutations (they get a 503 `SERVER_DRAINING`) and resolves once every
   * tracked mutation has settled. There is no deadline.
   */
  readonly drain: (options?: DrainOptions) => Promise<void>;
  /** True once `drain()` has been called. */
  readonly draining: () => boolean;
}

export interface Server {
  readonly handle: (request: Request) => Promise<Response>;
  readonly control: ServerControl;
}

/** The mutation state of a request, from `mutationOf(req)`. */
export interface MutationState {
  /**
   * Resolves `true` just before the executor is called, or `false` on every path that never
   * calls it (refused while draining, client gone before the start, a failing context factory…).
   */
  readonly started: Promise<boolean>;
  /** Resolves when the mutation's execution has settled, or at once when it never started. */
  readonly settled: Promise<void>;
}
