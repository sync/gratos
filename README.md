# gratos

An Effect-native reimplementation of [Grats](https://github.com/captbaritone/grats), with a
small plugin-based GraphQL server core and an Effect layer that runs every resolver in the
request's fiber context.

- [`packages/gratos`](packages/gratos): the compiler (`@dblechoc/gratos`, CLI `gratos`). It reads
  `Effect.Effect` and `Stream.Stream` return types.
- [`packages/gratos-server`](packages/gratos-server): the GraphQL server core and its plugins
  (`@dblechoc/gratos-server`), and the Effect layer (`@dblechoc/gratos-server/effect`).
- [`examples/orders`](examples/orders): the example app. Its README adds a resolver in five steps
  (write, generate, nothing, guard, test) and lists the rules for a new resolver.

The Effect chapter of the docs is
[`packages/gratos/llm-docs/gratos/effect.md`](packages/gratos/llm-docs/gratos/effect.md), beside
Grats' own docs. The approved build plan is in [`docs/plan.html`](docs/plan.html). Agent and
contributor rules are in [`AGENTS.md`](AGENTS.md).

```sh
npm i -g pnpm@12.23.0   # Node 26 has no corepack
pnpm install
pnpm check              # format, lint, typecheck, test, codegen check
```
