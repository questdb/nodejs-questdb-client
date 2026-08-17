import { QWP_MAX_SYMBOL_DICTIONARY_SIZE } from "./constants";

/** Connection-scoped QWP symbol dictionary. IDs are dense from zero. */
export class QwpSymbolDictionary {
  private readonly ids = new Map<string, number>();
  private readonly values: string[] = [];

  get size(): number {
    return this.values.length;
  }

  getOrAdd(value: string): number {
    const existing = this.ids.get(value);
    if (existing !== undefined) return existing;
    if (this.values.length >= QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
      throw new Error(
        `symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
      );
    }
    const id = this.values.length;
    this.ids.set(value, id);
    this.values.push(value);
    return id;
  }

  valueAt(id: number): string | undefined {
    return this.values[id];
  }

  /** Appends positionally without de-duplicating recovered entries. */
  addRecovered(value: string): number {
    if (this.values.length >= QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
      throw new Error(
        `symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
      );
    }
    const id = this.values.length;
    this.values.push(value);
    this.ids.set(value, id);
    return id;
  }

  entriesFrom(startId: number): string[] {
    return this.values.slice(Math.max(0, startId));
  }

  /** Rolls back entries added while preparing a frame that was not published. */
  truncate(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.values.length) {
      throw new RangeError(`invalid symbol dictionary size ${size}`);
    }
    if (size === this.values.length) return;
    this.values.length = size;
    this.ids.clear();
    this.values.forEach((value, id) => this.ids.set(value, id));
  }

  reset(): void {
    this.ids.clear();
    this.values.length = 0;
  }
}
