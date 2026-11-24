// The document cache (docs/plan.html M4a): an LRU keyed by (schema generation, query text) that
// stores parsed, validated documents only. Each entry keys per-operation plugin state by the
// selected operation, so one document holding a mutation and a query never shares a compilation.
import type { DocumentNode, OperationDefinitionNode } from "graphql";

import { Lru } from "./lru.ts";

/** The per-operation identity handed to plugins as `operationKey`. */
export interface OperationEntry {
  readonly operation: OperationDefinitionNode;
}

export interface DocumentEntry {
  readonly document: DocumentNode;
  readonly operations: Map<OperationDefinitionNode, OperationEntry>;
}

export const operationEntry = (
  entry: DocumentEntry,
  operation: OperationDefinitionNode,
): OperationEntry => {
  let found = entry.operations.get(operation);
  if (found === undefined) {
    found = { operation };
    entry.operations.set(operation, found);
  }
  return found;
};

export class DocumentCache {
  readonly #lru: Lru<string, DocumentEntry>;

  constructor(max: number) {
    this.#lru = new Lru(max);
  }

  get size(): number {
    return this.#lru.size;
  }

  get(generation: number, query: string): DocumentEntry | undefined {
    return this.#lru.get(`${generation}\u0000${query}`);
  }

  set(generation: number, query: string, document: DocumentNode): DocumentEntry {
    const entry: DocumentEntry = { document, operations: new Map() };
    this.#lru.set(`${generation}\u0000${query}`, entry);
    return entry;
  }

  /** Drops every entry (on a new schema generation; in-flight requests keep their entries). */
  clear(): void {
    this.#lru.clear();
  }
}
