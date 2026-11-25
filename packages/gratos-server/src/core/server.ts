// The server core (docs/plan.html M4a): `createServer({ schema, context, plugins })` returns a
// Web-standard `handle(Request): Promise<Response>` that runs five phases (read, document cache,
// context, execute, encode) around the plugin hooks, plus `control` (replaceSchema, drain). The
// encode phase sends a single result as JSON, incremental results as multipart/mixed and
// subscription events as GraphQL-over-SSE (M4b).
import {
  AbortedGraphQLExecutionError,
  assertValidSchema,
  execute,
  getOperationAST,
  GraphQLError,
  legacyExecuteIncrementally,
  parse,
  specifiedRules,
  validate,
} from "graphql";
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLSchema,
  OperationDefinitionNode,
  ValidationRule,
} from "graphql";

import { DocumentCache, operationEntry } from "./documents.ts";
import type { DocumentEntry } from "./documents.ts";
import { asGraphQLError, serverDraining } from "./errors.ts";
import {
  APPLICATION_JSON,
  errorResult,
  GRAPHQL_RESPONSE_JSON,
  isJsonContentType,
  jsonResponse,
  MULTIPART_MIXED,
  negotiate,
  readParams,
  statusOf,
  TEXT_EVENT_STREAM,
} from "./http.ts";
import type { Accepted, MediaType } from "./http.ts";
import { hasIncrementalDirectives, NoIncrementalMutationsRule } from "./incremental.ts";
import { bindOperation, endStream, registerMutation, registerRequest } from "./requestState.ts";
import type { MutationTracker } from "./requestState.ts";
import { multipartResponse, sseResponse } from "./stream.ts";
import { subscribeOnce } from "./subscribe.ts";
import type { PayloadSource, StreamOptions, StreamPayload } from "./stream.ts";
import type {
  BaseServerOptions,
  ContextFactory,
  ContextInput,
  DrainOptions,
  ExecuteInput,
  Executor,
  ExecutorResult,
  IncrementalResults,
  Logger,
  NextExecutor,
  Params,
  Phase,
  PhaseName,
  Plugin,
  PromiseOrValue,
  Server,
  ServerControl,
  ServerOptions,
} from "./types.ts";

const DEFAULT_DOCUMENT_CACHE_SIZE = 1000;
const DEFAULT_MAX_TOKENS = 10_000;

/** The status of the response sent when the client has gone (it never reads it). */
export const CLIENT_CLOSED_REQUEST = 499;

/** A Promise as graphql-js tells one (isPromise): an object whose `then` is a function. */
const isPromiseLike = <T>(value: PromiseOrValue<T>): value is Promise<T> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/** Awaits a hook's result only when it is a Promise, so synchronous hooks cost no microtask. */
const settle = async <T>(value: PromiseOrValue<T>): Promise<T> =>
  isPromiseLike(value) ? await value : value;

/** A hook with its plugin, so it is called with the plugin as `this`-free closure. */
const hooksOf = <Ctx, K extends keyof Plugin<Ctx>>(
  plugins: ReadonlyArray<Plugin<Ctx>>,
  key: K,
): ReadonlyArray<NonNullable<Plugin<Ctx>[K]>> => {
  const hooks: Array<NonNullable<Plugin<Ctx>[K]>> = [];
  for (const plugin of plugins) {
    const hook = plugin[key];
    if (hook !== undefined && hook !== null) {
      hooks.push(hook);
    }
  }
  return hooks;
};

const unexpected = (originalError: unknown): GraphQLError =>
  new GraphQLError("Unexpected error.", {
    originalError: originalError instanceof Error ? originalError : undefined,
    extensions: { http: { status: 500 } },
  });

/**
 * The executor that runs when no plugin claims the operation. Subscriptions always go through
 * graphql-js's subscription pipeline, with the core holding the source's iterator (see
 * subscribe.ts). Queries and mutations go through `execute()`, or through
 * `legacyExecuteIncrementally()` when the schema declares @defer or @stream: `execute()` throws
 * on such a schema, even for an operation that uses neither.
 */
const defaultExecutor =
  (operation: OperationDefinitionNode, args: ExecutionArgs, enter: Enter): NextExecutor =>
  () => {
    if (operation.operation === "subscription") {
      return subscribeOnce(args, enter);
    }
    return hasIncrementalDirectives(args.schema) ? legacyExecuteIncrementally(args) : execute(args);
  };

/** A rejected pull (a failed subscription source) as the GraphQL error the client gets. */
const sourceFailure = (error: unknown): GraphQLError => {
  if (error instanceof GraphQLError) {
    return error;
  }
  return error instanceof Error
    ? new GraphQLError(error.message, { originalError: error })
    : unexpected(error);
};

/** A subscription's events as stream payloads. */
const subscriptionSource = (
  events: AsyncGenerator<ExecutionResult, void, void>,
): PayloadSource => ({
  next: async () => {
    const pulled = await events.next();
    return pulled.done === true
      ? pulled
      : { done: false, value: { result: pulled.value, hasNext: true } };
  },
  return: async () => {
    await events.return();
  },
});

/** Runs a synchronous entry into execution inside the request's execution wrappers. */
type Enter = <T>(run: () => T) => T;

/**
 * The subsequent payloads of an incremental result as stream payloads. Each pull runs inside the
 * request's execution wrappers (`wrapExecution`): graphql-js runs deferred work from it.
 */
const incrementalSource = (
  results: IncrementalResults["subsequentResults"],
  enter: Enter,
): PayloadSource => ({
  next: async () => {
    const pulled = await enter(() => results.next());
    return pulled.done === true
      ? pulled
      : { done: false, value: { result: pulled.value, hasNext: pulled.value.hasNext } };
  },
  return: async () => {
    await results.return();
  },
});

interface TrackedMutation {
  readonly name: string;
  readonly start: number;
  readonly done: Promise<void>;
}

const noop = (_status: number): void => {};

/** A controller that aborts when `incoming` (the Request's signal: the client left) does. */
const linkedController = (incoming: AbortSignal): AbortController => {
  const controller = new AbortController();
  if (incoming.aborted) {
    controller.abort(incoming.reason);
  } else {
    incoming.addEventListener(
      "abort",
      () => {
        controller.abort(incoming.reason);
      },
      { once: true, signal: controller.signal },
    );
  }
  return controller;
};

/** What the executor call gave: its result (maybe a Promise), or what it threw. */
type Outcome =
  | { readonly ok: true; readonly result: PromiseOrValue<ExecutorResult> }
  | { readonly ok: false; readonly error: unknown };

/** An execution that went past the gate (or failed before it), with its completion. */
interface Dispatched {
  readonly _tag: "dispatched";
  readonly outcome: Outcome;
  /** Whether a mutation's executor was called (false when it failed before dispatch). */
  readonly mutationStarted: boolean;
  /**
   * Publishes a mutation's completion, with the status of the answer built from its result; a
   * no-op for other operations.
   */
  readonly finish: (status: number) => void;
}

/** An early answer: a Response to send as is. */
interface Answer {
  readonly _tag: "answer";
  readonly response: Response;
}

const answer = (response: Response): Answer => ({ _tag: "answer", response });

/** The context of a server without a context factory. */
const noContext = (): undefined => undefined;

/**
 * Creates a server. Without a context factory the context is `undefined`; the types require one
 * when `Ctx` excludes `undefined` (see `ServerOptions`).
 */
export const createServer = <Ctx = undefined>(options: ServerOptions<Ctx>): Server =>
  options.context === undefined
    ? serve<undefined>(options, noContext, options.plugins ?? [])
    : serve<Ctx>(options, options.context, options.plugins ?? []);

const serve = <Ctx>(
  options: BaseServerOptions,
  contextFactory: ContextFactory<Ctx>,
  plugins: ReadonlyArray<Plugin<Ctx>>,
): Server => {
  let schema = options.schema;
  assertValidSchema(schema);
  let generation = 0;
  const cache = new DocumentCache(options.documentCacheSize ?? DEFAULT_DOCUMENT_CACHE_SIZE);
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const logger: Logger = options.logger ?? console;
  const hideSuggestions = plugins.some((plugin) => plugin.hideSuggestions === true);
  // graphql's specified rules, plus every plugin's. A schema that declares @defer or @stream also
  // gets NoIncrementalMutationsRule, with or without incremental(): its queries run through
  // legacyExecuteIncrementally, which would let a deferred mutation outlive drain().
  const pluginRules = plugins
    .flatMap((plugin) => plugin.validationRules ?? [])
    .filter((rule) => rule !== NoIncrementalMutationsRule);
  const validationRules: ReadonlyArray<ValidationRule> | undefined =
    pluginRules.length === 0 ? undefined : [...specifiedRules, ...pluginRules];
  const incrementalValidationRules: ReadonlyArray<ValidationRule> = [
    ...specifiedRules,
    ...pluginRules,
    NoIncrementalMutationsRule,
  ];

  // Hook lists are built once: a hook that no plugin defines costs nothing per request.
  const onServer = hooksOf(plugins, "onServer");
  const onRequest = hooksOf(plugins, "onRequest");
  const onParams = hooksOf(plugins, "onParams");
  const onPhase = hooksOf(plugins, "onPhase");
  const onContext = hooksOf(plugins, "onContext");
  const onExecute = hooksOf(plugins, "onExecute");
  const onResult = hooksOf(plugins, "onResult");
  const onResponse = hooksOf(plugins, "onResponse");
  // The first wrapper is the outermost.
  const wrapExecution = hooksOf(plugins, "wrapExecution").toReversed();

  /** Runs `run` inside every plugin's execution wrapper (directly when there is none). */
  const enterExecution = <T>(request: Request, run: () => T): T => {
    let wrapped = run;
    for (const hook of wrapExecution) {
      const inner = wrapped;
      wrapped = () => hook(request, inner);
    }
    return wrapped();
  };

  /**
   * A request's entry into its execution wrappers. Every entry enters them, also one made while
   * they are running (an executor calling `next()` from the executor call): the code that makes
   * it may run in another context by then (a listener an EventEmitterAsyncResource calls in the
   * context it was created in, another request's, say), so only the wrappers know whether they
   * are in effect. A wrapper entered again with its own state in effect can run `run` directly.
   */
  const entryOf =
    (request: Request): Enter =>
    (run) =>
      enterExecution(request, run);

  const tracked = new Set<TrackedMutation>();
  let draining = false;

  const drain = async (drainOptions: DrainOptions = {}): Promise<void> => {
    draining = true;
    const { warnAfterMs } = drainOptions;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (warnAfterMs !== undefined && tracked.size > 0) {
      const tick = (): void => {
        const now = performance.now();
        logger.warn(
          `gratos-server: drain is waiting for ${tracked.size} mutation(s) to finish.`,
          [...tracked].map(({ name, start }) => ({
            operation: name,
            runningMs: Math.round(now - start),
          })),
        );
        timer = setTimeout(tick, warnAfterMs);
      };
      timer = setTimeout(tick, warnAfterMs);
    }
    try {
      while (tracked.size > 0) {
        await Promise.allSettled([...tracked].map(({ done }) => done));
      }
    } finally {
      clearTimeout(timer);
    }
    // Continuations registered on `mutationOf(req).settled` (such as a span end) run first.
    await Promise.resolve();
  };

  const control: ServerControl = {
    schema: () => schema,
    generation: () => generation,
    replaceSchema: (next) => {
      assertValidSchema(next);
      schema = next;
      generation += 1;
      cache.clear();
    },
    drain,
    draining: () => draining,
  };

  // onServer hooks run in order. Synchronous ones run (and throw) inside createServer; once one
  // returns a Promise, the rest run after it and requests wait for them. `ready` is the startup
  // barrier: it is cleared once startup succeeds, so later requests keep the schema they pinned at
  // handle() entry. A failed startup keeps it, and every request gets a 500.
  let ready: Promise<void> | undefined;
  for (const [index, hook] of onServer.entries()) {
    const returned = hook({ schema, control });
    if (isPromiseLike(returned)) {
      const rest = onServer.slice(index + 1);
      ready = (async () => {
        await returned;
        for (const next of rest) {
          await settle(next({ schema, control }));
        }
        ready = undefined;
      })();
      // A failed startup answers every request with a 500 (handle awaits `ready`).
      ready.catch((error: unknown) => {
        logger.error("gratos-server: an onServer hook failed.", error);
      });
      break;
    }
  }

  const reportPhase = (request: Request, name: PhaseName, start: number, end: number): void => {
    if (onPhase.length === 0) {
      return;
    }
    const phase: Phase = { name, start, end };
    for (const hook of onPhase) {
      hook(phase, request);
    }
  };

  /** Everything one request carries between phases. */
  interface Run {
    readonly request: Request;
    /**
     * The controller of the core signal (`signalOf(req)`), which the response's body also aborts
     * when the client leaves. Once closeUnsent has aborted it to stop an execution whose result
     * is not sent, it is replaced by one for the answer alone (see closeUnsent).
     */
    controller: AbortController;
    /** The schema generation this request pinned; it finishes on it whatever replaceSchema does. */
    schema: GraphQLSchema;
    generation: number;
    /** The JSON type single results and request errors use. */
    mediaType: MediaType;
    /** What the client accepts (the streamed types too). */
    accepted: Accepted;
    /**
     * The client accepts text/event-stream and no JSON type: GraphQL request errors go out as
     * GraphQL-over-SSE events (see `respond`); transport failures stay JSON (`transportError`).
     */
    errorsAsEvents: boolean;
    ctx: Ctx | undefined;
    mutation: MutationTracker | undefined;
    /** Enters the request's execution wrappers (`wrapExecution`; see entryOf). */
    readonly enter: Enter;
  }

  /**
   * A single result, or a GraphQL request error (a syntax, validation, unknown-operation or
   * variable error, a refusal, the drain), as JSON with its status. A client that accepts
   * text/event-stream and no JSON type gets it as GraphQL-over-SSE instead: one `next` event with
   * the result, then `complete`, always with a 200. graphql-sse's protocol (distinct connections
   * mode) has errors found before execution reported through an accepted SSE connection, since a
   * client reading an event stream cannot read a JSON body, and a 4xx makes it fail the
   * connection without the errors.
   */
  const respond = (run: Run, result: ExecutionResult, status?: number): Response => {
    if (run.errorsAsEvents) {
      return sseResponse({
        first: { result, hasNext: false },
        rest: undefined,
        process: (payload) => payload,
        failure: sourceFailure,
        controller: run.controller,
        clientSignal: run.request.signal,
        logger,
        onEnd: () => {
          endStream(run.request);
        },
      });
    }
    return jsonResponse(result, status ?? statusOf(result, run.mediaType), run.mediaType, () => {
      run.controller.abort();
    });
  };

  /** Closes a streamed result; a cleanup that fails is logged and never changes the answer. */
  const closeStreamed = async (result: ExecutorResult): Promise<void> => {
    try {
      if (Symbol.asyncIterator in result) {
        await result.return();
      } else if ("initialResult" in result) {
        await result.subsequentResults.return();
      }
    } catch (error) {
      logger.error("gratos-server: closing a streamed result failed.", error);
    }
  };

  /**
   * Closes a streamed result that is not sent (a refusal, a client that left, a failing result
   * hook). The core signal aborts first, so a cleanup that waits on it, or on a pending pull,
   * ends. The answer that follows (a 406, a failing hook's 500) gets a controller of its own,
   * aborted only when the client leaves: the core signal no longer says whether it is there.
   */
  const closeUnsent = async (run: Run, result: ExecutorResult): Promise<void> => {
    run.controller.abort();
    run.controller = linkedController(run.request.signal);
    await closeStreamed(result);
  };

  /** Whether the request is a mutation (not started yet) and the drain has begun. */
  const drainRefuses = (run: Run): boolean => run.mutation !== undefined && draining;

  /**
   * The answer for an operation stopped before it started (a context or onExecute refusal, or a
   * context failure), with one precedence: the drain (503 SERVER_DRAINING for an unstarted
   * mutation), then a disconnect (499, a cancellation: nothing to send), then the refusal itself,
   * or a masked 500 for an error that is not a GraphQLError.
   */
  const notStarted = (run: Run, error: unknown): Response => {
    if (drainRefuses(run)) {
      return respond(run, errorResult([serverDraining()]));
    }
    if (run.controller.signal.aborted) {
      return new Response(null, { status: CLIENT_CLOSED_REQUEST });
    }
    return respond(run, errorResult([error instanceof GraphQLError ? error : unexpected(error)]));
  };

  /**
   * A failure of the HTTP exchange itself, not of the GraphQL request: an unsupported Accept or
   * Content-Type, a body that is not a GraphQL-over-HTTP request, or a streamed response the
   * client does not accept. It is JSON with its status (the M4a HTTP matrix) for every client,
   * an SSE-only one included: only GraphQL request errors go out as GraphQL-over-SSE events.
   */
  const transportError = (run: Run, message: string, status: number): Response =>
    jsonResponse(errorResult([new GraphQLError(message)]), status, run.mediaType, () => {
      run.controller.abort();
    });

  /** read: method, Accept, Content-Type, body, onParams, the "no query" check. */
  const read = async (run: Run): Promise<Answer | Params> => {
    const { request } = run;
    if (request.method !== "POST") {
      return answer(new Response(null, { status: 405, headers: { allow: "POST" } }));
    }
    const accepted = negotiate(request.headers.get("accept"));
    if (accepted === undefined) {
      run.mediaType = APPLICATION_JSON;
      return answer(
        transportError(
          run,
          `Accept must allow ${GRAPHQL_RESPONSE_JSON}, ${APPLICATION_JSON}, ${MULTIPART_MIXED} or ${TEXT_EVENT_STREAM}.`,
          406,
        ),
      );
    }
    run.accepted = accepted;
    // A client that accepts no JSON type gets GraphQL request errors as GraphQL-over-SSE when it
    // accepts text/event-stream, else (multipart/mixed only) as JSON, the default. Transport
    // failures (below: 415, 400 for the body) are JSON for every client.
    run.mediaType = accepted.json ?? GRAPHQL_RESPONSE_JSON;
    run.errorsAsEvents = accepted.json === undefined && accepted.eventStream;
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return answer(transportError(run, `Content-Type must be ${APPLICATION_JSON}.`, 415));
    }
    const read = await readParams(request);
    if (read._tag === "bad") {
      return answer(transportError(run, read.message, 400));
    }
    let params = read.params;
    for (const hook of onParams) {
      try {
        params = (await settle(hook(params, request))) ?? params;
      } catch (error) {
        const graphQLError = asGraphQLError(
          error,
          error instanceof Error ? error.message : "Invalid request.",
        );
        // Always a 400 (the plan's contract), whatever status the error carries; its extensions
        // stay in the payload.
        return answer(respond(run, errorResult([graphQLError]), 400));
      }
    }
    if (params.query === undefined || params.query === "") {
      return answer(transportError(run, "Must provide a query string.", 400));
    }
    return params;
  };

  /** doc cache: a validated document, parsed and validated on a miss only. */
  const documentOf = (run: Run, query: string): Answer | DocumentEntry => {
    const cached = cache.get(run.generation, query);
    if (cached !== undefined) {
      return cached;
    }
    let document: DocumentNode;
    const parseStart = performance.now();
    try {
      // With locations: `document.loc.source.body` is the validated text (apq() relies on it).
      document = parse(query, { maxLexicalTokens: maxTokens });
    } catch (error) {
      reportPhase(run.request, "parse", parseStart, performance.now());
      return answer(respond(run, errorResult([asGraphQLError(error, "Syntax error.")])));
    }
    const validateStart = performance.now();
    reportPhase(run.request, "parse", parseStart, validateStart);
    const rules = hasIncrementalDirectives(run.schema)
      ? incrementalValidationRules
      : validationRules;
    const errors = validate(run.schema, document, rules, { hideSuggestions });
    reportPhase(run.request, "validate", validateStart, performance.now());
    if (errors.length > 0) {
      return answer(respond(run, errorResult(errors)));
    }
    return cache.set(run.generation, query, document);
  };

  /** context: the factory, then onContext. A failure answers the request. */
  const contextOf = async (
    run: Run,
    input: ContextInput,
  ): Promise<Answer | { readonly _tag: "context"; readonly ctx: Ctx }> => {
    try {
      const produced = contextFactory(run.request, input);
      const ctx = isPromiseLike(produced) ? await produced : produced;
      run.ctx = ctx;
      for (const hook of onContext) {
        await settle(hook(ctx, run.request, input.operation));
      }
      return { _tag: "context", ctx };
    } catch (error) {
      if (!(error instanceof GraphQLError)) {
        logger.error("gratos-server: the context phase failed.", error);
      }
      return answer(notStarted(run, error));
    }
  };

  /**
   * The gate, executor choice and executor call, in one synchronous step: every onExecute hook
   * runs (so a refusal anywhere in the list refuses), the first executor returned is chosen, the
   * drain gate and the no-late-start check run, the mutation is published as started and
   * registered in the tracked set, and the executor is called. Every mutation is therefore either
   * tracked or never started. The caller publishes its completion (`finish`) once the result
   * hooks have run.
   */
  const startExecution = (
    run: Run,
    input: ExecuteInput,
    args: ExecutionArgs,
  ): Answer | Dispatched => {
    let claims: Array<Executor> | undefined;
    try {
      for (const hook of onExecute) {
        const claimed = hook(input, args);
        if (claimed !== undefined) {
          (claims ??= []).push(claimed);
        }
      }
    } catch (error) {
      // A refusal, or an unstarted mutation once the drain has begun, answers here (notStarted's
      // precedence: drain, disconnect, refusal).
      if (error instanceof GraphQLError || drainRefuses(run)) {
        return answer(notStarted(run, error));
      }
      // Any other throw is a failure of the request, before anything started: encode reports it,
      // or cancels it once the client has left.
      return {
        _tag: "dispatched",
        outcome: { ok: false, error },
        mutationStarted: false,
        finish: noop,
      };
    }
    // The first claim runs; its `next` is the executor that would have run without it (the next
    // claim in list order, else the default). A subscription always runs through subscribe(): a
    // claim cannot answer it (an executor such as legacyExecuteIncrementally would return a
    // one-shot result), so its claims are ignored once every hook has had its say.
    const { enter } = run;
    let execute: NextExecutor = defaultExecutor(input.operation, args, enter);
    const chosen = input.operation.operation === "subscription" ? undefined : claims;
    for (const claim of chosen?.toReversed() ?? []) {
      const next = execute;
      // Bound to the request: an executor may call `next()` later, from outside the executor
      // call (an event emitter's callback, a queue), and the work still runs in the wrappers.
      execute = () => claim(() => enter(next));
    }
    const { mutation } = run;
    if (mutation !== undefined && draining) {
      return answer(respond(run, errorResult([serverDraining()])));
    }
    if (run.controller.signal.aborted) {
      return answer(new Response(null, { status: CLIENT_CLOSED_REQUEST }));
    }
    let finish: (status: number) => void = noop;
    if (mutation !== undefined) {
      const { promise: done, resolve } = Promise.withResolvers<undefined>();
      const entry: TrackedMutation = {
        name: input.operation.name?.value ?? "anonymous",
        start: performance.now(),
        done,
      };
      tracked.add(entry);
      mutation.start();
      finish = (status) => {
        mutation.settle(status);
        tracked.delete(entry);
        resolve(undefined);
      };
    }
    const mutationStarted = mutation !== undefined;
    try {
      return {
        _tag: "dispatched",
        // Inside the execution wrappers (`wrapExecution`), which carry request-local state
        // into the resolvers.
        outcome: { ok: true, result: enter(execute) },
        mutationStarted,
        finish,
      };
    } catch (error) {
      return { _tag: "dispatched", outcome: { ok: false, error }, mutationStarted, finish };
    }
  };

  /** The result hooks (onResult), in list order, on one payload. */
  const processPayload = (run: Run, ctx: Ctx, payload: ExecutionResult): ExecutionResult => {
    let processed = payload;
    for (const hook of onResult) {
      processed = hook(processed, ctx, run.request) ?? processed;
    }
    return processed;
  };

  const streamOptions = (
    run: Run,
    ctx: Ctx,
    first: StreamPayload | undefined,
    rest: PayloadSource | undefined,
  ): StreamOptions => ({
    first,
    rest,
    process: (payload) => processPayload(run, ctx, payload),
    failure: sourceFailure,
    controller: run.controller,
    clientSignal: run.request.signal,
    logger,
    onEnd: () => {
      endStream(run.request);
    },
  });

  /** execute (await the executor) and encode: the result hooks, then the Response. */
  const encode = async (
    run: Run,
    outcome: Outcome,
    ctx: Ctx,
    operation: OperationDefinitionNode,
    mutationStarted: boolean,
  ): Promise<Response> => {
    let result: ExecutorResult | undefined;
    let failure: { readonly error: unknown } | undefined;
    if (outcome.ok) {
      try {
        result = await settle(outcome.result);
      } catch (error) {
        failure = { error };
      }
    } else {
      failure = { error: outcome.error };
    }
    if (failure !== undefined || result === undefined) {
      const error = failure?.error;
      // Only an aborted execution takes the cancellation path. A started mutation never gets the
      // signal, so its failure is a real one (a write that failed), processed and reported as
      // usual even when the client has left. A mutation that failed before dispatch never
      // started, so like a query it is a cancellation once the client has left.
      if (
        error instanceof AbortedGraphQLExecutionError ||
        (!mutationStarted && run.controller.signal.aborted)
      ) {
        // The client left: nothing is reported, and the terminal path (onResponse) still runs.
        return new Response(null, { status: CLIENT_CLOSED_REQUEST });
      }
      result = errorResult([unexpected(error)]);
    }
    const streamed = Symbol.asyncIterator in result || "initialResult" in result;
    if (streamed && operation.operation === "mutation") {
      // Only a custom executor streams a mutation's result (the default one never does:
      // NoIncrementalMutationsRule). No encoder may pull it: its work would run after
      // mutationOf(req).settled and drain() have resolved. It is closed here, before the
      // mutation's completion is published, without the core signal (a started mutation never
      // gets it), and the request fails.
      logger.error("gratos-server: an executor streamed the result of a mutation.");
      await closeStreamed(result);
      if (run.controller.signal.aborted) {
        return new Response(null, { status: CLIENT_CLOSED_REQUEST });
      }
      return respond(run, errorResult([unexpected(undefined)]), 500);
    }
    if (!mutationStarted && run.controller.signal.aborted) {
      // The client left before the result was encoded: a cancellation, with nothing reported or
      // sent, for a single result as for a stream. A query's executor that ignores the signal
      // (graphql-jit) still settles with a result, which nobody reads. A subscription source
      // that was still being set up comes back from subscribe() as an errors-only result
      // (graphql's AbortError at the field); a stream that already exists is closed (the signal
      // is aborted, so `return()` cannot wait on a pull). A started mutation is never cancelled:
      // its writes happened, so its result is processed as usual.
      if (streamed) {
        await closeUnsent(run, result);
      }
      return new Response(null, { status: CLIENT_CLOSED_REQUEST });
    }
    if (Symbol.asyncIterator in result) {
      // A subscription (process() refused one whose client does not accept text/event-stream).
      if (!run.accepted.eventStream) {
        await closeUnsent(run, result);
        return transportError(run, `A subscription needs Accept: ${TEXT_EVENT_STREAM}.`, 406);
      }
      return sseResponse(streamOptions(run, ctx, undefined, subscriptionSource(result)));
    }
    if ("initialResult" in result) {
      if (!run.accepted.multipart) {
        await closeUnsent(run, result);
        return transportError(
          run,
          `This operation uses @defer or @stream, which needs Accept: ${MULTIPART_MIXED}.`,
          406,
        );
      }
      const { initialResult, subsequentResults } = result;
      let first: StreamPayload;
      try {
        first = { result: processPayload(run, ctx, initialResult), hasNext: true };
      } catch (error) {
        // A failing result hook: stop the deferred work before the request fails.
        await closeUnsent(run, result);
        throw error;
      }
      return multipartResponse(
        streamOptions(run, ctx, first, incrementalSource(subsequentResults, run.enter)),
      );
    }
    const payload = processPayload(run, ctx, result);
    // A single result is JSON, unless the client accepts no JSON type or the operation is a
    // subscription (whose client reads a stream even when subscribe() answers at once).
    if (run.accepted.json !== undefined && operation.operation !== "subscription") {
      return respond(run, payload);
    }
    const single = streamOptions(run, ctx, { result: payload, hasNext: false }, undefined);
    return run.accepted.eventStream ? sseResponse(single) : multipartResponse(single);
  };

  const process = async (run: Run): Promise<Response> => {
    const { request } = run;
    for (const hook of onRequest) {
      const early = await settle(hook(request));
      if (early !== undefined) {
        return early;
      }
    }

    // read
    const params = await read(run);
    if ("_tag" in params) {
      return params.response;
    }
    const query = params.query ?? "";

    // document cache
    const entry = documentOf(run, query);
    if ("_tag" in entry) {
      return entry.response;
    }
    const { document } = entry;
    const operation = getOperationAST(document, params.operationName);
    if (operation === null || operation === undefined) {
      const message =
        params.operationName === undefined
          ? "Must provide an operation name when the document contains several operations."
          : `Unknown operation named "${params.operationName}".`;
      return respond(run, errorResult([new GraphQLError(message)]));
    }
    if (operation.operation === "subscription" && !run.accepted.eventStream) {
      // Refused before the source starts: its events can only go out as GraphQL-over-SSE.
      return transportError(run, `A subscription needs Accept: ${TEXT_EVENT_STREAM}.`, 406);
    }
    const isMutation = operation.operation === "mutation";
    if (isMutation) {
      run.mutation = registerMutation(request);
      if (draining) {
        return respond(run, errorResult([serverDraining()]));
      }
    }

    // context
    bindOperation(request, operation);
    const context = await contextOf(run, { operation, document, params });
    if (context._tag === "answer") {
      return context.response;
    }
    const { ctx } = context;
    // A drain that started during the context phase refuses the mutation before any onExecute
    // hook can refuse it for another reason (the gate checks again right before dispatch).
    if (run.mutation !== undefined && draining) {
      return respond(run, errorResult([serverDraining()]));
    }

    // execute
    const args: ExecutionArgs = {
      schema: run.schema,
      document,
      operationName: params.operationName,
      variableValues: params.variables,
      contextValue: ctx,
      rootValue: options.rootValue,
      hideSuggestions,
      // The core's signal goes to query and subscription execution, never to mutations.
      abortSignal: isMutation ? undefined : run.controller.signal,
    };
    const input: ExecuteInput = {
      operation,
      document,
      operationName: params.operationName,
      operationKey: operationEntry(entry, operation),
      request,
      phase: (name, start, end) => {
        reportPhase(request, name, start, end);
      },
      bindOperation: (bound) => {
        bindOperation(request, bound);
      },
    };
    const dispatched = startExecution(run, input, args);
    if (dispatched._tag === "answer") {
      return dispatched.response;
    }
    // A failure to build the answer (a throwing result hook) is a 500 (handle()'s catch).
    let status = 500;
    try {
      const response = await encode(
        run,
        dispatched.outcome,
        ctx,
        operation,
        dispatched.mutationStarted,
      );
      status = response.status;
      return response;
    } finally {
      // A mutation's completion (mutationOf(req).settled, the drain) is published only once the
      // result hooks have seen its result, never on body consumption, with the answer's status.
      dispatched.finish(status);
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    const start = performance.now();
    const controller = linkedController(request.signal);
    registerRequest(request, controller.signal, start);
    const run: Run = {
      request,
      controller,
      schema,
      generation,
      mediaType: GRAPHQL_RESPONSE_JSON,
      accepted: { json: GRAPHQL_RESPONSE_JSON, multipart: false, eventStream: false },
      errorsAsEvents: false,
      ctx: undefined,
      mutation: undefined,
      enter: entryOf(request),
    };
    let response: Response;
    try {
      if (ready !== undefined) {
        // Arrived during startup: pin the schema startup leaves (onServer may replace it).
        await ready;
        run.schema = schema;
        run.generation = generation;
      }
      response = await process(run);
    } catch (error) {
      logger.error("gratos-server: the request failed.", error);
      response = respond(run, errorResult([unexpected(error)]), 500);
    } finally {
      run.mutation?.skip();
    }
    for (const hook of onResponse) {
      try {
        response = (await settle(hook(response, request, run.ctx))) ?? response;
      } catch (error) {
        logger.error("gratos-server: an onResponse hook failed.", error);
      }
    }
    return response;
  };

  return { handle, control };
};
