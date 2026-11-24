# Gratos Effect fixtures

Schema fixtures for the Effect-aware compiler (docs/plan.html M3), not vendored from Grats. They
run in `test/upstreamFixtures.test.ts` with the same transformer as `test/fixtures/`, on both
TypeScripts (TypeScript 7, then TypeScript 5.9.2 in the parity run), with the same snapshots.

- `wrappers/`: `Effect.Effect` and `Stream.Stream` detection, a user type named `Effect`, the
  bare-`Effect` hint (only for an import from `effect` or `effect/*`), and the documented
  limitation that a renamed namespace (`Fx.Effect`) is not detected.
- `nesting/`: an Effect must be the resolver's outermost return wrapper; every rejected spelling,
  and Effect as a derived-context return.
- `input/`: Effect and Stream in argument and input-field positions.
- `streams/`: `Stream.Stream` outside `Subscription` is rejected, and so is `Effect.Effect` on a
  `Subscription` field (an Effect is not a subscription source); plain `AsyncIterable` is not.
- `codegen/`: the `semanticNonNull` and `jit` markers in generated `schema.ts`, merged into one
  `extensions` object with user directives, and the explicit `resolve` every Effect-backed
  property or getter gets for the Effect layer to wrap.
