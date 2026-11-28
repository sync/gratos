// gratos-server/effect: the Effect layer (docs/plan.html M5). It is the only entry that
// imports `effect`; the core (`gratos-server`) never does. It also needs
// `AsyncLocalStorage` (`node:async_hooks`: Node, Bun, Deno, Workers with nodejs_compat), which
// carries each request's scope into its resolvers through the core's `wrapExecution` hook.
// Build long-lived resources (pools, intervals) in Layers, never lazily inside a resolver: a
// resource created inside a request keeps that request's AsyncLocalStorage scope alive.
export { effectSchema, wrapSubscribe } from "./schema.ts";
export type { EffectSchemaOptions } from "./schema.ts";
export { fromCause, GuardTimeout, isGuardTimeout, ResolverDefect } from "./errors.ts";
export type { FailureMapper, FromCauseOptions } from "./errors.ts";
export { effectRoute, effectRouteLayer } from "./route.ts";
export type { EffectRouteLayerOptions } from "./route.ts";
export { effect } from "./plugin.ts";
export type { EffectPluginOptions } from "./plugin.ts";
export { runInRequest } from "./runInRequest.ts";
export { makeGuard, OperationType } from "./guard.ts";
export type { Guard, GuardOptions, GuardRequirements, Refusal } from "./guard.ts";
