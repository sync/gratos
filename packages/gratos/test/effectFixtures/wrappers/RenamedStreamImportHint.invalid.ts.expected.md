# wrappers/RenamedStreamImportHint.invalid.ts

## Input

```ts title="wrappers/RenamedStreamImportHint.invalid.ts"
// A renamed import of the Stream namespace gets the hint toward `Stream.Stream`.
import { Stream as S } from "effect";

/** @gqlSubscriptionField */
export function names(): S.Stream<string> {
  return S.make("Ada");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/RenamedStreamImportHint.invalid.ts:5:26 - error: Expected `Stream.Stream`, not `S.Stream`. Gratos only recognizes the qualified name with the namespace imported under its own name, so a renamed import is not unwrapped. Import the namespace without renaming it, with `import { Stream } from "effect"`, and write `Stream.Stream<A>`.

5 export function names(): S.Stream<string> {
                           ~~~~~~~~~~~~~~~~
```