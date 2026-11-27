# @dblechoc/gratos

The compiler: [Grats](https://github.com/captbaritone/grats) (vendored from v0.0.36), taught to
read `Effect.Effect` and `Stream.Stream` return types, on the TypeScript 7 API. Its CLI is
`gratos`. Node runs it from source, with no build step.

- [How Gratos differs from Grats](llm-docs/gratos/differences.md): what was removed (watch mode,
  `--fix`, `locate`, the editor plugin), what was renamed, and which of the vendored pages it
  affects. Read it before following one of them.
- [Effect resolvers](llm-docs/gratos/effect.md): the return types the compiler accepts, and the
  server's Effect layer.
- [The server core](llm-docs/gratos/server.md): `createServer`, its hooks, the HTTP matrix and
  the plugins (`@dblechoc/gratos-server`).
- The rest of [`llm-docs/`](llm-docs) is upstream Grats' documentation, unchanged.

Models import Grats' types from this package:

```ts file=examples/orders/src/models/Order.ts
import type { Float, ID, Int } from "@dblechoc/gratos";
```

A package regenerates its schema with `gratos`, and CI checks it is up to date with
`gratos --check`:

```json file=examples/orders/package.json
    "codegen": "gratos --tsconfig src/tsconfig.json",
    "codegen:check": "gratos --check --tsconfig src/tsconfig.json",
```

The dev loop's boot step is the lazy `@dblechoc/gratos/dev` entry: it regenerates the schema and
loads the app, and a production start never loads the compiler ("The dev loop" in
[effect.md](llm-docs/gratos/effect.md)).

The vendored files and how they differ from upstream are listed in `vendor-changes.json`;
`pnpm --filter @dblechoc/gratos vendor:verify` compares them with upstream v0.0.36.
