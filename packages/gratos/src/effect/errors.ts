// Diagnostic messages for Effect-aware extraction and validation. They follow upstream's style
// (src/upstream/Errors.ts): what is wrong, then what Gratos expects instead.
import { wrapperName } from "./wrappers.ts";
import type { EffectWrapper } from "./wrappers.ts";

export const effectInInputPosition = (wrapper: EffectWrapper): string =>
  `\`${wrapperName(wrapper)}\` is not a valid input type. Arguments and input fields are plain values: resolve the value before passing it in.`;

export const effectNotOutermost = (): string =>
  "Expected `Effect.Effect` to be the outermost type of the resolver's return type. Gratos runs an Effect only when the resolver returns it directly, so it cannot be nested in a `Promise`, an array, a union or another type. Return a single `Effect.Effect<A>` instead, for example `Effect.Effect<ReadonlyArray<A>>` or `Effect.Effect<A | null>`.";

export const promiseInsideEffect = (): string =>
  "Expected the success type of `Effect.Effect` not to be a `Promise`. Gratos runs the Effect and uses its success value as the field's value, so it would never await the Promise. Use `Effect.promise` or `Effect.tryPromise` to turn the Promise into the Effect itself.";

export const streamInsideEffect = (): string =>
  "Expected `Stream.Stream` not to be wrapped in `Effect.Effect`. A subscription field returns the `Stream.Stream` itself; build it with `Stream.unwrap` if it needs an Effect to set up.";

export const effectWrapperMissingTypeArg = (wrapper: EffectWrapper): string =>
  `Expected \`${wrapperName(wrapper)}\` to have type arguments. Gratos needs to be able to see its success type in order to generate a GraphQL schema.`;

export const effectDerivedContext = (wrapper: EffectWrapper): string =>
  `Expected a derived context function not to return \`${wrapperName(wrapper)}\`. The generated schema calls derived context functions (and awaits a \`Promise\`) before calling the resolver, so an Effect would be passed to the resolver unrun. Return the value, or a \`Promise\` of it.`;

export const streamOutsideSubscription = (): string =>
  "Expected `Stream.Stream` only on fields of `Subscription` (`@gqlSubscriptionField`). On any other type GraphQL would treat the Stream as a list and fail at runtime. Return `Effect.Effect<ReadonlyArray<A>>` for a list, or move the field to `Subscription`.";

export const streamInSubscriptionEvent = (): string =>
  "Expected `Stream.Stream` only as the source of a subscription field, not inside its event type. Each event is delivered as a plain value, and GraphQL cannot iterate a Stream inside one. Flatten the inner Stream into the source, for example with `Stream.flatten`.";

export const effectOnSubscription = (): string =>
  "Expected a field on `Subscription` not to return `Effect.Effect`. An Effect is not a subscription source: a subscription's events come from a `Stream.Stream`. Return the `Stream.Stream` instead, and build it with `Stream.unwrap` if it needs an Effect to set up.";

export const bareEffectType = (): string =>
  'Expected `Effect.Effect`, not a bare `Effect`. Gratos only recognizes the qualified name, so `Effect<A>` imported from `effect` is not unwrapped. Import the module with `import { Effect } from "effect"` and write `Effect.Effect<A>`.';

export const effectWithResolverMap = (): string =>
  "Expected no `Effect.Effect` field when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no generated `resolve` or `gratos` extensions for the Gratos Effect layer to run the Effect with. Turn off `EXPERIMENTAL__emitResolverMap`, or return the value or a `Promise` of it.";

export const streamWithResolverMap = (): string =>
  "Expected no `Stream.Stream` subscription when `EXPERIMENTAL__emitResolverMap` is enabled. The resolver map has no `subscribe` for the Gratos Effect layer to turn the Stream into an AsyncIterable. Turn off `EXPERIMENTAL__emitResolverMap`, or return an `AsyncIterable`.";

export const infoWithResolverMap = (): string =>
  "Expected no resolver with a `GqlInfo` parameter when `EXPERIMENTAL__emitResolverMap` is enabled. Such a field must carry the `gratos: { jit: false }` marker so the jit executor leaves it to graphql-js, and the resolver map has no `extensions` to carry it. Turn off `EXPERIMENTAL__emitResolverMap`, or read what the resolver needs from its arguments or context instead.";
