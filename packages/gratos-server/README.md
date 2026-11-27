# @dblechoc/gratos-server

A small GraphQL-over-HTTP server core: `createServer(options).handle(request)` takes a Web
`Request` and returns a `Promise<Response>`, so it runs behind any fetch-style adapter. It has a plugin
system and ships the plugins the example uses (`apq()`, `incremental()`, `jit()`,
`reportErrors()`, `maskErrors()`, `serverTiming()`, `maxDepth()`, `readOnly()`). The core never
imports `effect`; the Effect layer is the `@dblechoc/gratos-server/effect` entry. `jit()` is the
`@dblechoc/gratos-server/jit` entry, so the core never loads `graphql-jit` unless the app imports
it.

- [The server core](../gratos/llm-docs/gratos/server.md): `createServer` and its options, the
  hooks in call order, the HTTP matrix, the plugins and their order.
- [Effect resolvers and the Effect layer](../gratos/llm-docs/gratos/effect.md): `effectSchema`,
  `effect()`, `effectRoute` and `effectRouteLayer`, `runInRequest`, `makeGuard`, and the
  contracts to know.
- [How Gratos differs from Grats](../gratos/llm-docs/gratos/differences.md).

The three entries:

```ts file=examples/orders/src/graphql.ts
import {
  apq,
  createServer,
  gqlError,
  incremental,
  maskErrors,
  reportErrors,
  serverTiming,
} from "@dblechoc/gratos-server";
import type { Server } from "@dblechoc/gratos-server";
import {
  effect,
  effectRouteLayer,
  effectSchema,
  runInRequest,
} from "@dblechoc/gratos-server/effect";
import { jit } from "@dblechoc/gratos-server/jit";
```

The contract itself is `src/core/types.ts`: its comments are the full reference, and
`examples/orders` is the working app.
