import { Effect } from "effect";

/** @gqlInput */
export type GreetingInput = {
  name: Effect.Effect<string>;
};
