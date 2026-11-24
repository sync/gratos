# resolverMap/InfoResolverMap.invalid.ts

## Input

```ts title="resolverMap/InfoResolverMap.invalid.ts"
// { "EXPERIMENTAL__emitResolverMap": true }
import type { GqlInfo } from "../../../Types";

/**
 * A resolver that takes `GqlInfo` needs the `gratos: { jit: false }` marker, which a resolver map
 * cannot carry: a function, a method and a static method are each reported.
 */
/** @gqlQueryField */
export function path(info: GqlInfo): string {
  return info.fieldName;
}

/** @gqlType */
export class User {
  /** @gqlField */
  name(info: GqlInfo): string {
    return info.fieldName;
  }

  /** @gqlQueryField */
  static me(info: GqlInfo): User {
    return new User();
  }
}
```

## Output

### Error Report

```text
test/effectFixtures/resolverMap/InfoResolverMap.invalid.ts:9:22 - error: Expected no resolver with a `GqlInfo` parameter when `EXPERIMENTAL__emitResolverMap` is enabled. Such a field must carry the `gratos: { jit: false }` marker so the jit executor leaves it to graphql-js, and the resolver map has no `extensions` to carry it. Turn off `EXPERIMENTAL__emitResolverMap`, or read what the resolver needs from its arguments or context instead.

9 export function path(info: GqlInfo): string {
                       ~~~~~~~~~~~~~
test/effectFixtures/resolverMap/InfoResolverMap.invalid.ts:16:8 - error: Expected no resolver with a `GqlInfo` parameter when `EXPERIMENTAL__emitResolverMap` is enabled. Such a field must carry the `gratos: { jit: false }` marker so the jit executor leaves it to graphql-js, and the resolver map has no `extensions` to carry it. Turn off `EXPERIMENTAL__emitResolverMap`, or read what the resolver needs from its arguments or context instead.

16   name(info: GqlInfo): string {
          ~~~~~~~~~~~~~
test/effectFixtures/resolverMap/InfoResolverMap.invalid.ts:21:13 - error: Expected no resolver with a `GqlInfo` parameter when `EXPERIMENTAL__emitResolverMap` is enabled. Such a field must carry the `gratos: { jit: false }` marker so the jit executor leaves it to graphql-js, and the resolver map has no `extensions` to carry it. Turn off `EXPERIMENTAL__emitResolverMap`, or read what the resolver needs from its arguments or context instead.

21   static me(info: GqlInfo): User {
               ~~~~~~~~~~~~~
```