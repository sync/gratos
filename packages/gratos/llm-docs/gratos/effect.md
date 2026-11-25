# Effect resolvers with Gratos

Gratos is Grats (v0.0.36) taught to read `Effect.Effect` and `Stream.Stream` return types, plus
a GraphQL server core (`@dblechoc/gratos-server`) and an Effect layer
(`@dblechoc/gratos-server/effect`) that runs every resolver in the request's fiber context. The
other files of these docs are upstream Grats' (vendored unchanged); this chapter is Gratos' own
(`llm-docs/gratos/` is the one folder `vendor:verify` does not compare with upstream).

The working reference is `examples/orders` (its README walks a new resolver through the five
steps: write, generate, nothing, guard, test). Code blocks tagged `file=` below are compared with
that file by `examples/orders/test/docs.test.ts`.

## Return types

What the compiler accepts in a Grats model:

| Resolver returns                      | GraphQL field type      | Where                                             |
| ------------------------------------- | ----------------------- | ------------------------------------------------- |
| `Effect.Effect<A, E, R>`              | `A` (like `Promise<A>`) | any field except a `Subscription` field           |
| `Stream.Stream<A, E, R>`              | `A`, one event per item | `@gqlSubscriptionField` only                      |
| `A`, `Promise<A>`, `AsyncIterable<A>` | as in Grats             | as in Grats (`AsyncIterable<A>` on subscriptions) |

A `Subscription` field never returns an `Effect.Effect`, not even `Effect.Effect<AsyncIterable<A>>`
or `Effect.Effect<Stream.Stream<A>>`: the compiler rejects it and asks for the `Stream.Stream`
itself. A source that needs an Effect to set up is a Stream built from it (`Stream.unwrap`, or
`ctx.guardStream`, see below).

```ts file=examples/orders/src/models/Order.ts
/** Cancels an open order. @gqlMutationField */
export function cancelOrder(ctx: Ctx, id: ID): Effect.Effect<Order, AppError, Services> {
```

Rules the compiler enforces:

- Only the qualified names count: `Effect.Effect` and `Stream.Stream` (from
  `import { Effect, Stream } from "effect"`). A bare `Effect<A>` imported from `effect` gets an
  error that suggests `Effect.Effect<A>`. A type of your own named `Effect` stays a normal type.
  `import { Effect as Fx }` with `Fx.Effect` is not detected (a documented limitation).
- The Effect is the outermost wrapper of the return type. `Effect.Effect<Promise<A>>`,
  `Promise<Effect.Effect<A>>`, `Array<Effect.Effect<A>>`, `Effect.Effect<A>[]` and an Effect
  around a Stream are errors. This is the compiler's rule, so that the field's type and its
  markers come from one outer Effect: the runtime is more lenient (it also runs an Effect that a
  Promise resolves to, see below), but it never runs an Effect inside a list.
- A `Stream.Stream` is valid only on a subscription field; on a query or object field it is an
  error (it would compile to a list and fail at run time).
- Neither is valid in an input position (an argument or an input field), nor as the return type
  of a `@gqlContext` derived-context function.

The runtime is more lenient than the compiler, for hand-written schemas passed to `effectSchema`:
a `resolve` may return an Effect, an `Exit`, a plain value or a Promise of any of them (the
Effect it resolves to is run), and a `subscribe` may return a `Stream`, an `AsyncIterable`, or
an Effect or Promise of either. In a Grats model, keep to the table above.

Every method field gets its own explicit `resolve` in the generated schema (Grats would use the
default resolver for some), and arguments are passed positionally, in your parameter order:

```ts file=examples/orders/src/generated/schema.ts
                    resolve(_source, args, context) {
                        return queryOrdersResolver(context, args.userId, args.first);
                    }
```

Generated markers, in the field's `extensions.gratos`:

- `semanticNonNull: true` on an Effect-returning field under `strictSemanticNullability`. Grats'
  `assertNonNull` cannot see inside an Effect, so the Effect layer checks the unwrapped value: a
  null success becomes a field error ("Cannot return null for semantically non-nullable
  field."). A subscription keeps Grats' `assertNonNull` on its per-event `resolve`, so a null
  item is one event with an error and the subscription carries on.
- `jit: false` on a field whose resolver declares a `GqlInfo` parameter: `jit()` keeps every
  operation that selects it on graphql-js (graphql-jit's `info` has no `getAbortSignal()`).

The generated `schema.ts` imports Grats' types from `@dblechoc/gratos` (the `libraryImport`
option). The CLI is `gratos` (`gratos --check` writes nothing and fails when the committed files
are stale).

## The Effect layer

### effectSchema

```ts file=examples/orders/src/graphql.ts
    schema: effectSchema(schema, { failure, isFailure: isAppError }),
```

`effectSchema(schema, options)` wraps every `resolve` and `subscribe` once, at startup, and takes
the cheapest path for each value a resolver returns: a plain value after one `Effect.isEffect`
check; an `Exit` (such as a guard's refusal) at once, with no fiber; an Effect forked with the
request's fork context (when it finishes synchronously, its value is returned with no Promise). A
`Stream` becomes an async iterable whose items take the same error paths as fields.

Options:

- `failure` (required): the app's mapper from its typed failure to a GraphQL error. Build it with
  `Match.tagsExhaustive`, so a new error tag fails the type check until it is mapped.
- `isFailure` (required): a guard, `(error: unknown) => error is E`, for the app's typed
  failure. The schema erases each resolver's error type, so a value that reaches the wrapper
  may be anything (another library's tagged error, a test double): the mapper only ever sees a
  value the guard accepts. Any other failure is a masked `ResolverDefect`. With
  `Schema.TaggedError` classes, `Schema.is(Schema.Union([...]))` is the guard.
- `onTimeout`: the error a `GuardTimeout` becomes (default `gqlError("Request timeout", 504)`).
- `onDefect`: receives the defect of a cause that also holds a typed failure.

```ts file=examples/orders/src/graphql.ts
export const failure = Match.type<AppError>().pipe(
  Match.tagsExhaustive({
    NotFound: (error) => gqlError(`${error.what} not found`, 404, { code: "NOT_FOUND" }),
    Forbidden: () => gqlError("Forbidden", 403, { code: "FORBIDDEN" }),
  }),
);
```

A failure's cause is handled one of three ways: a typed failure goes to `failure`; an interrupt
caused by the client leaving becomes the core's `cancelled()` sentinel, which `reportErrors()`
skips; anything else (a die, a rejected value) is a `ResolverDefect`, which `maskErrors()` hides.
A resolver that returns a tagged-error instance as data counts as an Effect (a `TaggedError` is
yieldable) and fails with itself.

### effect(), effectRoute and effectRouteLayer

- `effect({ context })` is the plugin: it creates the `graphql <operation>` span (with child spans
  for the parse, validate and jit phases, backdated to their real start), links each resolver to
  its request's scope, records the operation type (so a guard knows a mutation), counts errors,
  and ends the span when the response body ends. `context` is the fork context for requests that
  do not come through a route (a bare `server.handle(request)` in a test).
- `effectRoute(server)` is the `HttpRouter` handler: register it for every method
  (`HttpRouter.add("*", "/graphql", …)`), so a GET reaches the core and gets its 405.
- `effectRouteLayer(server, { path, warnAfterMs })` is the route as a Layer, with a finalizer that
  drains the server on shutdown: it waits for every in-flight mutation to settle (logging the
  ones still running every `warnAfterMs`). Provide it with the same service and tracer layers as
  the app, so the drain runs before they are released.

```ts file=examples/orders/src/graphql.ts
export const appLayer = (schema: GraphQLSchema, options: AppOptions = {}) =>
  HttpRouter.serve(
    Layer.unwrap(
      Effect.map(Effect.context<Services>(), (services) =>
        effectRouteLayer(makeServer(schema, services, options)),
      ),
    ),
```

When a client leaves, its query and subscription fibers are interrupted and nothing is reported.
A mutation is never interrupted: a half-applied write is worse than a wasted one. Resolvers fork
without the request's `Scope`; one that needs a scope uses `Effect.scoped`. Build long-lived
resources (pools, intervals) in Layers, never lazily inside a resolver.

### runInRequest

`runInRequest(request, effect, services)` runs an Effect in the context factory (reading the
session, say) in the route's fiber context, so its span joins the request's trace (as a child of
the HTTP span, beside the operation span). It returns a Promise; when the client leaves, the
Effect is interrupted and the core answers 499 (a mutation then never starts).

```ts file=examples/orders/src/graphql.ts
      const session = await runInRequest(request, Session.read(request), services);
      return contextFor(session, request.headers);
```

### makeGuard

`makeGuard({ authorize, refuse, flags, timeout, headers })` builds `guard` and `guardStream` for
the request's context:

- `guard({ scopes, flag, effect })` checks the scopes (all of them, through `authorize`) and the
  feature flag, then runs `effect`. A refusal is `Effect.fail(refuse(…))`, the app's own error:
  an Exit, so no fiber and no span. The field answers with that error.
- The timeout (default 60 s) applies to queries only. A mutation gets no interrupting timeout. A
  timeout is a defect, `GuardTimeout`, not a typed failure, so resolver types stay
  `Effect<A, AppError, R>` and the app's exhaustive matcher never sees it; it becomes a 504
  (`onTimeout`).
- `guardStream({ scopes, flag, stream, setupTimeout })` guards a subscription source. A refusal
  is `Stream.fail(refuse(…))`, a Stream, not an Exit: the source starts and fails on its first
  pull, so the subscription answers with one SSE error event (the mapped `refuse(…)` error),
  then `event: complete`.
- `stream` is either the setup Effect that returns the Stream, or a Stream. Only a setup Effect
  gets a timeout, `setupTimeout` (default: the guard's `timeout`), and it bounds that setup alone,
  never the stream's lifetime. A Stream passed as it is gets no timeout at all, also when it was
  built from an Effect: `Stream.unwrap(Effect.gen(…))` is a Stream, so its setup is unbounded.
  Pass the `Effect.gen(…)` itself to have the setup bounded.

```ts file=examples/orders/src/models/Order.ts
  return ctx.guardStream({
    scopes: ["USER"],
    // The setup Effect itself, not Stream.unwrap of it: the guard bounds only the setup (the
    // order must exist), never the stream's lifetime. When the client leaves, the encoder calls
    // return(), and the Stream's scope closes its bus subscription.
    stream: Effect.gen(function* () {
```

`OperationType` is the `Context.Reference` the guard reads: `effect()` sets it per request, a
resolver with no request scope gets its own operation's type, and an Effect run outside the
server (a unit test) defaults to `"query"`.

## Plugin order

`apq()` first; `incremental()` before `jit()` (graphql-jit inlines `@defer`; `jit()` also
declines any operation with `@defer` or `@stream`); `reportErrors()` before `maskErrors()`, so the
report sees unmasked errors. Plugins that only observe or refuse (`effect()`, `serverTiming()`,
`readOnly()`, `maxDepth()`) can go anywhere: every `onExecute` hook runs before any executor.

## Contracts to know

- **One Request, one `handle()` call.** Every per-request state, the core's and the plugins', is
  keyed by the Request object. Never pass a Request to `handle()` again (on any server) while an
  earlier call on it is still in flight: until its response body has ended, not only until
  `handle()` has returned. Parallel calls need distinct Request objects. The core reads a POST's
  body, so replay a POST from a `request.clone()` taken before the first call. An overlap is not
  blocked, and the core's warning sees it only while the earlier `handle()` call has not returned
  yet: an overlap with a body still streaming (SSE, `@defer`, `@stream`) breaks the rule with no
  warning.
- **Plugin hooks that must not throw.** A `wrapExecution(request, run)` wrapper calls `run`
  exactly once, synchronously, and returns its result unchanged. It must be reentrant: the core
  may enter the wrappers again from inside `run` (nested calls, in another async context too);
  `effect()`'s wrapper runs `run` directly when its request's scope is in effect already. It must
  not throw, before or after `run`. An executor must not throw after it has called `next()`
  (report failure through its result or a rejected Promise). Breaking this is handled on a
  best-effort basis only, and work started in that instant may not be stopped. What the client
  gets depends on the response format and on when it throws. A JSON response gets an error result
  whose status is the core's default for it, 500, but the result hooks still run on it and may
  change it. `reportErrors()` gets the thrown value as the error's `originalError` when it is an
  `Error`. Behind `maskErrors()`, as in the example, a thrown plain `Error` is replaced, and the
  client gets a 200 for `application/json` and a 400 for `application/graphql-response+json`; a
  thrown `GraphQLError` or non-`Error` value keeps the 500. A streamed response (SSE, `@defer`, `@stream`) has its
  200 status already: a throw around the executor call, or on any pull of its body (the first one
  included), ends the stream with an error as its last payload. The core's logger records none of
  these. A throw while a stream closes or aborts is only logged.
- **Subscriptions run graphql-js's own steps in the core**: `createSourceEventStream`, then
  `executeSubscriptionEvent` per event, with the core holding the one source iterator it reads
  and closes (graphql 17.1's `subscribe()` may read and close different iterators of a plain
  AsyncIterable). They go out as GraphQL over SSE (`event: next` …, then `event: complete`); a
  source that fails sends one error event, then complete. `jit()` never claims a subscription.
- **graphql 17.1 drops a late subscription source.** A source resolver that settles after the
  client left is dropped by graphql without `return()`. A source whose setup acquires something
  before it returns (an async `subscribe`, an Effect that sets up and then returns a stream) must
  watch `info.getAbortSignal()` and release it itself. A `guardStream` source is never late: it
  is a Stream, returned at once, whose setup runs inside it, on the first pull, so its scope
  closes when the core calls `return()`.
- **`jit()` and hand-written schemas.** graphql-jit reads a field without a resolver as a plain
  property, where graphql-js calls a function-valued property. Gratos' generated schemas give
  every method field its own resolver, so they are safe; a hand-written schema with
  function-valued fields keeps them on graphql-js with `jit({ isSafe: (field, type) => … })`.
- **No `@defer` or `@stream` on mutations**: `incremental()` rejects them with a 400, so deferred
  work never outlives the shutdown drain.
- **Incremental delivery speaks `deferSpec=20220824`.** Apollo Client (4.1 or later) needs
  `incrementalHandler: new Defer20220824Handler()`; run `@stream` queries with
  `fetchPolicy: "no-cache"` (Apollo 4.1.0's changelog, #13078: the default merge can truncate a
  streamed list to its first chunk with that handler).

## Testing

A resolver is a plain Effect: run it with a fake layer, no server needed. The guard comes from the
same function the context factory uses.

```ts file=examples/orders/test/resolvers.test.ts
  it.effect("a guest cannot cancel an order", () =>
    Effect.gen(function* () {
      // The guard's refusal is an Exit: no fiber, no span, nothing of the Effect runs.
      const exit = yield* cancelOrder(guestCtx(), "o-1").pipe(
        Effect.provide(FakeApi.layer),
        Effect.exit,
      );

      expect(exit).toEqual(Exit.fail(new Forbidden()));
    }),
  );
```

Compare a typed failure that crossed a span (`Effect.withSpan`) with `Effect.flip` and the error
itself: its `Exit` carries a stack annotation, so it is not equal to a fresh `Exit.fail(error)`.

## The dev loop

`pnpm dev` runs `GRATS_DEV=1 node --watch-path=src/models --watch-path=src/services
--watch-preserve-output src/server.ts`. On boot, the lazy `@dblechoc/gratos/dev` step regenerates
the schema (writing only changed files) and loads the app; when the models do not build, the
server still starts and every request answers 500 `GRATS_ERROR` with the diagnostics until the
next good save. A save restarts the process (budget: 2 s from save to first good response),
which resets the APQ and JIT caches and drops open SSE subscriptions. A production start never loads the
compiler or TypeScript.
