import { Buffer } from "node:buffer";
import { writeVarint, varintSize } from "./varint";
import { QwpTableBuffer, ColumnBuffer } from "./tableBuffer";
import {
  HEADER_SIZE,
  QWP_MAGIC,
  QWP_VERSION,
  TYPE_DOUBLE,
  TYPE_LONG,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
} from "./constants";

function utf8Size(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** varint length + utf8 bytes (spec 6.0 "string"). */
function writeString(buf: Buffer, offset: number, s: string): number {
  const n = utf8Size(s);
  let o = writeVarint(buf, offset, n);
  buf.write(s, o, "utf8");
  return o + n;
}

function stringSize(s: string): number {
  const n = utf8Size(s);
  return varintSize(n) + n;
}

function columnPayloadSize(col: ColumnBuffer, rowCount: number): number {
  const nullCount = col.nulls.filter(Boolean).length;
  let n = 1; // nullHeader
  if (nullCount > 0) n += Math.ceil(rowCount / 8);
  const v = col.values.length;
  switch (col.type) {
    case TYPE_LONG:
    case TYPE_DOUBLE:
    case TYPE_TIMESTAMP:
      return n + v * 8;
    case TYPE_SYMBOL: {
      // Inline dictionary: varint dictSize, entries, then a varint index per value.
      const dict = [...new Set(col.values as string[])];
      n += varintSize(dict.length);
      for (const s of dict) n += stringSize(s);
      for (const s of col.values as string[]) n += varintSize(dict.indexOf(s));
      return n;
    }
    default:
      throw new Error(`unsupported QWP column type: 0x${col.type.toString(16)}`);
  }
}

function writeColumn(
  buf: Buffer,
  offset: number,
  col: ColumnBuffer,
  rowCount: number,
): number {
  let o = offset;
  const nullCount = col.nulls.filter(Boolean).length;
  if (nullCount > 0) {
    buf[o++] = 1;
    const bytes = Math.ceil(rowCount / 8);
    buf.fill(0, o, o + bytes);
    for (let i = 0; i < rowCount; i++) {
      // bit i set means row i is NULL, LSB-first within each byte (spec 6.2.1)
      if (col.nulls[i]) buf[o + (i >>> 3)] |= 1 << (i & 7);
    }
    o += bytes;
  } else {
    buf[o++] = 0;
  }

  switch (col.type) {
    case TYPE_LONG:
    case TYPE_TIMESTAMP:
      for (const v of col.values) {
        buf.writeBigInt64LE(BigInt(v as number | bigint), o);
        o += 8;
      }
      return o;
    case TYPE_DOUBLE:
      for (const v of col.values) {
        buf.writeDoubleLE(v as number, o);
        o += 8;
      }
      return o;
    case TYPE_SYMBOL: {
      const dict = [...new Set(col.values as string[])];
      o = writeVarint(buf, o, dict.length);
      for (const s of dict) o = writeString(buf, o, s);
      for (const s of col.values as string[]) o = writeVarint(buf, o, dict.indexOf(s));
      return o;
    }
    default:
      throw new Error(`unsupported QWP column type: 0x${col.type.toString(16)}`);
  }
}

function tableSize(t: QwpTableBuffer): number {
  let n = stringSize(t.name) + varintSize(t.rowCount) + varintSize(t.columns.length);
  for (const c of t.columns) n += stringSize(c.name) + 1;
  for (const c of t.columns) n += columnPayloadSize(c, t.rowCount);
  return n;
}

/** Encodes one QWP v1 message. No flags are set in this plan (spec 6.1). */
export function encodeFrame(tables: QwpTableBuffer[]): Buffer {
  const payloadLen = tables.reduce((a, t) => a + tableSize(t), 0);
  const buf = Buffer.allocUnsafe(HEADER_SIZE + payloadLen);

  QWP_MAGIC.copy(buf, 0);
  buf.writeUInt8(QWP_VERSION, 4);
  buf.writeUInt8(0, 5); // flags
  buf.writeUInt16LE(tables.length, 6);
  buf.writeUInt32LE(payloadLen, 8);

  let o = HEADER_SIZE;
  for (const t of tables) {
    o = writeString(buf, o, t.name);
    o = writeVarint(buf, o, t.rowCount);
    o = writeVarint(buf, o, t.columns.length);
    for (const c of t.columns) {
      o = writeString(buf, o, c.name);
      buf.writeUInt8(c.type, o++);
    }
    for (const c of t.columns) o = writeColumn(buf, o, c, t.rowCount);
  }
  if (o !== buf.length) {
    throw new Error(`frame size mismatch: wrote ${o}, sized ${buf.length}`);
  }
  return buf;
}
