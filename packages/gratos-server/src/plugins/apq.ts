// Automatic persisted queries, Apollo's protocol: `extensions.persistedQuery` is
// `{ version: 1, sha256Hash }`. A hash-only request is answered from the store, or refused with
// PERSISTED_QUERY_NOT_FOUND so the client resends the query. A query is stored under its hash
// only once it has passed validation (apq's onExecute runs after the document cache), and only
// when the validated document is that exact text. apq() goes first in the plugin list and never
// claims an operation.
import { GraphQLError } from "graphql";

import { isJsonObject } from "../core/http.ts";
import { Lru } from "../core/lru.ts";
import type { Params, Plugin } from "../core/types.ts";

export interface ApqStore {
  readonly get: (hash: string) => string | undefined;
  readonly set: (hash: string, query: string) => void;
}

export interface ApqOptions {
  /** Where queries are kept. Defaults to an in-memory LRU of `max` entries. */
  readonly store?: ApqStore;
  /** Size of the default store. Default 1000. */
  readonly max?: number;
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The SHA-256 of a query, as lowercase hex (Web Crypto, so the core stays runtime-neutral). */
export const sha256Hex = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

const persistedQueryOf = (
  params: Params,
): { version: unknown; sha256Hash: unknown } | undefined => {
  const persisted = params.extensions?.["persistedQuery"];
  return isJsonObject(persisted)
    ? { version: persisted["version"], sha256Hash: persisted["sha256Hash"] }
    : undefined;
};

export const apq = (options: ApqOptions = {}): Plugin => {
  const lru = new Lru<string, string>(options.max ?? 1000);
  const store: ApqStore = options.store ?? {
    get: (hash) => lru.get(hash),
    set: (hash, query) => {
      lru.set(hash, query);
    },
  };
  /** Requests whose query should be stored once it validates. */
  const pending = new WeakMap<Request, { hash: string; query: string }>();
  return {
    name: "apq",
    onParams: async (params, request) => {
      const persisted = persistedQueryOf(params);
      if (persisted === undefined) {
        return undefined;
      }
      if (persisted.version !== 1 || typeof persisted.sha256Hash !== "string") {
        throw new GraphQLError("Unsupported persisted query version or hash.", {
          extensions: { code: "PERSISTED_QUERY_NOT_SUPPORTED" },
        });
      }
      const hash = persisted.sha256Hash.toLowerCase();
      if (params.query === undefined) {
        const query = store.get(hash);
        if (query === undefined) {
          throw new GraphQLError("PersistedQueryNotFound", {
            extensions: { code: "PERSISTED_QUERY_NOT_FOUND" },
          });
        }
        return { ...params, query };
      }
      if ((await sha256Hex(params.query)) !== hash) {
        throw new GraphQLError("provided sha does not match query", {
          extensions: { code: "PERSISTED_QUERY_HASH_MISMATCH" },
        });
      }
      pending.set(request, { hash, query: params.query });
      return undefined;
    },
    onExecute: ({ request, document }) => {
      const toStore = pending.get(request);
      if (toStore !== undefined) {
        pending.delete(request);
        // Only the exact text the core parsed and validated: a later onParams hook may have
        // replaced the query (the core parses with locations, so `loc.source.body` is that text).
        if (document.loc?.source.body === toStore.query) {
          store.set(toStore.hash, toStore.query);
        }
      }
      return undefined;
    },
  };
};
