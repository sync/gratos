// The app's typed failures: the error union every resolver's Effect may fail with. A new tag
// added here fails the type check of graphql.ts's exhaustive `failure` mapper until it is mapped.
import { Schema } from "effect";

/** Something the request names does not exist: `what` is the kind ("order", "user"). */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  what: Schema.String,
}) {}

/** The session may not do this (a guest, or missing scopes). */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}

export type AppError = NotFound | Forbidden;

/**
 * Tells an AppError from anything else a resolver fails with (effectSchema's `isFailure`): only
 * real NotFound and Forbidden instances. A foreign value with a matching `_tag` is not one, so
 * the server masks it as a defect instead of handing it to the failure mapper.
 */
export const isAppError: (error: unknown) => error is AppError = Schema.is(
  Schema.Union([NotFound, Forbidden]),
);
