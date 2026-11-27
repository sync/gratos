# The Gratos server core

`@dblechoc/gratos-server` is a small GraphQL-over-HTTP server. `createServer(options)` returns a
server object, and `createServer(options).handle(request)` is the request entry point: it takes a
`Request` and returns a `Promise<Response>`, so the server runs behind any fetch-style adapter.
The core never imports `effect`. The Effect layer is the separate
`@dblechoc/gratos-server/effect` entry, documented in [effect.md](./effect.md); how Gratos differs
from Grats is in [differences.md](./differences.md).

The source of truth is `packages/gratos-server/src/core/types.ts`, whose comments spell out each
contract in full. This page is the map. Code blocks tagged `file=` are compared with that file by
`examples/orders/test/docs.test.ts`, and `packages/gratos-server/test/docs.test.ts` checks that
the hook and option tables below name every hook of `Plugin` and every option of `createServer`.

## createServer

The example app's server: the generated schema wrapped by `effectSchema`, a context factory, and
the plugins in their documented order.

```ts file=examples/orders/src/graphql.ts
  return createServer<Ctx>({
    schema: effectSchema(schema, { failure, isFailure: isAppError }),
    context: async (request) => {
      // Same fiber context and span as the route.
      const session = await runInRequest(request, Session.read(request), services);
      return contextFor(session, request.headers);
    },
```

Options:

| Option              | Default   | What it does                                                                                                                                                                                     |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`            | required  | The executable schema. A Gratos schema with Effect resolvers is wrapped by `effectSchema` first                                                                                                  |
| `rootValue`         | none      | The root value of every operation                                                                                                                                                                |
| `context`           | none      | `(request, { operation, document, params }) => Ctx`, after the operation is known. Required when `Ctx` excludes `undefined`                                                                      |
| `plugins`           | `[]`      | The plugins, in order (see below)                                                                                                                                                                |
| `documentCacheSize` | 1000      | Size of the validated-document LRU, keyed by (schema generation, query text)                                                                                                                     |
| `maxTokens`         | 10000     | Maximum lexical tokens per document (graphql's `maxLexicalTokens`)                                                                                                                               |
| `maxBodyBytes`      | 1 MiB     | The largest request body the core reads; a larger one gets a 413. A positive safe integer, or `Infinity` for no limit; anything else (0, a negative number, a fraction, NaN) throws a RangeError |
| `logger`            | `console` | `{ warn, error }`, for drain warnings and failing hooks                                                                                                                                          |

```ts file=packages/gratos-server/src/core/types.ts
  readonly maxBodyBytes?: number | undefined;
```

`createServer` returns `{ handle, control }`. `control` has `schema()`, `generation()`,
`replaceSchema(schema)` (a new generation: in-flight requests finish on the one they pinned),
`drain({ warnAfterMs })` and `draining()`. Per request, a plugin reads `signalOf(req)` (the core's
abort signal), `startOf(req)` (when `handle()` received it) and `mutationOf(req)` (a mutation's
`started`, `settled` and `status`).

```ts file=packages/gratos-server/src/core/types.ts
  readonly handle: (request: Request) => Promise<Response>;
  readonly control: ServerControl;
```

One Request object, one `handle()` call: every per-request state is keyed by the Request, so
never pass it again while an earlier call on it is in flight (see `Server.handle` in `types.ts`,
and "Contracts to know" in [effect.md](./effect.md)).

## Hooks, in call order

A plugin is an object of optional hooks. Hook lists are built once, at startup, so a hook no
plugin defines costs nothing. The synchronous ones run in the hot loop.

The table gives the order for a query whose document is not cached yet (a cache miss): its parse
and validate phases reach `onPhase` before `onContext`. A cached document reports no phase there.

| Hook            | When                                                                                                                       | Sync |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ---- |
| `onServer`      | Once, at startup. May replace the schema (`control.replaceSchema`)                                                         | no   |
| `onRequest`     | First, at `handle()` entry. Returning a Response answers the request                                                       | no   |
| `onParams`      | After the body is read, before the "no query" check (so APQ hash-only requests get here). A throw is a 400                 | no   |
| `onPhase`       | A finished phase: parse and validate on a cache miss; jit when it compiles, later (see below)                              | yes  |
| `onContext`     | After the context factory, once the operation is known, before anything executes                                           | no   |
| `onExecute`     | Every hook, in list order, before anything executes. Returns an executor to claim the operation, or throws to refuse it    | yes  |
| `wrapExecution` | Around each synchronous entry into the execution (the executor call, each source pull, each event…). Calls `run` once      | yes  |
| `onResult`      | Every payload: a result, each incremental payload, each subscription event. Returns a replacement, or nothing              | yes  |
| `onResponse`    | Exactly once per request, on the Response before it goes to the transport (also a streamed one). Not a "stream ended" hook | no   |

`jit()` reports its `jit` phase from inside its executor, after the request has entered
`wrapExecution`. With `after` above 1, the request that compiles finds its document cached, so
that request reaches the hooks in this order: `onRequest`, `onParams`, `onContext`, `onExecute`,
`wrapExecution`, `onPhase`, `onResult`, `onResponse`.

Two more members are read once, at startup: `validationRules` (run with graphql's specified rules
on every document the cache does not hold yet) and `hideSuggestions` (`maskErrors()` sets it).

Rules a plugin keeps:

- **Refusals do not depend on order.** Every `onExecute` hook runs before any executor is called,
  and a thrown `GraphQLError` refuses the operation whatever earlier hooks returned. The first
  executor returned is the one called; its `next()` runs the next claim, else the default
  executor. A subscription always runs through graphql-js (an executor returned for one is never
  called).
- **The body rule.** A plugin that replaces the Response in `onResponse` keeps `res.body`, reusing
  it or wrapping it in a pass-through stream, because body wrappers (the Effect layer's span end)
  depend on it. `serverTiming()` is the reference:

```ts file=packages/gratos-server/src/plugins/serverTiming.ts
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
```

- **`wrapExecution` and executors must not throw** (after `run` or `next()`); see "Plugin hooks
  that must not throw" in [effect.md](./effect.md).

A whole plugin, `readOnly()`:

```ts file=packages/gratos-server/src/plugins/readOnly.ts
export const readOnly = (): Plugin => ({
  name: "readOnly",
  onExecute: ({ operation }) => {
    if (operation.operation === "mutation") {
      throw gqlError("This server is read-only.", 403, { code: "READ_ONLY" });
    }
    return undefined;
  },
});
```

## The HTTP matrix

GraphQL over HTTP. A transport error (405, 406, 415, 413, a 400 for the body) is JSON with its
status for every client, an SSE-only one included.

| Request                                                                                              | Answer                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET, HEAD or any other method than POST                                                              | 405, `Allow: POST`, a null body                                                          |
| A body that is not JSON, not an object, has a member of the wrong type, or has no `query`            | 400                                                                                      |
| A Content-Type other than `application/json`                                                         | 415                                                                                      |
| An Accept that allows none of the four types below                                                   | 406                                                                                      |
| A body over `maxBodyBytes`                                                                           | 413, before `onParams`: unread when a plain-decimal Content-Length says so, else counted |
| `application/graphql-response+json` (the default): a parse, validation or variable error (no `data`) | 400                                                                                      |
| `application/graphql-response+json`: a result with a `data` entry, null included                     | 200                                                                                      |
| `application/json`, any well-formed request                                                          | 200                                                                                      |
| `gqlError(message, status)` on a result whose `data` is absent or null                               | that status (200–599, not 204, 205 or 304); with data, the status is left alone          |

Beyond the matrix:

| Case                                                                                                                               | Answer                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| An `onParams` hook throws                                                                                                          | 400, whatever status the error carries (its extensions are kept)                   |
| A subscription without `Accept: text/event-stream`                                                                                 | 406                                                                                |
| A mutation once `control.drain()` has begun                                                                                        | 503, `extensions.code: "SERVER_DRAINING"`                                          |
| The client left before the answer                                                                                                  | 499 (`CLIENT_CLOSED_REQUEST`), an empty body nobody reads; `onResponse` still runs |
| A throw from `onRequest`, one that is not a GraphQLError from the context factory, `onContext` or `onExecute`, or a failed startup | 500, a masked "Unexpected error." (a throwing `onResponse` is only logged)         |
| `@defer` or `@stream` (with `incremental()`)                                                                                       | 200, `multipart/mixed; deferSpec=20220824`; on a mutation, a 400                   |
| A subscription                                                                                                                     | 200, GraphQL over SSE (`event: next` …, then `event: complete`)                    |
| A request error for a client that accepts `text/event-stream` and no JSON type                                                     | 200, one SSE `next` event with the errors, then `complete`                         |

The four types a client can accept are `application/graphql-response+json`, `application/json`,
`multipart/mixed` and `text/event-stream`; each is exported as a constant
(`GRAPHQL_RESPONSE_JSON`, `APPLICATION_JSON`, `MULTIPART_MIXED`, `TEXT_EVENT_STREAM`).

## The shipped plugins, and their order

| Plugin                    | What it does                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apq({ store, max })`     | Apollo's automatic persisted queries. Stores a query only once it has passed validation. Never claims an operation                      |
| `incremental()`           | Adds `@defer` and `@stream` to the schema and claims the queries that use them; rejects them on mutations                               |
| `jit({ after, isSafe })`  | graphql-jit from the `after`-th use (default 3). Declines subscriptions, `@defer`/`@stream`, `@oneOf` variables and `jit: false` fields |
| `reportErrors(log)`       | Hands every error of every payload to `log`, skipping `cancelled()` ones                                                                |
| `maskErrors({ message })` | Replaces every unexpected error's message (default "Unexpected error."); turns on `hideSuggestions`                                     |
| `serverTiming()`          | A `Server-Timing` header with each phase and the total                                                                                  |
| `maxDepth(limit)`         | Refuses an operation nested deeper than `limit` (400, `MAX_DEPTH_EXCEEDED`)                                                             |
| `readOnly()`              | Refuses every mutation (403, `READ_ONLY`)                                                                                               |

The order: `apq()` first, so it sees the query before any executor; `incremental()` before
`jit()` (graphql-jit inlines `@defer`); `reportErrors()` before `maskErrors()`, so the report sees
the unmasked errors. Plugins that only observe or refuse (`serverTiming()`, `maxDepth()`,
`readOnly()`, the Effect layer's `effect()`) go anywhere. The example app's list:

```ts file=examples/orders/src/graphql.ts
    plugins: [
      apq(),
      incremental(),
      jit({ after: 3 }),
      // `context`: resolvers find the app's services also when the server is used without a
      // route (makeServer(...).handle(request) in a test); a route forks with its own context.
      effect({ context: services }),
      serverTiming(),
      reportErrors((error) => {
        report(error);
      }),
      maskErrors(),
    ],
```

## Shutdown

`control.drain({ warnAfterMs })` stops accepting mutations (each new one gets the 503) and
resolves once every in-flight mutation has settled. It has no deadline: `warnAfterMs` only logs
the ones still running, every `warnAfterMs`. Queries and subscriptions are not drained. A drained
server stays drained (`draining()` never goes back to false), so build a new server rather than
reuse a drained one; the Effect layer's `effectRouteLayer` drains in its finalizer, so build the
server inside the layer ([effect.md](./effect.md)).
