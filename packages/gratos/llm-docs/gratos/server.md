# The Gratos server core

`gratos-server` is a small GraphQL-over-HTTP server. `createServer(options)` returns a
server object, and `createServer(options).handle(request)` is the request entry point: it takes a
`Request` and returns a `Promise<Response>`, so the server runs behind any fetch-style adapter.
The core never imports `effect`. The Effect layer is the separate
`gratos-server/effect` entry, documented in [effect.md](./effect.md); how Gratos differs
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

| Hook            | When                                                                                                                                                                                                | Sync |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `onServer`      | Once, at startup. May replace the schema (`control.replaceSchema`)                                                                                                                                  | no   |
| `onRequest`     | First, at `handle()` entry. Returning a Response answers the request                                                                                                                                | no   |
| `onParams`      | After the body is read, before the "no query" check (so APQ hash-only requests get here). Returns replacement params, or nothing. A throw is a 400, or a 200 SSE error event for an SSE-only client | no   |
| `onPhase`       | A finished phase: parse and validate on a cache miss; jit when it compiles, later (see below)                                                                                                       | yes  |
| `onContext`     | After the context factory, once the operation is known, before anything executes                                                                                                                    | no   |
| `onExecute`     | Every hook, in list order, before anything executes. Returns an executor to claim the operation, or throws to refuse it                                                                             | yes  |
| `wrapExecution` | Around each synchronous entry into the execution (the executor call, each source pull, each event…). Calls `run` once                                                                               | yes  |
| `onResult`      | Every payload: a result, each incremental payload, each subscription event. Returns a replacement, or nothing                                                                                       | yes  |
| `onResponse`    | Exactly once per request, on the Response before it goes to the transport (also a streamed one). Not a "stream ended" hook                                                                          | no   |

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

GraphQL over HTTP. The statuses below are what a JSON client gets. A client that accepts
`text/event-stream` and no JSON type (an SSE-only client) gets every GraphQL request error (a
parse, validation or variable error, an `onParams` throw, the drain, a refusal, a context or
executor failure) as a 200 with one SSE `next` event holding the errors, then `complete`.
Transport errors stay JSON with their status for every client, an SSE-only one included: a 406, a
415, a 413, and a 400 for the body or for a missing query. A 405 and a 499 have a null body.

| Request                                                                                              | Answer                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET, HEAD or any other method than POST                                                              | 405, `Allow: POST`, a null body                                                          |
| A body that is not JSON, not an object, or has a member of the wrong type                            | 400                                                                                      |
| No `query` once every `onParams` hook has run                                                        | 400                                                                                      |
| A Content-Type other than `application/json`                                                         | 415                                                                                      |
| An Accept that allows none of the four types below                                                   | 406                                                                                      |
| A body over `maxBodyBytes`                                                                           | 413, before `onParams`: unread when a plain-decimal Content-Length says so, else counted |
| `application/graphql-response+json` (the default): a parse, validation or variable error (no `data`) | 400                                                                                      |
| `application/graphql-response+json`: a result with a `data` entry, null included                     | 200                                                                                      |
| `application/json`, any well-formed request                                                          | 200                                                                                      |
| `gqlError(message, status)` on a result whose `data` is absent or null                               | that status (200–599, not 204, 205 or 304); with data, the status is left alone          |

The query check comes after `onParams`, and an `onParams` hook can return replacement params:
`apq()` supplies the query of a hash-only request this way, and that request gets its data.

Beyond the matrix:

| Case                                                                                                                                 | Answer                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An `onParams` hook throws                                                                                                            | 400, whatever status the error carries (its extensions are kept); an SSE-only client gets it as a 200 SSE error event                                                                                                                                                                                                |
| A subscription whose Accept does not allow `text/event-stream`                                                                       | 406, before its source starts                                                                                                                                                                                                                                                                                        |
| A query whose `@defer` or `@stream` defers part of its result, when the Accept does not allow `multipart/mixed`                      | 406                                                                                                                                                                                                                                                                                                                  |
| A mutation once `control.drain()` has begun                                                                                          | 503, `extensions.code: "SERVER_DRAINING"`; an SSE-only client gets it as a 200 SSE error event                                                                                                                                                                                                                       |
| The client left while the operation was being processed (from the context factory to the answer)                                     | 499 (`CLIENT_CLOSED_REQUEST`), a null body nobody reads; `onResponse` still runs. A mutation whose executor has started is not cancelled: it finishes, and its answer is built as usual. Earlier phases answer as they would anyway (an `onParams` throw is still a 400)                                             |
| A throw from `onRequest`, a rejected async `onServer`, or a throw that is not a GraphQLError from the context factory or `onContext` | 500, a masked "Unexpected error." (a throwing `onResponse` is only logged)                                                                                                                                                                                                                                           |
| An `Error` thrown by `onExecute`                                                                                                     | For a JSON response: 500, an "Unexpected error." that the result hooks see. `maskErrors()` drops its extensions, the status included, so the answer takes the default status: 400, or 200 under `application/json`. A subscription that accepts SSE gets it as a 200 SSE error event, with or without `maskErrors()` |
| A query whose `@defer` or `@stream` defers part of its result (with `incremental()`)                                                 | 200, `multipart/mixed; deferSpec=20220824`. A query that defers nothing (`@defer(if: false)`) gets a single result as usual                                                                                                                                                                                          |
| `@defer` or `@stream` on a mutation                                                                                                  | A validation error: 400, or 200 under `application/json`; an SSE-only client gets it as a 200 SSE error event                                                                                                                                                                                                        |
| A subscription                                                                                                                       | 200, GraphQL over SSE (`event: next` …, then `event: complete`)                                                                                                                                                                                                                                                      |

A synchronous throw from `onServer` escapes `createServer()`, so no server is made, as long as
startup has not yet awaited an earlier async `onServer`. Once it has, any later throw or rejection
fails startup instead: it is logged, `createServer()` returns a server, and every request then
gets the 500. A throw from `onRequest` and a
failed startup come before the Accept header is read, so their 500 is JSON for every client.

The four types a client can accept are `application/graphql-response+json`, `application/json`,
`multipart/mixed` and `text/event-stream`; each is exported as a constant
(`GRAPHQL_RESPONSE_JSON`, `APPLICATION_JSON`, `MULTIPART_MIXED`, `TEXT_EVENT_STREAM`). What a
client must accept depends on the operation:

- **A single result** (a query or a mutation): a JSON type. A client that accepts no JSON type gets
  the result as one SSE event when it accepts `text/event-stream`, else as one multipart part.
- **A query whose `@defer` or `@stream` defers part of its result**: `multipart/mixed`, else 406.
- **A subscription**: `text/event-stream`, else 406.
- **No `Accept` header** (or an empty one) allows every type: a single result uses
  `application/graphql-response+json`, and a subscription gets SSE.

## The shipped plugins, and their order

Every plugin comes from `gratos-server`, except `jit()`, which is the
`gratos-server/jit` entry: the main entry never loads `graphql-jit`, an optional peer
that only an app using `jit()` installs.

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

`control.drain({ warnAfterMs })` stops accepting mutations (each new one gets the 503, or a 200
`SERVER_DRAINING` SSE error event for an SSE-only client) and resolves once every in-flight
mutation has settled. It has no deadline: `warnAfterMs` only logs the ones still running, every
`warnAfterMs`. Queries and subscriptions are not drained. A drained server stays drained
(`draining()` never goes back to false), so build a new server rather than reuse a drained one;
the Effect layer's `effectRouteLayer` drains in its finalizer, so build the server inside the
layer ([effect.md](./effect.md)).
