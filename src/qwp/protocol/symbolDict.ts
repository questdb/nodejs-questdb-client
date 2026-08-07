import { MAX_SYMBOL_DICTIONARY_SIZE } from "./constants";

/** Connection-scoped global symbol dictionary. Ids are dense from 0. */
export class SymbolDict {
  private readonly ids = new Map<string, number>();
  private readonly list: string[] = [];

  size(): number {
    return this.list.length;
  }

  checkCap(next: number): void {
    if (next >= MAX_SYMBOL_DICTIONARY_SIZE) {
      throw new Error(
        `symbol dictionary exceeds maximum size ${MAX_SYMBOL_DICTIONARY_SIZE}`,
      );
    }
  }

  getOrAdd(s: string): number {
    const existing = this.ids.get(s);
    if (existing !== undefined) return existing;
    this.checkCap(this.list.length);
    const id = this.list.length;
    this.ids.set(s, id);
    this.list.push(s);
    return id;
  }

  /**
   * Appends at the next id WITHOUT de-duplicating. The persisted dictionary,
   * the wire delta and the catch-up mirror all key on POSITION, so collapsing
   * two entries would leave this shorter than the persisted count and silently
   * misattribute every later symbol (spec 8.1.6).
   */
  addRecovered(s: string): number {
    const id = this.list.length;
    this.list.push(s);
    // Keep the highest id; both encode identically, and callers rely on the
    // positional ordinal for catch-up mirroring.
    this.ids.set(s, id);
    return id;
  }

  entriesFrom(startId: number): string[] {
    return this.list.slice(Math.max(0, startId));
  }

  reset(): void {
    this.ids.clear();
    this.list.length = 0;
  }
}
