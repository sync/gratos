// A bare `Effect` that is not imported from `effect` gets upstream's unresolved-type error, not
// the Effect hint.
type Effect<A> = { value: A };

/** @gqlQueryField */
export function greeting(): Effect<string> {
  throw new Error("not called");
}
