import { Buffer } from "node:buffer";
import { writeVarint, varintSize } from "./varint";
import { ColumnBuffer } from "./tableBuffer";
import * as T from "./constants";

export interface EncodeOpts {
  gorilla: boolean;
  /** Present+true means global-symbol delta mode: per-column dict omitted. */
  delta?: boolean;
}

function nullCountOf(col: ColumnBuffer): number {
  let n = 0;
  for (const v of col.nulls) if (v) n++;
  return n;
}

function fixedWidth(type: number): number | undefined {
  switch (type) {
    case T.TYPE_BYTE:
      return 1;
    case T.TYPE_SHORT:
    case T.TYPE_CHAR:
      return 2;
    case T.TYPE_INT:
    case T.TYPE_FLOAT:
    case T.TYPE_IPV4:
      return 4;
    case T.TYPE_LONG:
    case T.TYPE_DOUBLE:
    case T.TYPE_DATE:
    case T.TYPE_TIMESTAMP:
    case T.TYPE_TIMESTAMP_NANOS:
      return 8;
    case T.TYPE_UUID:
      return 16;
    case T.TYPE_LONG256:
      return 32;
    default:
      return undefined;
  }
}

export function flattenArray(a: unknown[]): { dims: number[]; data: number[] } {
  const dims: number[] = [];
  let level: unknown = a;
  while (Array.isArray(level)) {
    dims.push(level.length);
    level = level[0];
  }
  const data: number[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth === dims.length) {
      data.push(node as number);
      return;
    }
    if (!Array.isArray(node) || node.length !== dims[depth]) {
      throw new Error("irregular array shape");
    }
    for (const child of node) walk(child, depth + 1);
  };
  walk(a, 0);
  return { dims, data };
}

export function columnPayloadSize(
  col: ColumnBuffer,
  rowCount: number,
  opts: EncodeOpts,
): number {
  let n = 1;
  if (nullCountOf(col) > 0) n += Math.ceil(rowCount / 8);
  const v = col.values.length;

  if (col.type === T.TYPE_BOOLEAN) return n + Math.ceil(v / 8);

  const w = fixedWidth(col.type);
  if (w !== undefined) return n + v * w;

  if (col.type === T.TYPE_SYMBOL) {
    if (opts.delta) {
      let n2 = 0;
      for (const id of col.values as number[]) n2 += varintSize(id);
      return n + n2;
    }
    const dict = [...new Set(col.values as string[])];
    n += varintSize(dict.length);
    for (const s of dict) {
      const b = Buffer.byteLength(s, "utf8");
      n += varintSize(b) + b;
    }
    for (const s of col.values as string[]) n += varintSize(dict.indexOf(s));
    return n;
  }

  if (col.type === T.TYPE_VARCHAR || col.type === T.TYPE_BINARY) {
    let data = 0;
    for (const s of col.values) {
      data +=
        col.type === T.TYPE_VARCHAR
          ? Buffer.byteLength(s as string, "utf8")
          : (s as unknown as Buffer).length;
    }
    return n + (v + 1) * 4 + data;
  }

  if (col.type === T.TYPE_DOUBLE_ARRAY || col.type === T.TYPE_LONG_ARRAY) {
    let total = 0;
    for (const val of col.values) {
      const a = val as unknown as { dims: number[]; data: number[] };
      total += 1 + a.dims.length * 4 + a.data.length * 8;
    }
    return n + total;
  }
  if (col.type === T.TYPE_GEOHASH) {
    const p = col.geohashPrecision ?? 1;
    return n + varintSize(p) + v * Math.ceil(p / 8);
  }
  if (col.type === T.TYPE_DECIMAL64) return n + 1 + v * 8;
  if (col.type === T.TYPE_DECIMAL128) return n + 1 + v * 16;
  if (col.type === T.TYPE_DECIMAL256) return n + 1 + v * 32;

  throw new Error(`unsupported QWP column type: 0x${col.type.toString(16)}`);
}

export function writeColumn(
  buf: Buffer,
  offset: number,
  col: ColumnBuffer,
  rowCount: number,
  opts: EncodeOpts,
): number {
  let o = offset;
  if (nullCountOf(col) > 0) {
    buf[o++] = 1;
    const bytes = Math.ceil(rowCount / 8);
    buf.fill(0, o, o + bytes);
    for (let i = 0; i < rowCount; i++) {
      if (col.nulls[i]) buf[o + (i >>> 3)] |= 1 << (i & 7);
    }
    o += bytes;
  } else {
    buf[o++] = 0;
  }

  switch (col.type) {
    case T.TYPE_BOOLEAN: {
      const bytes = Math.ceil(col.values.length / 8);
      buf.fill(0, o, o + bytes);
      col.values.forEach((v, i) => {
        if (v) buf[o + (i >>> 3)] |= 1 << (i & 7);
      });
      return o + bytes;
    }
    case T.TYPE_BYTE:
      for (const v of col.values) buf.writeInt8(Number(v), o++);
      return o;
    case T.TYPE_SHORT:
      for (const v of col.values) {
        buf.writeInt16LE(Number(v), o);
        o += 2;
      }
      return o;
    case T.TYPE_CHAR:
      for (const v of col.values) {
        buf.writeUInt16LE((v as string).charCodeAt(0), o);
        o += 2;
      }
      return o;
    case T.TYPE_INT:
      for (const v of col.values) {
        buf.writeInt32LE(Number(v), o);
        o += 4;
      }
      return o;
    case T.TYPE_IPV4:
      for (const v of col.values) {
        buf.writeUInt32LE(Number(v) >>> 0, o);
        o += 4;
      }
      return o;
    case T.TYPE_FLOAT:
      for (const v of col.values) {
        buf.writeFloatLE(Number(v), o);
        o += 4;
      }
      return o;
    case T.TYPE_LONG:
    case T.TYPE_DATE:
    case T.TYPE_TIMESTAMP:
    case T.TYPE_TIMESTAMP_NANOS:
      for (const v of col.values) {
        buf.writeBigInt64LE(BigInt(v as number | bigint), o);
        o += 8;
      }
      return o;
    case T.TYPE_DOUBLE:
      for (const v of col.values) {
        buf.writeDoubleLE(Number(v), o);
        o += 8;
      }
      return o;
    case T.TYPE_UUID:
      for (const v of col.values) {
        (v as unknown as Buffer).copy(buf, o);
        o += 16;
      }
      return o;
    case T.TYPE_LONG256:
      for (const v of col.values) {
        (v as unknown as Buffer).copy(buf, o);
        o += 32;
      }
      return o;
    case T.TYPE_SYMBOL: {
      if (opts.delta) {
        for (const id of col.values as number[]) o = writeVarint(buf, o, id);
        return o;
      }
      const dict = [...new Set(col.values as string[])];
      o = writeVarint(buf, o, dict.length);
      for (const s of dict) {
        const n = Buffer.byteLength(s, "utf8");
        o = writeVarint(buf, o, n);
        buf.write(s, o, "utf8");
        o += n;
      }
      for (const s of col.values as string[])
        o = writeVarint(buf, o, dict.indexOf(s));
      return o;
    }
    case T.TYPE_VARCHAR:
    case T.TYPE_BINARY: {
      const parts: Buffer[] = col.values.map((s) =>
        col.type === T.TYPE_VARCHAR
          ? Buffer.from(s as string, "utf8")
          : (s as unknown as Buffer),
      );
      let acc = 0;
      buf.writeUInt32LE(0, o);
      o += 4;
      for (const p of parts) {
        acc += p.length;
        buf.writeUInt32LE(acc, o);
        o += 4;
      }
      for (const p of parts) {
        p.copy(buf, o);
        o += p.length;
      }
      return o;
    }
    case T.TYPE_DOUBLE_ARRAY:
    case T.TYPE_LONG_ARRAY: {
      for (const val of col.values) {
        const a = val as unknown as { dims: number[]; data: number[] };
        buf.writeUInt8(a.dims.length, o++);
        for (const d of a.dims) {
          buf.writeUInt32LE(d, o);
          o += 4;
        }
        for (const x of a.data) {
          if (col.type === T.TYPE_DOUBLE_ARRAY) buf.writeDoubleLE(x, o);
          else buf.writeBigInt64LE(BigInt(x), o);
          o += 8;
        }
      }
      return o;
    }
    case T.TYPE_GEOHASH: {
      const p = col.geohashPrecision ?? 1;
      o = writeVarint(buf, o, p);
      const width = Math.ceil(p / 8);
      for (const val of col.values) {
        let bits = BigInt(val as bigint);
        for (let i = 0; i < width; i++) {
          buf.writeUInt8(Number(bits & 0xffn), o++);
          bits >>= 8n;
        }
      }
      return o;
    }
    case T.TYPE_DECIMAL64:
    case T.TYPE_DECIMAL128:
    case T.TYPE_DECIMAL256: {
      buf.writeUInt8(col.decimalScale ?? 0, o++);
      const width =
        col.type === T.TYPE_DECIMAL64
          ? 8
          : col.type === T.TYPE_DECIMAL128
            ? 16
            : 32;
      for (const val of col.values) {
        let x = BigInt(val as bigint);
        for (let i = 0; i < width; i++) {
          buf.writeUInt8(Number(x & 0xffn), o++);
          x >>= 8n;
        }
      }
      return o;
    }
    default:
      throw new Error(
        `unsupported QWP column type: 0x${col.type.toString(16)}`,
      );
  }
}
