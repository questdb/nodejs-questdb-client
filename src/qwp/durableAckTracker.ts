export interface TableTxn {
  name: string;
  seqTxn: bigint;
}

/**
 * Correlates OK-level per-table transaction numbers with cumulative
 * DURABLE_ACK table watermarks. Entries retire strictly in FSN order so a
 * later durable batch can never trim through an earlier unresolved one.
 */
export class DurableAckTracker {
  private readonly pending = new Map<number, TableTxn[]>();
  private readonly watermarks = new Map<string, bigint>();
  private acked = -1;

  reset(ackedFsn: number): void {
    this.pending.clear();
    this.watermarks.clear();
    this.acked = ackedFsn;
  }

  onOk(fsn: number, tables: TableTxn[]): number | null {
    if (fsn <= this.acked) return null;
    this.pending.set(
      fsn,
      tables.map((t) => ({ name: t.name, seqTxn: t.seqTxn })),
    );
    return this.drain();
  }

  onDurableAck(tables: TableTxn[]): number | null {
    for (const { name, seqTxn } of tables) {
      const current = this.watermarks.get(name);
      if (current === undefined || seqTxn > current) {
        this.watermarks.set(name, seqTxn);
      }
    }
    return this.drain();
  }

  private drain(): number | null {
    const before = this.acked;
    for (;;) {
      const next = this.pending.get(this.acked + 1);
      if (!next || !this.covered(next)) break;
      this.pending.delete(this.acked + 1);
      this.acked++;
    }
    return this.acked > before ? this.acked : null;
  }

  private covered(tables: TableTxn[]): boolean {
    return tables.every((t) => {
      const watermark = this.watermarks.get(t.name);
      return watermark !== undefined && watermark >= t.seqTxn;
    });
  }
}
