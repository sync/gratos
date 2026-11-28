// gratos-server/jit: the jit() plugin and its helpers (docs/plan.html M4a, F7). It is its
// own entry so that the main entry never loads graphql-jit, an optional peer: an app that does not
// use jit() need not install it.
export { isJitDisabled, isSelectionSafe, jit, usesOneOfVariable } from "./plugins/jit.ts";
export type { FieldPredicate, JitOptions } from "./plugins/jit.ts";
