import type { Effect as Fx } from "effect/Effect";

/** @gqlQueryField */
export function greeting(): Fx<string> {
  throw new Error("not called");
}
