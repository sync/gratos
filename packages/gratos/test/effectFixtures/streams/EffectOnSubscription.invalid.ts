import { Effect } from "effect";

/** @gqlSubscriptionField */
export function greeting(): Effect.Effect<string> {
  return Effect.succeed("hi");
}
