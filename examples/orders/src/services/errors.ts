// The app's typed failures: the error union every resolver's Effect may fail with.
import { Schema } from "effect";

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.String,
}) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  scopes: Schema.Array(Schema.String),
}) {}

export type AppError = NotFound | Forbidden;

/**
 * Tells an AppError from anything else a resolver fails with (effectSchema's `isFailure`): only
 * real NotFound and Forbidden instances. A foreign value with a matching `_tag` is not one, so
 * the server masks it as a defect instead of handing it to the failure mapper.
 */
export const isAppError: (error: unknown) => error is AppError = Schema.is(
  Schema.Union([NotFound, Forbidden]),
);
