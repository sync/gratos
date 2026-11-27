# wrappers/RenamedImportFromUserModuleNoHint.invalid.ts

## Input

```ts title="wrappers/RenamedImportFromUserModuleNoHint.invalid.ts"
// An `Effect` imported under another name from a module of your own is not Effect's: it keeps
// upstream's error, with no Effect hint.
import { Effect as Fx } from "./effects";

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  throw new Error("not called");
}
```

## Output

### Error Report

```text
test/effectFixtures/wrappers/RenamedImportFromUserModuleNoHint.invalid.ts:6:29 - error: Expected a name identifier. Grats expected to find a name here which it could use to derive the GraphQL name.

6 export function greeting(): Fx.Effect<string> {
                              ~~~~~~~~~
```