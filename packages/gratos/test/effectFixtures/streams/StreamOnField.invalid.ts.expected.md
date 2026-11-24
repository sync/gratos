# streams/StreamOnField.invalid.ts

## Input

```ts title="streams/StreamOnField.invalid.ts"
import { Stream } from "effect";

/** @gqlType */
export class User {
  /** @gqlField */
  greetings(): Stream.Stream<string> {
    return Stream.make("hi");
  }
}
```

## Output

### Error Report

```text
test/effectFixtures/streams/StreamOnField.invalid.ts:6:16 - error: Expected `Stream.Stream` only on fields of `Subscription` (`@gqlSubscriptionField`). On any other type GraphQL would treat the Stream as a list and fail at runtime. Return `Effect.Effect<ReadonlyArray<A>>` for a list, or move the field to `Subscription`.

6   greetings(): Stream.Stream<string> {
                 ~~~~~~~~~~~~~~~~~~~~~
```