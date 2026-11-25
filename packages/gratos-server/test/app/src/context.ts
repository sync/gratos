// The request context, and an async derived context (which makes Grats generate async
// adapters, so an Effect or a Stream reaches the Effect layer inside a Promise).
import type { Guard } from "../../../src/effect/index.ts";
import type { AppError } from "./errors.ts";

/** @gqlContext */
export interface Ctx {
  readonly viewer: string;
  readonly guard: Guard<AppError>["guard"];
  readonly guardStream: Guard<AppError>["guardStream"];
  /** Holds the derived context (a test opens it), after telling the test it got there. */
  readonly derivedHold: DerivedHold | undefined;
  /** Holds Order.confirmation of an order id (a test opens it). */
  readonly confirmationHold: ((id: string) => Promise<void>) | undefined;
}

export interface DerivedHold {
  readonly reached: () => void;
  readonly hold: Promise<void>;
}

export interface Viewer {
  readonly name: string;
}

/** @gqlContext */
export async function viewerOf(ctx: Ctx): Promise<Viewer> {
  if (ctx.derivedHold !== undefined) {
    ctx.derivedHold.reached();
    await ctx.derivedHold.hold;
  }
  return { name: ctx.viewer };
}
