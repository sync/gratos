# resolverMap/StreamSubscriptionResolverMap.invalid.ts

## Input

```ts title="resolverMap/StreamSubscriptionResolverMap.invalid.ts"
// { "EXPERIMENTAL__emitResolverMap": true }
import { Stream } from "effect";
import type { Int } from "../../../Types";

/** @gqlSubscriptionField */
export function countdown(from: Int): Stream.Stream<Int> {
  return Stream.make(from, from - 1, 0);
}
```

## Output

### Error Report

```text
test/effectFixtures/resolverMap/StreamSubscriptionResolverMap.invalid.ts:6:39 - error: Expected no `Stream.Stream` subscription when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no `subscribe` for the Gratos Effect layer to turn the Stream into an AsyncIterable. Turn off `EXPERIMENTAL__emitResolverMap`, or return an `AsyncIterable`.

6 export function countdown(from: Int): Stream.Stream<Int> {
                                        ~~~~~~~~~~~~~~~~~~
```