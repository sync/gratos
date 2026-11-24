# nesting/PromiseOfEffectDerivedContext.invalid.ts

## Input

```ts title="nesting/PromiseOfEffectDerivedContext.invalid.ts"
import { Effect } from "effect";

/** @gqlContext */
type Ctx = { userId: string };

type Viewer = { id: string };

/** @gqlContext */
export async function viewer(ctx: Ctx): Promise<Effect.Effect<Viewer>> {
  return Effect.succeed({ id: ctx.userId });
}

/** @gqlQueryField */
export function me(viewer: Viewer): string {
  return viewer.id;
}
```

## Output

### Error Report

```text
test/effectFixtures/nesting/PromiseOfEffectDerivedContext.invalid.ts:9:49 - error: Expected a derived context function not to return `Effect.Effect`. The generated schema calls derived context functions (and awaits a `Promise`) before calling the resolver, so an Effect would be passed to the resolver unrun. Return the value, or a `Promise` of it.

9 export async function viewer(ctx: Ctx): Promise<Effect.Effect<Viewer>> {
                                                  ~~~~~~~~~~~~~~~~~~~~~
```