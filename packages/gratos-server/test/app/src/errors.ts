// The app's typed failures: the error union every resolver's Effect may fail with.
import { Data, Predicate } from "effect";

export class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly scopes: ReadonlyArray<string>;
}> {}

export type AppError = NotFound | Forbidden;

/** Tells an AppError from anything else a resolver fails with (effectSchema's `isFailure`). */
export const isAppError = (error: unknown): error is AppError =>
  Predicate.isTagged(error, "NotFound") || Predicate.isTagged(error, "Forbidden");
