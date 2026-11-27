// A namespace of your own with an `Effect` member is not Effect's: it keeps upstream's error, with
// no Effect hint.
declare namespace Fx {
  type Effect<A> = { value: A };
}

/** @gqlQueryField */
export function greeting(): Fx.Effect<string> {
  throw new Error("not called");
}
