// Why the core aborted one of its own signals (docs/plan.html F5, "Reasons"). Internal: the core
// gives each abort it makes a reason, and the Effect layer, in the same package, reads its kind to
// tell the client leaving from the core stopping work itself. Not exported from the package entry.
//
// A reason is an AbortError DOMException with the message of a default abort reason, so whatever
// reads it (graphql-js's AbortedGraphQLExecutionError, a source that rethrows `signal.reason`)
// sees what it saw before; only its kind, kept here, tells it apart.

/**
 * What made the core abort a signal:
 * - `client`: the client left, seen as a body cancel (a streamed body, or a JSON body cancelled
 *   unread). The client's own abort (`Request.signal`) keeps the reason it came with instead;
 * - `source`: a subscription source failed, and the stream stops its executor;
 * - `stream`: a streamed response failed (a result hook threw, a payload could not be serialized);
 * - `unsent`: a streamed result is never sent (a refusal, a failing result hook);
 * - `abandoned`: a wrapper left an execution running.
 */
export type AbortKind = "client" | "source" | "stream" | "unsent" | "abandoned";

const kinds = new WeakMap<object, AbortKind>();

/** A new abort reason of `kind`. */
export const abortReason = (kind: AbortKind): DOMException => {
  const reason = new DOMException("This operation was aborted", "AbortError");
  kinds.set(reason, kind);
  return reason;
};

/** The kind of a reason the core made, or `undefined` for any other value. */
export const abortKindOf = (reason: unknown): AbortKind | undefined =>
  typeof reason === "object" && reason !== null ? kinds.get(reason) : undefined;
