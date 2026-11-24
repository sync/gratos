# input/StreamArgument.invalid.ts

## Input

```ts title="input/StreamArgument.invalid.ts"
import { Stream } from "effect";

/** @gqlQueryField */
export function greeting(args: { names: Stream.Stream<string> }): string {
  return "hi";
}
```

## Output

### Error Report

```text
test/effectFixtures/input/StreamArgument.invalid.ts:4:41 - error: `Stream.Stream` is not a valid input type. Arguments and input fields are plain values: resolve the value before passing it in.

4 export function greeting(args: { names: Stream.Stream<string> }): string {
                                          ~~~~~~~~~~~~~~~~~~~~~
```