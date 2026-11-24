import { Effect } from "effect";

/** @gqlQueryField */
export async function greeting(): Promise<Effect.Effect<string>> {
  return Effect.succeed("hi");
}
