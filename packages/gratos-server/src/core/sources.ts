// Subscription sources as graphql-js subscribe() should see them (docs/plan.html M4b). Every
// subscription still runs through subscribe(); the core hands it a copy of the schema whose
// Subscription fields adapt what their source resolver returns, built once per schema.
//
// graphql 17.1's mapAsyncIterable asks a source for its iterator twice: once for the iterator it
// reads, once for the one it closes. An async generator returns itself each time, but a plain
// AsyncIterable may make a new iterator on every call, and then `return()` reaches an iterator
// nobody reads: a pull that only `return()` would release (an idle source) is never released,
// and a body cancel waits on it forever. The adapter asks the source once, so subscribe() reads
// and closes one request-local iterator.
//
// graphql 17.1 also drops a source whose resolver settles after the request signal aborted
// (cancellablePromise rejects at the abort and ignores the late value), so nothing would ever
// close it. The adapter closes a source that subscribe() has not taken once the signal aborts.
// Its `return()` runs at most once, whoever asks (the adapter or subscribe()).
import { defaultFieldResolver, GraphQLObjectType, GraphQLSchema } from "graphql";
import type { GraphQLFieldConfigMap, GraphQLFieldResolver } from "graphql";

type Resolver = GraphQLFieldResolver<unknown, unknown>;

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === "function";

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * The source as one iterator, whatever its `[Symbol.asyncIterator]()` returns on later calls,
 * closed once. Until subscribe() takes it, an abort of the request signal closes it.
 */
const adaptSource = (
  source: AsyncIterable<unknown>,
  signal: AbortSignal | undefined,
): AsyncIterable<unknown> => {
  const iterator = source[Symbol.asyncIterator]();
  let closing: Promise<IteratorResult<unknown>> | undefined;
  const close = (): Promise<IteratorResult<unknown>> => {
    closing ??= (async () => {
      await iterator.return?.();
      return DONE;
    })();
    return closing;
  };
  let taken = false;
  if (signal !== undefined) {
    const closeUntaken = (): void => {
      if (!taken) {
        // Nobody reads this source any more: its own failure to close concerns no one.
        close().catch(() => undefined);
      }
    };
    if (signal.aborted) {
      closeUntaken();
    } else {
      signal.addEventListener("abort", closeUntaken, { once: true });
    }
  }
  const adapted: AsyncIterator<unknown> = { next: () => iterator.next(), return: close };
  return {
    [Symbol.asyncIterator]: () => {
      taken = true;
      return adapted;
    },
  };
};

/** Adapts whatever a source resolver returns (the source, or a Promise of it). */
const adaptResolver =
  (resolve: Resolver): Resolver =>
  (source, args, context, info) => {
    const signal = info.getAbortSignal();
    const result = resolve(source, args, context, info);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((resolved) =>
        isAsyncIterable(resolved) ? adaptSource(resolved, signal) : resolved,
      );
    }
    return isAsyncIterable(result) ? adaptSource(result, signal) : result;
  };

const build = (schema: GraphQLSchema): GraphQLSchema => {
  const subscription = schema.getSubscriptionType();
  if (subscription === null || subscription === undefined) {
    return schema;
  }
  const config = subscription.toConfig();
  const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const [name, field] of Object.entries(config.fields)) {
    fields[name] = { ...field, subscribe: adaptResolver(field.subscribe ?? defaultFieldResolver) };
  }
  const adapted = new GraphQLObjectType({ ...config, fields });
  const schemaConfig = schema.toConfig();
  try {
    return new GraphQLSchema({
      ...schemaConfig,
      subscription: adapted,
      types: schemaConfig.types.map((type) => (type === subscription ? adapted : type)),
      // The schema it copies passed assertValidSchema (createServer, replaceSchema).
      assumeValid: true,
    });
  } catch {
    // A schema in which another type refers to the Subscription type cannot hold a second type
    // of that name: its subscriptions run on it as they are.
    return schema;
  }
};

const adaptedSchemas = new WeakMap<GraphQLSchema, GraphQLSchema>();

/**
 * The schema subscribe() runs a subscription on: the same types, with every Subscription field's
 * source adapted (see above). Built once per schema; a schema without a Subscription type is
 * returned as is.
 */
export const subscriptionSchema = (schema: GraphQLSchema): GraphQLSchema => {
  let adapted = adaptedSchemas.get(schema);
  if (adapted === undefined) {
    adapted = build(schema);
    adaptedSchemas.set(schema, adapted);
  }
  return adapted;
};
