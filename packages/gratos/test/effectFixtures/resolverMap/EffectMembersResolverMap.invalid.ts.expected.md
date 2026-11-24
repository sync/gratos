# resolverMap/EffectMembersResolverMap.invalid.ts

## Input

```ts title="resolverMap/EffectMembersResolverMap.invalid.ts"
// { "EXPERIMENTAL__emitResolverMap": true }
import { Effect } from "effect";

/** Every Effect-backed member is reported: a property, a getter and a method. */
/** @gqlType */
export class User {
  /** @gqlField */
  name: Effect.Effect<string> = Effect.succeed("Ada");

  /** @gqlField */
  get email(): Effect.Effect<string> {
    return Effect.succeed("ada@example.com");
  }

  /** @gqlField */
  greeting(): Effect.Effect<string> {
    return Effect.succeed("hello");
  }

  /** A plain field is fine. */
  /** @gqlField */
  id: string = "u-1";
}
```

## Output

### Error Report

```text
test/effectFixtures/resolverMap/EffectMembersResolverMap.invalid.ts:8:23 - error: Expected no `Effect.Effect` field when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no generated `resolve` or `gratos` extensions for the Gratos Effect layer to run the Effect with. Turn off `EXPERIMENTAL__emitResolverMap`, or return the value or a `Promise` of it.

8   name: Effect.Effect<string> = Effect.succeed("Ada");
                        ~~~~~~
test/effectFixtures/resolverMap/EffectMembersResolverMap.invalid.ts:11:30 - error: Expected no `Effect.Effect` field when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no generated `resolve` or `gratos` extensions for the Gratos Effect layer to run the Effect with. Turn off `EXPERIMENTAL__emitResolverMap`, or return the value or a `Promise` of it.

11   get email(): Effect.Effect<string> {
                                ~~~~~~
test/effectFixtures/resolverMap/EffectMembersResolverMap.invalid.ts:16:29 - error: Expected no `Effect.Effect` field when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no generated `resolve` or `gratos` extensions for the Gratos Effect layer to run the Effect with. Turn off `EXPERIMENTAL__emitResolverMap`, or return the value or a `Promise` of it.

16   greeting(): Effect.Effect<string> {
                               ~~~~~~
```