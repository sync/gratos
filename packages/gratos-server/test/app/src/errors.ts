// The app's typed failures: the error union every resolver's Effect may fail with.
import { Data } from "effect";

export class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly scopes: ReadonlyArray<string>;
}> {}

export type AppError = NotFound | Forbidden;
