/** A least-recently-used map over Map's insertion order. A `max` of 0 stores nothing. */
export class Lru<K, V> {
  readonly #max: number;
  readonly #map = new Map<K, V>();

  constructor(max: number) {
    this.#max = Math.max(0, Math.floor(max));
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.#max === 0) {
      return;
    }
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#map.delete(oldest.value);
    }
  }

  clear(): void {
    this.#map.clear();
  }
}
