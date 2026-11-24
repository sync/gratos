# gratos

An Effect-native reimplementation of [Grats](https://github.com/captbaritone/grats), with a
small plugin-based GraphQL server core and an Effect layer that runs every resolver in the
request's fiber context.

The approved build plan is in [`docs/plan.html`](docs/plan.html). Agent and contributor
rules are in [`AGENTS.md`](AGENTS.md).

```sh
npm i -g pnpm@12.23.0   # Node 26 has no corepack
pnpm install
pnpm check              # format, lint, typecheck, test, codegen check
```
