# Gratos schema fixtures

Schema fixtures that are not vendored from Grats, run by `test/upstreamFixtures.test.ts` with
the same transformer as `test/fixtures/`, on both TypeScripts (TypeScript 7, then TypeScript
5.9.2 in the parity run). Snapshots of fixtures that run on both must be identical.

- `comments/`: regressions from the TypeScript 7 port, with TypeScript 5's output as the snapshot.
- `<name>.ts5.ts` and `<name>.ts7.ts`: per-TypeScript variants of an upstream fixture gated with
  `tsVersion` (docs/plan.html M2). The upstream fixture is skipped on both TypeScripts; each
  variant drops the gate and runs only on its TypeScript major, with its own snapshot. A
  variant that reports an error has `.invalid` in its name, even where upstream's did not.

Lib file paths print as `<typescript>/lib/…`, because the TypeScript 7 lib directory is a
platform package.

## Differences between the TypeScript 5 and TypeScript 7 variants

| Fixture                                               | Difference                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `comments/blockCommentThreeStars.invalid`             | none                                                                                                                |
| `descriptions/DescriptionWithGitHubHandle`            | none                                                                                                                |
| `interfaces/InterfaceMergedIntoNode.invalid`          | the related `lib.dom.d.ts` declaration of `Node` is at line 21658 on TypeScript 5.9.2 and 26035 on TypeScript 7.0.2 |
| `user_error/TypeErrorWithTypeCheckingEnabled.invalid` | none (upstream's name has no `.invalid`)                                                                            |
