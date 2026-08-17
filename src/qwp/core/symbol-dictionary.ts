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

  reset(): void {
    this.ids.clear();
    this.values.length = 0;
  }
}
