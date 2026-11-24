# streams/AsyncIterableOfStream.invalid.ts

## Input

```ts title="streams/AsyncIterableOfStream.invalid.ts"
import { Stream } from "effect";

/** Each event would be a Stream, which GraphQL cannot iterate. */
/** @gqlSubscriptionField */
export async function* names(): AsyncIterable<Stream.Stream<string>> {
  yield Stream.make("Ada");
}
```

## Output

### Error Report

```text
test/effectFixtures/streams/AsyncIterableOfStream.invalid.ts:5:47 - error: Expected `Stream.Stream` only as the source of a subscription field, not inside its event type. Each event is delivered as a plain value, and GraphQL cannot iterate a Stream inside one. Flatten the inner Stream into the source, for example with `Stream.flatten`.

5 export async function* names(): AsyncIterable<Stream.Stream<string>> {
                                                ~~~~~~~~~~~~~~~~~~~~~
```