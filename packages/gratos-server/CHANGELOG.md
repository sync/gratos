# gratos-server

## 0.1.0

### Minor Changes

- [#19](https://github.com/sync/gratos/pull/19) [`2e75f9b`](https://github.com/sync/gratos/commit/2e75f9bf7d8805ed08e0cb0c3035f82e2c9654c6) Thanks [@sync](https://github.com/sync)! - The first release of Gratos.

  `gratos` is Grats, the GraphQL server generator for TypeScript, on the TypeScript 7 API: annotate your types and functions with docblock tags, and the `gratos` CLI writes the GraphQL schema. Resolvers can return `Effect.Effect` and `Stream.Stream`, and `gratos/dev` keeps a dev server up while it rebuilds the schema on every save.

  `gratos-server` is a small, plugin-based GraphQL-over-HTTP server for Web `Request` and `Response`. It streams `@defer` and `@stream` results and subscriptions over SSE, bounds the request body, can run on `graphql-jit`, and `gratos-server/effect` runs Effect and Stream resolvers with one trace per request and a drained shutdown.

  Both packages need Node 26.13 or later, and share one version.
