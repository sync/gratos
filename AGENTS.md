# Gratos agent guide

Gratos is an Effect-native reimplementation of [Grats](https://github.com/captbaritone/grats)
(vendored from its last TypeScript release, v0.0.36) plus a small GraphQL server core,
a plugin system and an Effect layer. The approved plan is `docs/plan.html`; it is the
source of truth for scope, milestones and acceptance criteria.

## Packages

- `@dblechoc/gratos` (`packages/gratos`): the Effect-aware compiler, vendored from Grats. Its CLI binary is `gratos` (never `grats`). The dev boot step is the lazy `@dblechoc/gratos/dev` entry (types from `src/devApi.ts`, so consumers never typecheck the engine).
- `@dblechoc/gratos-server` (`packages/gratos-server`): the GraphQL server core and plugins, with the Effect layer at `@dblechoc/gratos-server/effect`.
- `examples/orders`: the example app. `pnpm dev` there is the live-rebuild loop (`node --watch-path`); its Grats config is `src/tsconfig.json`.

`@dblechoc/gratos` and `@dblechoc/gratos-server` are publishable (public npm, docs/plan.html F7);
`examples/orders` and the root stay `private: true`. The two packages' peers are literal caret ranges, never
`catalog:` (pnpm would pack the catalog's exact version), with the same packages as `catalog:`
devDependencies.

## Toolchain

- Node 26 (`.node-version`). Packages run from source through Node's type stripping; there is no build step in the workspace.
  The tarballs are built only by each package's `prepack` (`tsconfig.build*.json` into the gitignored `dist/`), and
  `publishConfig` points `exports`, `bin` and `imports` at `dist/`. `node scripts/install-test.ts <dir> --peers min|newest|core`
  installs the tarballs that `pnpm --filter "./packages/*" pack --pack-destination <dir>` writes into a project outside the
  workspace and runs them there (CI's `pack-check` jobs; not part of `pnpm check`). Given a `changeset pack` output instead,
  it tests the tarballs that output's `publish-plan.json` publishes ("Releasing" below).
- pnpm 12 (`packageManager`). Node 26 has no corepack: install with `npm i -g pnpm@12.23.0`. In CI, `pnpm/action-setup`.
- Turborepo: `pnpm check` runs everything (`turbo run check`). Read `node_modules/turbo/docs` before changing `turbo.json`.
- TypeScript 7 (`tsc --noEmit` per package). The compiler talks to TypeScript only through `packages/gratos/src/ts/`.
- oxfmt (`pnpm fmt`) and oxlint with `@cloudflare/oxlint-config` (`pnpm lint`).
- vitest with `@effect/vitest` (`it.effect`).

## Rules

- Never edit generated files (`**/src/generated/*`). Run `pnpm codegen` and commit the result.
- All TypeScript compiler API access goes through `packages/gratos/src/ts/`.
- The engine imports TypeScript as `#typescript`: the TypeScript 7 facade in `src/ts/` at runtime,
  TypeScript 5.9.2's declarations for typechecking (`paths` in `packages/gratos/tsconfig.json`).
  The package's `test` script runs the fixture suite twice: on TypeScript 7, then on TypeScript 5.9.2
  through `vitest.parity.config.ts` (parity bar (b)). Both must stay green with the same snapshots.
- Never use `--preserve-symlinks`, injected dependencies or `pnpm deploy`: they break type stripping of workspace packages.
- Only erasable TypeScript syntax (`erasableSyntaxOnly`): no enums, namespaces or parameter properties.
- The installed grats skill refers to `node_modules/grats/llm-docs/…`. In this repo those docs are vendored at `packages/gratos/llm-docs/`. Gratos' own chapter (Effect resolvers, the server's Effect layer and its contracts) is `packages/gratos/llm-docs/gratos/effect.md`: read it before writing an Effect resolver. Beside it, `differences.md` says what Gratos removed or renamed from Grats (the `gratos` binary, the `@dblechoc/gratos` import, no `--watch`, `--fix` or `locate`): read it before following a vendored page. `server.md` documents the server core (`createServer` and its options, the hooks in call order, the HTTP matrix, the plugins and their order). `llm-docs/gratos/` is not vendored, and `vendor:verify` skips it (and fails if upstream ever has files there).
- Code blocks in the docs tagged `file=<path>` must match that file (`examples/orders/test/docs.test.ts`): change both together.
- Vendored upstream files (`packages/gratos/src/upstream/`, `llm-docs/` except `llm-docs/gratos/`, `test/fixtures/`, `test/integrationFixtures/`, `test/configParserFixtures/`, `LICENSE`) change only in separate, listed commits. `pnpm --filter @dblechoc/gratos vendor:verify` reports any difference from upstream v0.0.36.

## Upgrading a pinned dependency

Every version is pinned exactly in `pnpm-workspace.yaml`'s `catalog:`. The weekly canary (`.github/workflows/canary.yml`) shows which newer release breaks `pnpm check`. An upgrade is its own PR:

1. Bump the `catalog:` entry, with the `@effect/*` packages at the same version as `effect`, then run `pnpm install` (a release younger than `minimumReleaseAge` needs `minimumReleaseAgeExclude` lines).
2. Run both parity runs with `pnpm --filter @dblechoc/gratos test` (TypeScript 7, then 5.9.2, same snapshots), then `npx turbo run check --force`.
3. Run `GITHUB_TOKEN=$(gh auth token) pnpm --filter @dblechoc/gratos vendor:verify`.
4. Run the bench: `pnpm --filter @dblechoc/gratos bench` and `pnpm --filter orders-example bench:compiler`. If the file count changes, `test/filesLoaded.test.ts` fails: record it with `bench --record`.
5. Run the upstream-fact tests: `pnpm --filter @dblechoc/gratos-server exec vitest run test/jit.test.ts -t "the premise|upstream facts"` and the late-source test in `test/subscriptions.test.ts` ("while the source is set up"). A changed fact means a workaround to review: the failure names it.

## Releasing

Changesets versions and publishes the two packages (`.changeset/config.json`). They are `fixed`: they always share one version. `examples/orders` and the root are private and never versioned.

- **Adding a changeset.** A PR that changes what a user of either package sees adds one: run `pnpm changeset`, pick the bump, and write a short user-facing summary. It lands as a file in `.changeset/`, committed with the change. A PR that changes nothing a user sees (tests, CI, docs in this repo) needs none.
- **The release workflow** (`.github/workflows/release.yml`) runs on every push to `main`. While changesets are pending, it opens or updates the Version Packages PR (`changeset-release/main`, titled `chore(release): version packages`), which bumps the versions and writes the CHANGELOGs. Once that PR is merged, and only if the repo variable `GRATOS_PUBLISH` is `true`, it runs `pnpm run release`: the gate (`release:gate`: `pnpm check` and `vendor:verify`), `changeset pack --out-dir .pack` (`release:pack`), the install test on exactly those tarballs for `min`, `newest` and `core` (`release:test`, reading `.pack/publish-plan.json`), then `changeset publish --from-pack-dir .pack`, which publishes those same tarballs (no lifecycle script runs), over npm trusted publishing with provenance, and pushes the tags and GitHub releases. While `GRATOS_PUBLISH` is unset, it never publishes.
- **CI on the Version Packages PR.** The workflow opens and updates that PR with `GITHUB_TOKEN`, so GitHub creates its `ci` runs in an approval-required state instead of starting them. After each update, open the PR and select **Approve workflows to run** in the merge box; those `pull_request` runs report the required `ci` check. A `workflow_dispatch` run would not: GitHub never counts a check from one toward a PR's required checks. If the button is missing, closing and reopening the PR yourself starts the runs too.

**The first release (0.1.0), once.** It is published by hand, because npm's trusted publisher can only be added to a package that exists:

1. Merge F7b. The workflow opens the 0.1.0 Version Packages PR.
2. Approve that PR's workflow runs, and wait for `ci` to pass.
3. Check the PR out locally (`gh pr checkout <number>`, a clean tree), `pnpm install --frozen-lockfile`, then run `GITHUB_TOKEN=$(gh auth token) pnpm run release:gate && pnpm run release:pack && pnpm run release:test`.
4. Publish both tested tarballs, with npm 2FA: `pnpm publish .pack/packages/dblechoc-gratos-0.1.0.tgz --access public --no-git-checks`, then the same for `.pack/packages/dblechoc-gratos-server-0.1.0.tgz` (pnpm prompts for the one-time password, or pass `--otp <code>`). `--no-git-checks` is needed because the checkout is not on `main`; `changeset publish` passes it too.
5. On npmjs.com, add the trusted publisher to both packages: GitHub Actions, repository `sync/gratos`, workflow `release.yml`. It expires if no publish uses it within two days, so add it right before the next release, not long before.
6. Merge the Version Packages PR. On the updated `main`, run `pnpm exec changeset git-tag`, which tags `@dblechoc/gratos@0.1.0` and `@dblechoc/gratos-server@0.1.0`, and push those two tags with `git push origin "@dblechoc/gratos@0.1.0" "@dblechoc/gratos-server@0.1.0"`. (Optionally, `gh release create` each tag with its CHANGELOG entry: the workflow makes GitHub releases only for what it publishes.)
7. Set the repo variable: `gh variable set GRATOS_PUBLISH --body true`. Later releases publish from the workflow, over OIDC, with provenance.

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
