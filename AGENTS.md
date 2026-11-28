# Gratos agent guide

Gratos is an Effect-native reimplementation of [Grats](https://github.com/captbaritone/grats)
(vendored from its last TypeScript release, v0.0.36) plus a small GraphQL server core,
a plugin system and an Effect layer. The approved plan is `docs/plan.html`; it is the
source of truth for scope, milestones and acceptance criteria.

## Packages

- `gratos` (`packages/gratos`): the Effect-aware compiler, vendored from Grats. Its CLI binary is `gratos` (never `grats`). The dev boot step is the lazy `gratos/dev` entry (types from `src/devApi.ts`, so consumers never typecheck the engine).
- `gratos-server` (`packages/gratos-server`): the GraphQL server core and plugins, with the Effect layer at `gratos-server/effect`.
- `examples/orders`: the example app. `pnpm dev` there is the live-rebuild loop (`node --watch-path`); its Grats config is `src/tsconfig.json`.

`gratos` and `gratos-server` are publishable (public npm, docs/plan.html F7);
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
- The installed grats skill refers to `node_modules/grats/llm-docs/…`. In this repo those docs are vendored at `packages/gratos/llm-docs/`. Gratos' own chapter (Effect resolvers, the server's Effect layer and its contracts) is `packages/gratos/llm-docs/gratos/effect.md`: read it before writing an Effect resolver. Beside it, `differences.md` says what Gratos removed or renamed from Grats (the `gratos` binary, the `gratos` import, no `--watch`, `--fix` or `locate`): read it before following a vendored page. `server.md` documents the server core (`createServer` and its options, the hooks in call order, the HTTP matrix, the plugins and their order). `llm-docs/gratos/` is not vendored, and `vendor:verify` skips it (and fails if upstream ever has files there).
- Code blocks in the docs tagged `file=<path>` must match that file (`examples/orders/test/docs.test.ts`): change both together.
- Vendored upstream files (`packages/gratos/src/upstream/`, `llm-docs/` except `llm-docs/gratos/`, `test/fixtures/`, `test/integrationFixtures/`, `test/configParserFixtures/`, `LICENSE`) change only in separate, listed commits. `pnpm --filter gratos vendor:verify` reports any difference from upstream v0.0.36.

## Upgrading a pinned dependency

Every version is pinned exactly in `pnpm-workspace.yaml`'s `catalog:`. The weekly canary (`.github/workflows/canary.yml`) shows which newer release breaks `pnpm check`. An upgrade is its own PR:

1. Bump the `catalog:` entry, with the `@effect/*` packages at the same version as `effect`, then run `pnpm install` (a release younger than `minimumReleaseAge` needs `minimumReleaseAgeExclude` lines).
2. Run both parity runs with `pnpm --filter gratos test` (TypeScript 7, then 5.9.2, same snapshots), then `npx turbo run check --force`.
3. Run `GITHUB_TOKEN=$(gh auth token) pnpm --filter gratos vendor:verify`.
4. Run the bench: `pnpm --filter gratos bench` and `pnpm --filter orders-example bench:compiler`. If the file count changes, `test/filesLoaded.test.ts` fails: record it with `bench --record`.
5. Run the upstream-fact tests: `pnpm --filter gratos-server exec vitest run test/jit.test.ts -t "the premise|upstream facts"` and the late-source test in `test/subscriptions.test.ts` ("while the source is set up"). A changed fact means a workaround to review: the failure names it.

## Releasing

Changesets versions and publishes the two packages (`.changeset/config.json`). They are `fixed`: they always share one version. `examples/orders` and the root are private and never versioned.

- **Adding a changeset.** A PR that changes what a user of either package sees adds one: run `pnpm changeset`, pick the bump, and write a short user-facing summary. It lands as a file in `.changeset/`, committed with the change. A PR that changes nothing a user sees (tests, CI, docs in this repo) needs none.
- **The scripts.** `pnpm run release` (`scripts/release.ts`) does everything before the publish, for a release by hand: it writes the publish plan (`changeset publish-plan`, the versions the registry lacks) and stops there when the plan publishes nothing; otherwise it runs the gate (`release:gate`: `pnpm check` and `vendor:verify`), packs that same plan (`changeset pack --from-publish-plan … --out-dir .pack`), and runs the install test on exactly those tarballs for `min`, `newest` and `core` (`release:test`, reading `.pack/publish-plan.json`). `pnpm run release:pack` (`release.ts --pack-only`) is the plan and the pack only, for the workflow, which gates and tests the uploaded pack in a later job. `pnpm run release:publish` (`changeset publish --from-pack-dir .pack`) publishes those same tarballs (no lifecycle script runs) and tags them on the current commit. `node scripts/verify-pack.ts .pack --plan-sha256 <hex>` checks a pack output: the plan's sha256, then each planned tarball (a regular `.tgz` file inside `.pack`, never a symlink, with the plan's integrity, package and version), and that `.pack` holds nothing else.
- **The release workflow** (`.github/workflows/release.yml`) runs on every push to `main`, in three jobs. The `release` job (`contents` and `pull-requests: write`, no `id-token`) runs `changesets/action/select-mode`. While changesets are pending, it opens or updates the Version Packages PR (`changeset-release/main`, titled `chore(release): version packages`) with `changesets/action/version`. Once that PR is merged, the registry lacks the new versions, and only if the repo variable `GRATOS_PUBLISH` is exactly `true`, it runs `pnpm run release:pack`, records the plan's sha256 right after the pack, and uploads `.pack` as an artifact before any test runs; the artifact's id and the sha256 are its outputs. The `test` job (`contents: read` only) runs the gate, downloads that artifact by id, checks it with `scripts/verify-pack.ts` against the recorded sha256, and runs the install test on it. The `publish` job (`id-token` and `contents: write`, nothing else; only once `test` passed) downloads the same artifact by id, checks it again, and runs `pnpm run release:publish` through `changesets/action/publish`, over npm trusted publishing with provenance; the action pushes the tags and creates the GitHub releases. An upload-artifact v4 artifact is immutable, and a deleted one cannot come back under its id, so the `test` job cannot change what `publish` publishes: the bytes published are the bytes packed before the tests and tested. While `GRATOS_PUBLISH` is unset, nothing is gated, packed or published.
- **A partial release.** If npm accepts one package and not the other, the next plan holds only the one still missing. The install test then installs its tarball beside the other package at its exact version, from the registry, and the publish publishes the missing one only. Re-run the workflow (or the failed `publish` job) once the cause is fixed.
- **A missing GitHub release.** If npm accepted the packages and the tags were pushed, but creating a GitHub release failed, a rerun does not create it: the new plan sees the versions on npm and publishes nothing, and the action creates releases only for what it has just published. Recreate each missing release by hand from its existing tag, with that version's section of the package's `CHANGELOG.md` as its notes, once per package (`gh release view "<tag>"` says whether one exists). From a checkout of `main` at or after the release, for version `0.2.0`:

  ```sh
  version=0.2.0
  for package in gratos gratos-server; do
    tag="$package@$version"
    # The section under "## $version", up to the next version's heading.
    notes=$(awk -v v="$version" '/^## /{ if (found) exit; found = ($2 == v); next } found' "packages/$package/CHANGELOG.md")
    gh release create "$tag" --verify-tag --title "$tag" --notes "$notes"
  done
  ```

  When only one release is missing, loop over its package only. `--verify-tag` makes `gh` stop when the tag is not on GitHub, instead of creating one on the default branch's head.

- **CI on the Version Packages PR.** The workflow opens and updates that PR with `GITHUB_TOKEN`, so GitHub creates its `ci` runs in an approval-required state instead of starting them. After each update, open the PR and select **Approve workflows to run** in the merge box; those `pull_request` runs report the required `ci` check. A `workflow_dispatch` run would not: GitHub never counts a check from one toward a PR's required checks. If the button is missing, closing and reopening the PR yourself starts the runs too.

**Before F7b is merged, once (the maintainer's step; an agent never changes repo settings).** In the repo's **Settings → Actions → General → Workflow permissions**, turn on **Allow GitHub Actions to create and approve pull requests**, and save. Without it, `GITHUB_TOKEN` cannot open the Version Packages PR, and the `release` job fails on the first push with a pending changeset. Check it with `gh api repos/sync/gratos/actions/permissions/workflow`: `can_approve_pull_request_reviews` must be `true`.

**The first release (0.1.0), once.** It is published by hand, because npm's trusted publisher can only be added to a package that exists. It is published from the merged commit on `main`, never from the PR branch, which Changesets regenerates on every push to `main`: the `0.1.0` tags must name the commit the tarballs came from.

1. Merge F7b. The workflow opens the 0.1.0 Version Packages PR. Approve its workflow runs, and wait for `ci` to pass.
2. Merge the Version Packages PR, with `GRATOS_PUBLISH` still unset. The workflow's run on the merge commit stops at "Check that publishing is on", and publishes nothing.
3. On that merge commit (the `chore(release): version packages` commit on `main`), with a clean tree and logged in to npm: `git fetch origin && git checkout --detach <merge-sha>`, `pnpm install --frozen-lockfile`, then `GITHUB_TOKEN=$(gh auth token) pnpm run release` (the plan, the gate, the pack and the install test). Then publish the tested tarballs, with npm 2FA: `pnpm run release:publish` (pnpm asks for the one-time password, or pass it: `pnpm run release:publish --otp <code>`). It publishes `.pack`'s two tarballs, and tags the checked-out commit `gratos@0.1.0` and `gratos-server@0.1.0` (`git tag --points-at HEAD` lists both). If only one package was published, run both commands again: the new plan holds only the other one.
4. Push the tags: `git push origin "gratos@0.1.0" "gratos-server@0.1.0"`. Then create their GitHub releases, which nothing else creates (the workflow makes releases only for what it publishes): the loop in "A missing GitHub release" above, with `version=0.1.0`.
5. Then, right before the next release (its Version Packages PR is ready to merge), set up publishing from the workflow. On npmjs.com, add a trusted publisher to both packages (Settings → Trusted publishing): GitHub Actions, organization or user `sync`, repository `gratos`, workflow `release.yml`, no environment. Under **Allowed actions**, also allow direct publishing with `npm publish`: a configuration created now allows only staged publishing (`npm stage publish`) by default, and this workflow publishes directly. A new configuration expires if no publish uses it within 2 days, so add it right before that release, not long before. Then set the repo variable, exactly `true`: `gh variable set GRATOS_PUBLISH --body true`. Later releases publish from the workflow, over OIDC, with provenance.

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
