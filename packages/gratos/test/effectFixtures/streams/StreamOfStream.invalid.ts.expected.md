# streams/StreamOfStream.invalid.ts

## Input

```ts title="streams/StreamOfStream.invalid.ts"
import { Stream } from "effect";

/** Each event would be a Stream, which GraphQL cannot iterate. */
/** @gqlSubscriptionField */
export function names(): Stream.Stream<Stream.Stream<string>> {
  return Stream.make(Stream.make("Ada"));
}
```

## Output

### Error Report

```text
test/effectFixtures/streams/StreamOfStream.invalid.ts:5:40 - error: Expected `Stream.Stream` only as the source of a subscription field, not inside its event type. Each event is delivered as a plain value, and GraphQL cannot iterate a Stream inside one. Flatten the inner Stream into the source, for example with `Stream.flatten`.

5 export function names(): Stream.Stream<Stream.Stream<string>> {
                                         ~~~~~~~~~~~~~~~~~~~~~
```