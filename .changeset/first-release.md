---
"@dblechoc/gratos": minor
"@dblechoc/gratos-server": minor
---

The first release of Gratos.

`@dblechoc/gratos` is Grats, the GraphQL server generator for TypeScript, on the TypeScript 7 API: annotate your types and functions with docblock tags, and the `gratos` CLI writes the GraphQL schema. Resolvers can return `Effect.Effect` and `Stream.Stream`, and `@dblechoc/gratos/dev` keeps a dev server up while it rebuilds the schema on every save.

`@dblechoc/gratos-server` is a small, plugin-based GraphQL-over-HTTP server for Web `Request` and `Response`. It streams `@defer` and `@stream` results and subscriptions over SSE, bounds the request body, can run on `graphql-jit`, and `@dblechoc/gratos-server/effect` runs Effect and Stream resolvers with one trace per request and a drained shutdown.

Both packages need Node 26.13 or later, and share one version.
