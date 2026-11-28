# gratos

The compiler: [Grats](https://github.com/captbaritone/grats) (vendored from v0.0.36), taught to
read `Effect.Effect` and `Stream.Stream` return types, on the TypeScript 7 API. Its CLI is
`gratos`. In this repository Node runs it from source, with no build step; the published package
ships the JavaScript and declarations its release build emits (`prepack`).

```sh
npm install gratos effect @effect/platform-node graphql
```

`effect`, `@effect/platform-node` and `graphql` are peers, so the app's own copies are the ones
the compiler's `/dev` entry and the generated schema use. `typescript` is an exact dependency
(7.0.2): the compiler uses TypeScript 7's API under `typescript/unstable/`, which can change in
any release, so an app on another TypeScript 7 version gets a second copy for the compiler, on
purpose. The package is ESM only and needs Node 26.13 or later.

- [How Gratos differs from Grats](https://github.com/sync/gratos/blob/main/packages/gratos/llm-docs/gratos/differences.md): what was removed (watch mode,
  `--fix`, `locate`, the editor plugin), what was renamed, and which of the vendored pages it
  affects. Read it before following one of them.
- [Effect resolvers](https://github.com/sync/gratos/blob/main/packages/gratos/llm-docs/gratos/effect.md): the return types the compiler accepts, and the
  server's Effect layer.
- [The server core](https://github.com/sync/gratos/blob/main/packages/gratos/llm-docs/gratos/server.md): `createServer`, its hooks, the HTTP matrix and
  the plugins (`gratos-server`).
- The rest of [`llm-docs/`](https://github.com/sync/gratos/tree/main/packages/gratos/llm-docs) is upstream Grats' documentation, unchanged.

Models import Grats' types from this package:

```ts file=examples/orders/src/models/Order.ts
import type { Float, ID, Int } from "gratos";
```

A package regenerates its schema with `gratos`, and CI checks it is up to date with
`gratos --check`:

```json file=examples/orders/package.json
    "codegen": "gratos --tsconfig src/tsconfig.json",
    "codegen:check": "gratos --check --tsconfig src/tsconfig.json",
```

The dev loop's boot step is the lazy `gratos/dev` entry: it regenerates the schema and
loads the app, and a production start never loads the compiler ("The dev loop" in
[effect.md](https://github.com/sync/gratos/blob/main/packages/gratos/llm-docs/gratos/effect.md)).

The vendored files and how they differ from upstream are listed in `vendor-changes.json`;
`pnpm --filter gratos vendor:verify` compares them with upstream v0.0.36.
