# The orders example

A small GraphQL API built the Gratos way: the schema comes from annotated TypeScript, every
resolver returns an `Effect` (or a `Stream` for a subscription), and the server runs each
resolver in the request's fiber context, with one trace per request.

- **Types:** `Order` (`id`, `total`, `status`, `customer`) and `User` (`id`, `name`).
- **Fields:** the queries `order`, `orders(userId, first)` and `user`, the mutation
  `cancelOrder` and the subscription `orderChanged`.
- **Errors:** one union, `NotFound | Forbidden`, mapped to GraphQL errors with an exhaustive
  `Match` (`src/graphql.ts`).
- **Services:** `Api` (the orders backend) and `Bus` (order events), with `FakeApi.layer`, an
  in-memory backend for development and tests.
- **Wiring:** `src/graphql.ts` (the server, the context factory, the plugins), `src/server.ts`
  (NodeHttpServer) and `src/tracing.ts` (the optional OTLP tracer).

The Effect chapter of the compiler's docs,
[`packages/gratos/llm-docs/gratos/effect.md`](../../packages/gratos/llm-docs/gratos/effect.md),
explains every piece in depth.

## Run it

```sh
pnpm start   # production: the committed schema, no compiler
pnpm dev     # live rebuild: a save in src/models or src/services restarts the server
```

The server listens on `http://127.0.0.1:4000/graphql` (`PORT` and `HOST` change it). The session
is a bearer token naming a user of the fake backend (`u-1` or `u-2`); without one you are a
guest, and every guarded field answers `Forbidden`.

This is demo authentication, not a pattern to copy. The seed user ids are the credentials: anyone
who knows one is signed in as that user. And the guard checks scopes only, never ownership: any
signed-in user may read, cancel and watch any user's orders (`orders(userId: "u-2")` works for
`u-1`). A real app verifies a real token in `Session.read` and checks ownership in the resolver or
the backend.

```sh
curl -s localhost:4000/graphql -H 'content-type: application/json' \
  -H 'authorization: Bearer u-1' \
  -d '{"query":"{ orders(userId: \"u-1\") { id total customer { name } } }"}'

# A subscription is GraphQL over SSE: a `next` event with the order now, then one per change.
curl -sN localhost:4000/graphql -H 'content-type: application/json' \
  -H 'accept: text/event-stream' -H 'authorization: Bearer u-1' \
  -d '{"query":"subscription { orderChanged(id: \"o-1\") { id status } }"}'
```

## Add a resolver in five steps

A new field needs one tagged function or method and one generator run. You do not register it
anywhere. Here is the `user` query field, as it is in this example.

### 1. Write

A tagged class or function that returns an `Effect` (a `Stream` for a subscription field). The
tag names the GraphQL kind: `@gqlType`, `@gqlField`, `@gqlQueryField`, `@gqlMutationField`,
`@gqlSubscriptionField`.

```ts file=examples/orders/src/models/User.ts
/** A user who places orders. @gqlType */
export class User {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  name: string;

  constructor(row: UserRow) {
    this.id = row.id;
    this.name = row.name;
  }
}

/** A user, by id. @gqlQueryField */
export function user(ctx: Ctx, id: ID): Effect.Effect<User, AppError, Services> {
  return ctx.guard({
    scopes: ["USER"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      return new User(yield* api.user_get({ id }));
    }),
  });
}
```

Write `Effect.Effect` and `Stream.Stream`, the qualified names: Gratos unwraps only those. The
Effect is the outermost wrapper (never inside a `Promise` or an array), and its error type is the
app's union, `AppError`.

### 2. Generate

```sh
pnpm codegen   # gratos --tsconfig src/tsconfig.json
```

Gratos writes `src/generated/schema.graphql` and `src/generated/schema.ts` (committed; never edit
them). The field's type is the Effect's success type:

```graphql file=examples/orders/src/generated/schema.graphql
  """A user, by id."""
  user(id: ID!): User @semanticNonNull
```

and each field gets its own resolver, which calls yours with the arguments in your order:

```ts file=examples/orders/src/generated/schema.ts
                    resolve(_source, args, context) {
                        return queryUserResolver(context, args.id);
                    }
```

`pnpm dev` does this step for you on every save. CI runs `gratos --check`, which fails when the
committed files are stale.

### 3. Nothing

There is no step 3: nothing registers the new field. `effectSchema` wraps every resolver of the
schema once, at startup, so the new field runs as an Effect with the request's services, trace
and abort signal, and its typed failures are mapped by the app's `failure` matcher.
`src/graphql.ts` does not change.

### 4. Guard

Call the guard once per field. It checks the session's scopes (and feature flags), then runs the
Effect; a query gets a timeout (60 s by default), a mutation none (it always runs to its end). A
refusal is the app's own `Forbidden`, failed as an `Exit`: it costs no fiber and no span.

```ts file=examples/orders/src/models/User.ts
  return ctx.guard({
    scopes: ["USER"],
    effect: Effect.gen(function* () {
```

A subscription uses `ctx.guardStream` (`orderChanged` in `src/models/Order.ts`). Its refusal is a
`Stream.fail` of the same `Forbidden`: the subscription answers with one SSE error event, then
`event: complete`. Give it the setup `Effect` that returns the `Stream`, not a `Stream.unwrap` of
it: only a setup Effect gets the timeout (`setupTimeout`, default 60 s), which bounds the setup
alone and never ends an idle subscription. A `Stream` passed as it is gets no timeout at all.

### 5. Test

A resolver is a plain Effect: run it with a fake layer. No schema, no server, no HTTP.

```ts file=examples/orders/test/resolvers.test.ts
it.effect("a missing user is NotFound", () =>
  Effect.gen(function* () {
    // The failure crossed the Api's span, so its Exit carries a stack annotation: compare the
    // typed error itself.
    const error = yield* user(userCtx(), "nope").pipe(Effect.provide(FakeApi.layer), Effect.flip);

    expect(error).toEqual(new NotFound({ what: "user" }));
  }),
);
```

`test/e2e.test.ts` then runs the same fields over real HTTP with Apollo Client.

## Rules for a new resolver

- **Return an Effect.** Never call `Effect.runPromise` in a resolver: that starts a new root
  fiber and a new trace, outside the request's services, timeout and abort.
- **Fail with a tag.** Add each new error to the app's error union (`src/services/errors.ts`).
  The exhaustive `Match` in `src/graphql.ts` then fails the type check until you map it.
- **Guard once.** Call the guard one time for each field. It checks the scopes and sets the
  timeout.
- **Stream for live data.** Return a `Stream` for a subscription. Its scope closes when the
  client leaves, which releases what it acquired (here, the bus subscription).

The docs check (`test/docs.test.ts`) keeps this page honest: every code block tagged with a
`file=` is compared with that file, so the walkthrough above is the code that compiles and runs.

## The wiring

`src/graphql.ts` follows the spec's "wire it up": the generated schema wrapped once by
`effectSchema`, a context factory that reads the session with `runInRequest` (its span joins the
request's trace), and the plugins.

```ts file=examples/orders/src/graphql.ts
    context: async (request) => {
      // Same fiber context and span as the route.
      const session = await runInRequest(request, Session.read(request), services);
      return contextFor(session, request.headers);
    },
    plugins: [
      apq(),
      incremental(),
      jit({ after: 3 }),
```

Plugin order: `apq()` first, `incremental()` before `jit()` (graphql-jit would inline `@defer`),
`reportErrors()` before `maskErrors()` (the report sees the unmasked errors). `appLayer` serves
it with `effectRouteLayer` on the Effect HTTP router, provided with `FakeApi.layer`: on shutdown
the route's finalizer waits for in-flight mutations before the services are released.

## Tracing

Each request is one trace. Its root is the HTTP span, with two children: `session.read` (the
context factory's `runInRequest`) and `graphql <operation>`, which holds the phases (`parse`,
`validate`) and the resolver spans, with the backend's `rpc …` spans below them. A
subscription's operation span stays open while events flow and ends after the last one.
`test/trace.test.ts` checks all of it on this wiring, with an in-memory tracer.

To export the traces, point `OTEL_EXPORTER_OTLP_ENDPOINT` at an OTLP/HTTP collector (the
OpenTelemetry Collector, Jaeger, or a vendor's endpoint):

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm start   # posts to …/v1/traces
```

`src/server.ts` builds the tracer and hands it to the app:

```ts file=examples/orders/src/server.ts
const tracing = tracingLayer().pipe(Layer.provide(FetchHttpClient.layer));
```

`src/tracing.ts` reads the variable. Without it the layer is empty and the exporter is never
imported (`test/production.test.ts` checks that a production start loads none of it):

```ts file=examples/orders/src/tracing.ts
export const tracingLayer = (
  options: TracingOptions = {},
): Layer.Layer<never, never, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const endpoint = yield* Config.option(Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT"));
      if (Option.isNone(endpoint)) {
        return Layer.empty;
      }
      const { OtlpSerialization, OtlpTracer } = yield* Effect.promise(
        () => import("effect/observability"),
      );
      return OtlpTracer.layer({
        url: tracesUrl(endpoint.value),
        resource: { serviceName: "orders-example" },
        exportInterval: options.exportInterval,
        shutdownTimeout: options.shutdownTimeout,
      }).pipe(Layer.provide(OtlpSerialization.layerJson));
    }).pipe(Effect.orDie),
  );
```

`appLayer` provides the tracer with the services, outside the route layer, as the Effect chapter
asks: on shutdown the route drains first, then the services are released, then the tracer, whose
last export carries the drained requests' spans.

```ts file=examples/orders/src/graphql.ts
  ).pipe(
    Layer.provide(options.backend ?? FakeApi.layer),
    Layer.provide(options.tracing ?? Layer.empty),
  );
```

The exporter is Effect's own (`effect/observability`; its OTLP modules are marked unstable in
Effect 4.1.5). It posts buffered spans every 5 s and once more on shutdown, which waits for that
last post up to 3 s. A test swaps the tracer with `appLayer`'s `tracing` option:
`test/support/serve.ts` passes the in-memory one, and `test/otlp.test.ts` runs the OTLP one
against a controlled HTTP client.

## Apollo Client

`@defer` and `@stream` go out as `multipart/mixed; deferSpec=20220824`. Give Apollo Client (4.1 or
later; this repo pins 4.3.8) the matching handler explicitly, and the session's bearer token (the
demo's: a seed user id), or every guarded field answers `Forbidden`:

```ts
import { ApolloClient, gql, HttpLink, InMemoryCache } from "@apollo/client";
import { Defer20220824Handler } from "@apollo/client/incremental";

const uri = "http://127.0.0.1:4000/graphql";
const userId = "u-1";
```

```ts file=examples/orders/test/e2e.test.ts
const client = new ApolloClient({
  link: new HttpLink({ uri, headers: { authorization: `Bearer ${userId}` } }),
  cache: new InMemoryCache(),
  incrementalHandler: new Defer20220824Handler(),
});
```

Then query (call `client.stop()` when you are done with the client):

```ts file=examples/orders/test/e2e.test.ts
const result = await client.query({
  query: gql`
    query StreamedOrders($userId: ID!) {
      orders(userId: $userId) @stream(initialCount: 1) {
        id
        total
      }
    }
  `,
  variables: { userId },
  fetchPolicy: "no-cache",
});
```

`test/e2e.test.ts` runs this very code against the app.

Run `@stream` queries with `fetchPolicy: "no-cache"`: Apollo 4.1.0's changelog (#13078) says that
with this handler the cache's default merge truncates a streamed list to its first chunk. On the
pinned 4.3.8 a streamed root list arrives whole with the cache too (`test/e2e.test.ts` records
it), but `no-cache` stays the safe choice. Apollo's HTTP link has no SSE transport: subscribe
over SSE with `fetch` (or an SSE client), as the end-to-end test does.

## Benchmarks

```sh
pnpm bench:compiler        # files loaded, cold build and peak RSS of `gratos` on this app
pnpm bench:subscriptions   # SSE throughput of orderChanged: the Effect Stream vs a plain source
```

Both print JSON and take `--record`, which writes `bench/orders.json` and
`bench/subscriptions.json` at the repo root (with the machine they ran on). The dev loop's
save-to-first-good-response times are printed by `test/dev.test.ts`.

`bench:subscriptions` compares two complete source paths, from a publish to an SSE event through
the app's own server: the app's (`Bus.publish` into a PubSub, the topic's subscription behind
`ctx.guardStream`, each pull through `Stream.toAsyncIterableWith`) and a hand-written async
iterator over an in-memory FIFO. Its ratio is the cost of the whole Effect path against a minimal
one, not of one mechanism in isolation.
