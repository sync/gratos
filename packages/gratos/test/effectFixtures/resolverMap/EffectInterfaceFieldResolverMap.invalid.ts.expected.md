# resolverMap/EffectInterfaceFieldResolverMap.invalid.ts

## Input

```ts title="resolverMap/EffectInterfaceFieldResolverMap.invalid.ts"
// { "EXPERIMENTAL__emitResolverMap": true }
import { Effect } from "effect";

/** @gqlInterface */
export interface Node {
  /** @gqlField */
  id: string;
}

/**
 * An interface field defined as a function is added to every implementation: it is reported
 * once.
 */
/** @gqlField */
export function greeting(_: Node): Effect.Effect<string> {
  return Effect.succeed("hello");
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
```

## Output

### Error Report

```text
test/effectFixtures/resolverMap/EffectInterfaceFieldResolverMap.invalid.ts:15:50 - error: Expected no `Effect.Effect` field when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no generated `resolve` or `gratos` extensions for the Gratos Effect layer to run the Effect with. Turn off `EXPERIMENTAL__emitResolverMap`, or return the value or a `Promise` of it.

15 export function greeting(_: Node): Effect.Effect<string> {
                                                    ~~~~~~
```