# Gratos agent guide

Gratos is an Effect-native reimplementation of [Grats](https://github.com/captbaritone/grats)
(vendored from its last TypeScript release, v0.0.36) plus a small GraphQL server core,
a plugin system and an Effect layer. The approved plan is `docs/plan.html`; it is the
source of truth for scope, milestones and acceptance criteria.

## Toolchain

- Node 26 (`.node-version`). Packages run from source through Node's type stripping; there is no build step.
- pnpm 12 (`packageManager`). Node 26 has no corepack: install with `npm i -g pnpm@12.23.0`. In CI, `pnpm/action-setup`.
- Turborepo: `pnpm check` runs everything (`turbo run check`). Read `node_modules/turbo/docs` before changing `turbo.json`.
- TypeScript 7 (`tsc --noEmit` per package). Grats talks to TypeScript only through `packages/grats/src/ts/`.
- oxfmt (`pnpm fmt`) and oxlint with `@cloudflare/oxlint-config` (`pnpm lint`).
- vitest with `@effect/vitest` (`it.effect`).

## Rules

- Never edit generated files (`**/src/generated/*`). Run `pnpm codegen` and commit the result.
- All TypeScript compiler API access goes through `packages/grats/src/ts/`.
- Never use `--preserve-symlinks`, injected dependencies or `pnpm deploy`: they break type stripping of workspace packages.
- Only erasable TypeScript syntax (`erasableSyntaxOnly`): no enums, namespaces or parameter properties.
- The installed grats skill refers to `node_modules/grats/llm-docs/…`. In this repo those docs live in `packages/grats/llm-docs/`.

## Delivery

One pull request per milestone, run as a full send: prove the change, review it with
sol-loop, file the PR, babysit CodeRabbit and CI, and squash-merge with
`gh pr merge --squash --match-head-commit <sha>` once the merge gate in `docs/plan.html`
passes. When a change is uncertain, stop and suggest a council.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
