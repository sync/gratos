# streams/StreamOfListOfStream.invalid.ts

## Input

```ts title="streams/StreamOfListOfStream.invalid.ts"
import { Stream } from "effect";

/** A Stream nested anywhere in the event type is rejected. */
/** @gqlSubscriptionField */
export function names(): Stream.Stream<ReadonlyArray<Stream.Stream<string>>> {
  return Stream.make([Stream.make("Ada")]);
}
```

## Output

### Error Report

```text
test/effectFixtures/streams/StreamOfListOfStream.invalid.ts:5:54 - error: Expected `Stream.Stream` only as the source of a subscription field, not inside its event type. Each event is delivered as a plain value, and GraphQL cannot iterate a Stream inside one. Flatten the inner Stream into the source, for example with `Stream.flatten`.

5 export function names(): Stream.Stream<ReadonlyArray<Stream.Stream<string>>> {
                                                       ~~~~~~~~~~~~~~~~~~~~~
```