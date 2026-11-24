# streams/StreamOnInterfaceField.invalid.ts

## Input

```ts title="streams/StreamOnInterfaceField.invalid.ts"
import { Stream } from "effect";

/** @gqlInterface */
export interface Node {
  /** @gqlField */
  id: string;
}

/**
 * An interface field defined as a function is added to every implementation: the Stream outside
 * Subscription is reported once, not once per type.
 */
/** @gqlField */
export function updates(_: Node): Stream.Stream<string> {
  return Stream.make("hello");
}

/** @gqlType */
export class User implements Node {
  __typename = "User" as const;
  /** @gqlField */
  id: string = "u-1";
}

/** @gqlType */
export class Post implements Node {
  __typename = "Post" as const;
  /** @gqlField */
  id: string = "p-1";
}

/** @gqlQueryField */
export function node(): Node {
  return new User();
}
```

## Output

### Error Report

```text
test/effectFixtures/streams/StreamOnInterfaceField.invalid.ts:14:35 - error: Expected `Stream.Stream` only on fields of `Subscription` (`@gqlSubscriptionField`). On any other type GraphQL would treat the Stream as a list and fail at runtime. Return `Effect.Effect<ReadonlyArray<A>>` for a list, or move the field to `Subscription`.

14 export function updates(_: Node): Stream.Stream<string> {
                                     ~~~~~~~~~~~~~~~~~~~~~
```