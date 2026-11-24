# streams/StreamOnQueryField.invalid.ts

## Input

```ts title="streams/StreamOnQueryField.invalid.ts"
import { Stream } from "effect";

/** @gqlQueryField */
export function greetings(): Stream.Stream<string> {
  return Stream.make("hi");
}
```

## Output

### Error Report

```text
test/effectFixtures/streams/StreamOnQueryField.invalid.ts:4:30 - error: Expected `Stream.Stream` only on fields of `Subscription` (`@gqlSubscriptionField`). On any other type GraphQL would treat the Stream as a list and fail at runtime. Return `Effect.Effect<ReadonlyArray<A>>` for a list, or move the field to `Subscription`.

4 export function greetings(): Stream.Stream<string> {
                               ~~~~~~~~~~~~~~~~~~~~~
```