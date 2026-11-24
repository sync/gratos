// { "EXPERIMENTAL__emitResolverMap": true }

/** Without Effect or Stream, the resolver map compiles as upstream's does. */
/** @gqlQueryField */
export async function greeting(): Promise<string> {
  return "hello";
}

/** @gqlSubscriptionField */
export async function* ticks(): AsyncIterable<string> {
  yield "tick";
}
