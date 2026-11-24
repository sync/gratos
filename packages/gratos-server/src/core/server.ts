// The server core (docs/plan.html M4a): `createServer({ schema, context, plugins })` returns a
// Web-standard `handle(Request): Promise<Response>` that runs five phases (read, document cache,
// context, execute, encode) around the plugin hooks, plus `control` (replaceSchema, drain).
import {
  AbortedGraphQLExecutionError,
  assertValidSchema,
  execute,
  getOperationAST,
  GraphQLError,
  parse,
  subscribe,
  validate,
} from "graphql";
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLSchema,
  OperationDefinitionNode,
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
  negotiate,
  readParams,
  statusOf,
} from "./http.ts";
import type { MediaType } from "./http.ts";
import { registerMutation, registerRequest } from "./requestState.ts";
import type { MutationTracker } from "./requestState.ts";
import type {
  BaseServerOptions,
  ContextFactory,
  ContextInput,
  DrainOptions,
  ExecuteInput,
  Executor,
  ExecutorResult,
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

const isPromiseLike = <T>(value: PromiseOrValue<T>): value is Promise<T> =>
  typeof value === "object" && value !== null && "then" in value;

/** Awaits a hook's result only when it is a Promise, so synchronous hooks cost no microtask. */
const settle = async <T>(value: PromiseOrValue<T>): Promise<T> =>
  isPromiseLike(value) ? await value : value;

const isSingleResult = (result: ExecutorResult): result is ExecutionResult =>
  !(Symbol.asyncIterator in result) && !("initialResult" in result);

/** Closes a streamed result the JSON path cannot send. */
const closeStreamed = async (result: ExecutorResult): Promise<void> => {
  if (Symbol.asyncIterator in result) {
    await result.return();
  } else if ("initialResult" in result) {
    await result.subsequentResults.return();
  }
};

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

const defaultExecutor =
  (operation: OperationDefinitionNode, args: ExecutionArgs): NextExecutor =>
  () =>
    operation.operation === "subscription" ? subscribe(args) : execute(args);

interface TrackedMutation {
  readonly name: string;
  readonly start: number;
  readonly done: Promise<void>;
}

const noop = (): void => {};

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
  /** Publishes a mutation's completion; a no-op for other operations. */
  readonly finish: () => void;
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

  // Hook lists are built once: a hook that no plugin defines costs nothing per request.
  const onServer = hooksOf(plugins, "onServer");
  const onRequest = hooksOf(plugins, "onRequest");
  const onParams = hooksOf(plugins, "onParams");
  const onPhase = hooksOf(plugins, "onPhase");
  const onContext = hooksOf(plugins, "onContext");
  const onExecute = hooksOf(plugins, "onExecute");
  const onResult = hooksOf(plugins, "onResult");
  const onResponse = hooksOf(plugins, "onResponse");

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
    readonly controller: AbortController;
    /** The schema generation this request pinned; it finishes on it whatever replaceSchema does. */
    schema: GraphQLSchema;
    generation: number;
    mediaType: MediaType;
    ctx: Ctx | undefined;
    mutation: MutationTracker | undefined;
  }

  const respond = (run: Run, result: ExecutionResult, status?: number): Response =>
    jsonResponse(result, status ?? statusOf(result, run.mediaType), run.mediaType, () => {
      run.controller.abort();
    });

  /**
   * A refusal from a hook (context or onExecute). A mutation that has not started is refused with
   * 503 SERVER_DRAINING instead once the drain has begun, whichever refusal came first.
   */
  const refuse = (run: Run, error: GraphQLError): Response =>
    respond(run, errorResult([run.mutation !== undefined && draining ? serverDraining() : error]));

  const requestError = (run: Run, message: string, status: number): Response =>
    respond(run, errorResult([new GraphQLError(message)]), status);

  /** read: method, Accept, Content-Type, body, onParams, the "no query" check. */
  const read = async (run: Run): Promise<Answer | Params> => {
    const { request } = run;
    if (request.method !== "POST") {
      return answer(new Response(null, { status: 405, headers: { allow: "POST" } }));
    }
    const mediaType = negotiate(request.headers.get("accept"));
    if (mediaType === undefined) {
      run.mediaType = APPLICATION_JSON;
      return answer(
        requestError(
          run,
          `Accept must allow ${GRAPHQL_RESPONSE_JSON} or ${APPLICATION_JSON}.`,
          406,
        ),
      );
    }
    run.mediaType = mediaType;
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return answer(requestError(run, `Content-Type must be ${APPLICATION_JSON}.`, 415));
    }
    const read = await readParams(request);
    if (read._tag === "bad") {
      return answer(requestError(run, read.message, 400));
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
      return answer(requestError(run, "Must provide a query string.", 400));
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
    const errors = validate(run.schema, document, undefined, { hideSuggestions });
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
      if (error instanceof GraphQLError) {
        return answer(refuse(run, error));
      }
      logger.error("gratos-server: the context phase failed.", error);
      return answer(respond(run, errorResult([unexpected(error)])));
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
      if (error instanceof GraphQLError) {
        return answer(refuse(run, error));
      }
      // Any other throw is a failure of the request, before anything started.
      return {
        _tag: "dispatched",
        outcome: { ok: false, error },
        mutationStarted: false,
        finish: noop,
      };
    }
    // The first claim runs; its `next` is the executor that would have run without it (the next
    // claim in list order, else the default).
    let execute: NextExecutor = defaultExecutor(input.operation, args);
    for (const claim of claims?.toReversed() ?? []) {
      const next = execute;
      execute = () => claim(next);
    }
    const { mutation } = run;
    if (mutation !== undefined && draining) {
      return answer(respond(run, errorResult([serverDraining()])));
    }
    if (run.controller.signal.aborted) {
      return answer(new Response(null, { status: CLIENT_CLOSED_REQUEST }));
    }
    let finish = noop;
    if (mutation !== undefined) {
      const { promise: done, resolve } = Promise.withResolvers<undefined>();
      const entry: TrackedMutation = {
        name: input.operation.name?.value ?? "anonymous",
        start: performance.now(),
        done,
      };
      tracked.add(entry);
      mutation.start();
      finish = () => {
        mutation.settle();
        tracked.delete(entry);
        resolve(undefined);
      };
    }
    const mutationStarted = mutation !== undefined;
    try {
      return {
        _tag: "dispatched",
        outcome: { ok: true, result: execute() },
        mutationStarted,
        finish,
      };
    } catch (error) {
      return { _tag: "dispatched", outcome: { ok: false, error }, mutationStarted, finish };
    }
  };

  /** execute (await the executor) and encode: the result hooks, then the Response. */
  const encode = async (
    run: Run,
    outcome: Outcome,
    ctx: Ctx,
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
    if (!isSingleResult(result)) {
      await closeStreamed(result);
      return requestError(
        run,
        "This operation streams its result, which needs a streaming Accept type.",
        406,
      );
    }
    let payload = result;
    for (const hook of onResult) {
      payload = hook(payload, ctx, run.request) ?? payload;
    }
    return respond(run, payload);
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
    const isMutation = operation.operation === "mutation";
    if (isMutation) {
      run.mutation = registerMutation(request);
      if (draining) {
        return respond(run, errorResult([serverDraining()]));
      }
    }

    // context
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
    };
    const dispatched = startExecution(run, input, args);
    if (dispatched._tag === "answer") {
      return dispatched.response;
    }
    try {
      return await encode(run, dispatched.outcome, ctx, dispatched.mutationStarted);
    } finally {
      // A mutation's completion (mutationOf(req).settled, the drain) is published only once the
      // result hooks have seen its result, never on body consumption.
      dispatched.finish();
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    const start = performance.now();
    const controller = new AbortController();
    const incoming = request.signal;
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
    registerRequest(request, controller.signal, start);
    const run: Run = {
      request,
      controller,
      schema,
      generation,
      mediaType: GRAPHQL_RESPONSE_JSON,
      ctx: undefined,
      mutation: undefined,
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
