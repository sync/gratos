// The hook contract of the server core (docs/plan.html, M4a "Contract types"). The core has no
// Effect dependency: everything here is plain TypeScript over graphql-js and Web standards.
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLSchema,
  LegacyExperimentalIncrementalExecutionResults,
  OperationDefinitionNode,
  ValidationRule,
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

/**
 * The incremental (`@defer`/`@stream`) results an executor can return, in graphql 17's legacy
 * format (`legacyExecuteIncrementally`), sent as multipart/mixed; deferSpec=20220824.
 */
export type IncrementalResults = LegacyExperimentalIncrementalExecutionResults;

/** What an executor produces: one result, incremental results, or a subscription's events. */
export type ExecutorResult =
  | ExecutionResult
  | IncrementalResults
  | AsyncGenerator<ExecutionResult, void, void>;

/** Runs the operation the way it would run without the current executor. */
export type NextExecutor = () => PromiseOrValue<ExecutorResult>;

/**
 * Runs the selected operation. `onExecute` hooks return one to claim the operation; the first
 * executor returned (in list order) wins, and the core's default runs when no hook claims it. A
 * subscription is never claimed: it always runs through graphql-js `subscribe()`.
 * The core calls it only once every onExecute hook has run without refusing and the gate (drain,
 * no late start) has passed. `next` runs the operation as it would run without this executor:
 * the next claim in list order, else the default. An executor that only sometimes takes over
 * (jit during warm-up) delegates to it, and keeps its own bookkeeping (counting, compiling) in
 * the executor, so an operation that is refused never touches it. A mutation's result must be
 * a single result: a streamed one is closed unread and the request fails with a 500, since its
 * work would outlive `mutationOf(req).settled` and `drain()`.
 */
export type Executor = (next: NextExecutor) => PromiseOrValue<ExecutorResult>;

/** The phases the core reports to `onPhase`. Plugins may report their own (jit reports `jit`). */
export type PhaseName = "parse" | "validate" | "jit" | (string & {});

/** One finished phase, in `performance.now()` milliseconds. */
export interface Phase {
  readonly name: PhaseName;
  readonly start: number;
  readonly end: number;
}

/** A plugin's `wrapExecution`: runs `run` once, synchronously, and returns its result. */
export type ExecutionWrapper = <T>(request: Request, run: () => T) => T;

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
 * Ordering: `apq()` first; plugins that only observe or refuse return nothing from `onExecute`;
 * among executors the first claim wins (`incremental()` before `jit()`); `reportErrors()` before
 * `maskErrors()`, so the report sees the unmasked errors. Refusals do not depend on order: every
 * onExecute hook runs before any executor is called.
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
  /**
   * Validation rules run with graphql's specified rules on every document the cache does not hold
   * yet. Read once, at startup. (The core adds `NoIncrementalMutationsRule` itself on a schema that
   * declares @defer or @stream.)
   */
  readonly validationRules?: ReadonlyArray<ValidationRule>;
  /** Once, at startup. May replace the schema through `control.replaceSchema`. */
  readonly onServer?: (init: ServerInit) => PromiseOrValue<void>;
  /** First, at `handle()` entry. Returning a Response answers the request (onResponse still runs). */
  readonly onRequest?: (request: Request) => PromiseOrValue<Response | undefined | void>;
  /**
   * After the body is read, before the "no query" check (so APQ hash-only requests get here).
   * Returns replacement params, or nothing. A throw becomes a 400 GraphQL error response
   * (always 400, even for a `gqlError` with another status; the error's extensions are kept).
   * Like every request error, it goes to a client that accepts text/event-stream and no JSON
   * type as a GraphQL-over-SSE `next` event, then `complete`, with a 200.
   */
  readonly onParams?: (
    params: Params,
    request: Request,
  ) => PromiseOrValue<Params | undefined | void>;
  /**
   * A finished phase (parse and validate on a cache miss, jit when it compiles). Synchronous: it
   * returns `undefined` (not `void`), so an async hook, whose rejection nobody would handle, does
   * not typecheck.
   */
  readonly onPhase?: (phase: Phase, request: Request) => undefined;
  /**
   * After the context factory, once the operation is known, before anything executes. A throw
   * here, or from the context factory, stops the operation before it starts, with the same
   * precedence as an onExecute refusal: 503 SERVER_DRAINING for a mutation once the drain has
   * begun, else 499 once the client has left, else the GraphQLError (or a masked 500).
   */
  readonly onContext?: (
    ctx: Ctx,
    request: Request,
    operation: OperationDefinitionNode,
  ) => PromiseOrValue<void>;
  /**
   * Claims the operation by returning an executor, or returns nothing. Synchronous. Every
   * onExecute hook runs, in list order, before anything executes; the first executor returned is
   * called (see `Executor`). Subscriptions are the exception: they always run through graphql-js
   * `subscribe()`, so an executor returned for one is never called (the hook still runs, and its
   * refusal still refuses). A thrown GraphQLError refuses the operation with that error (status
   * from `gqlError`, else 400), whatever executors earlier hooks returned: no executor runs. Two
   * outcomes take precedence over the refusal, in this order: a mutation is refused with 503
   * SERVER_DRAINING once the drain has begun, and a request whose client has left gets 499.
   * Because a later hook may still refuse, a hook keeps work that should happen only for an
   * operation that runs inside the executor it returns.
   */
  readonly onExecute?: (input: ExecuteInput, args: ExecutionArgs) => Executor | undefined | void;
  /**
   * Every payload an executor produces: a single result, the initial result of an incremental
   * response, a subsequent incremental payload, or a subscription event (including the error a
   * failing source ends with). A subsequent payload keeps its errors in `incremental[].errors`:
   * read and rewrite errors with `payloadErrors` and `mapPayloadErrors`. Returns a replacement
   * payload, or nothing (`hasNext` stays the executor's). Synchronous. Payloads that arrive
   * after the client has left are skipped (the request is a 499), a query's single result
   * included, even from an executor that ignores the abort signal. A started mutation is the
   * exception: one that finishes after a disconnect still runs the hooks on its result (its
   * writes happened).
   */
  readonly onResult?: (
    payload: ExecutionResult,
    ctx: Ctx,
    request: Request,
  ) => ExecutionResult | undefined | void;
  /**
   * Wraps each synchronous entry into the operation's execution: the executor call (a query's or
   * mutation's root fields, a subscription's source setup), each subscription event's execution,
   * and each pull of an incremental response's subsequent payloads (graphql-js runs deferred work
   * from there). It calls `run` once, synchronously, and returns what it returns. A plugin
   * carries request-local state into the resolvers this way, which keep receiving the
   * application's own context value: the Effect layer enters an `AsyncLocalStorage`, whose store
   * the async continuations of that work inherit. Wrappers nest in list order (the first is the
   * outermost). Synchronous, and in the hot loop.
   */
  readonly wrapExecution?: ExecutionWrapper;
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

/** Builds the per-request context, after the operation is resolved. */
export type ContextFactory<Ctx> = (request: Request, input: ContextInput) => PromiseOrValue<Ctx>;

/** The options every server takes, with or without a context factory. */
export interface BaseServerOptions {
  readonly schema: GraphQLSchema;
  readonly rootValue?: unknown;
  /** Size of the validated-document LRU. Default 1000. */
  readonly documentCacheSize?: number;
  /** Maximum lexical tokens per document (graphql's `maxLexicalTokens`). Default 10000. */
  readonly maxTokens?: number;
  readonly logger?: Logger;
}

/** A server with a context factory: every hook sees the context it builds. */
export interface ContextServerOptions<Ctx> extends BaseServerOptions {
  readonly context: ContextFactory<Ctx>;
  readonly plugins?: ReadonlyArray<Plugin<Ctx>>;
}

/** A server without a context factory: the context is `undefined`. */
export interface NoContextServerOptions extends BaseServerOptions {
  readonly context?: undefined;
  readonly plugins?: ReadonlyArray<Plugin<undefined>>;
}

/**
 * The options of `createServer<Ctx>`. The context factory is required when `Ctx` excludes
 * `undefined` (so no plugin is handed an `undefined` it does not expect), optional otherwise; the
 * default server (`Ctx = undefined`) needs none.
 */
export type ServerOptions<Ctx> = undefined extends Ctx
  ? ContextServerOptions<Ctx> | NoContextServerOptions
  : ContextServerOptions<Ctx>;

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
  /**
   * Resolves once the mutation's execution has settled and the result hooks (`onResult`) have
   * seen its result or error, so a continuation (a span end) observes them; at once when it never
   * started. It never waits for the response body. The drain waits for it.
   */
  readonly settled: Promise<void>;
  /**
   * Once a started mutation has settled, the HTTP status of the answer the core built from its
   * result (before onResponse): the response's status, an error result's 4xx or 5xx included,
   * or 500 when building it failed (a result hook threw). `undefined` until then, and for a
   * mutation that never started. A span end on `settled` reads it to tell ok from error.
   */
  readonly status: () => number | undefined;
}
