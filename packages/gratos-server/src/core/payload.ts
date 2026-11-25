// The errors of a payload, wherever they sit (docs/plan.html M4b, "Errors in streamed payloads"):
// `onResult` receives an initial result, a subsequent incremental payload or a subscription event.
// A subsequent payload (the legacy format of graphql 17's `legacyExecuteIncrementally`) carries
// its errors in `incremental[].errors`, so a plugin that reads or rewrites errors goes through
// these helpers rather than `payload.errors` alone.
import type { ExecutionResult, GraphQLError, LegacyIncrementalResult } from "graphql";

/** A subsequent incremental payload, as `onResult` receives it. */
export type IncrementalPayload = ExecutionResult & {
  readonly incremental: ReadonlyArray<LegacyIncrementalResult>;
};

/** True for a subsequent incremental payload (it has an `incremental` list). */
export const isIncrementalPayload = (payload: ExecutionResult): payload is IncrementalPayload =>
  "incremental" in payload && Array.isArray(payload.incremental);

/** Every error of a payload: its own, then those of each incremental entry. */
export const payloadErrors = (payload: ExecutionResult): ReadonlyArray<GraphQLError> => {
  const own = payload.errors ?? [];
  if (!isIncrementalPayload(payload)) {
    return own;
  }
  const errors = [...own];
  for (const entry of payload.incremental) {
    errors.push(...(entry.errors ?? []));
  }
  return errors;
};

const mapErrors = (
  errors: ReadonlyArray<GraphQLError> | undefined,
  map: (error: GraphQLError) => GraphQLError,
): ReadonlyArray<GraphQLError> | undefined => {
  if (errors === undefined) {
    return undefined;
  }
  let changed = false;
  const mapped = errors.map((error) => {
    const next = map(error);
    changed ||= next !== error;
    return next;
  });
  return changed ? mapped : errors;
};

/**
 * The payload with every error (its own and each incremental entry's) replaced by `map(error)`.
 * Returns the same payload when `map` changed nothing, else a copy that keeps every other field.
 */
export const mapPayloadErrors = <P extends ExecutionResult>(
  payload: P,
  map: (error: GraphQLError) => GraphQLError,
): P => {
  const errors = mapErrors(payload.errors, map);
  let result: P = errors === payload.errors ? payload : { ...payload, errors };
  if (isIncrementalPayload(payload)) {
    let changed = false;
    const incremental = payload.incremental.map((entry) => {
      const entryErrors = mapErrors(entry.errors, map);
      if (entryErrors === entry.errors) {
        return entry;
      }
      changed = true;
      return { ...entry, errors: entryErrors };
    });
    if (changed) {
      result = { ...result, incremental };
    }
  }
  return result;
};
