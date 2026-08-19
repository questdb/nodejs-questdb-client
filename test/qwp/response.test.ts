import { describe, it, expect } from "vitest";
import { decodeResponse, STATUS } from "../../src/qwp/protocol/response";

function ok(seq: number, tables: [string, bigint][]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(11);
  head.writeUInt8(STATUS.OK, 0);
  head.writeBigUInt64LE(BigInt(seq), 1);
  head.writeUInt16LE(tables.length, 9);
  parts.push(head);
  for (const [name, txn] of tables) {
    const n = Buffer.byteLength(name, "utf8");
    const e = Buffer.alloc(2 + n + 8);
    e.writeUInt16LE(n, 0);
    e.write(name, 2, "utf8");
    e.writeBigInt64LE(txn, 2 + n);
    parts.push(e);
  }
  return Buffer.concat(parts);
}

describe("decodeResponse", () => {
  it("decodes an OK with per-table seqTxn", () => {
    const r = decodeResponse(ok(7, [["trades", 42n]]));
    expect(r.status).toBe(STATUS.OK);
    expect(r.sequence).toBe(7);
    expect(r.tables).toEqual([{ name: "trades", seqTxn: 42n }]);
  });

  it("decodes an error with its message", () => {
    const msg = "boom";
    const b = Buffer.alloc(11 + msg.length);
    b.writeUInt8(STATUS.WRITE_ERROR, 0);
    b.writeBigUInt64LE(3n, 1);
    b.writeUInt16LE(msg.length, 9);
    b.write(msg, 11, "utf8");
    const r = decodeResponse(b);
    expect(r.status).toBe(STATUS.WRITE_ERROR);
    expect(r.errorMessage).toBe("boom");
  });

  it("decodes DURABLE_ACK, which carries no sequence", () => {
    const b = Buffer.alloc(3);
    b.writeUInt8(STATUS.DURABLE_ACK, 0);
    b.writeUInt16LE(0, 1);
    expect(decodeResponse(b).status).toBe(STATUS.DURABLE_ACK);
  });

  it("rejects a truncated payload", () => {
    expect(() => decodeResponse(Buffer.alloc(2))).toThrow(/invalid|truncated/i);
  });
});
