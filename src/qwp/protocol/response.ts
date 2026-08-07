import { Buffer } from "node:buffer";

export const STATUS = {
  OK: 0x00,
  DURABLE_ACK: 0x02,
  SCHEMA_MISMATCH: 0x03,
  PARSE_ERROR: 0x05,
  INTERNAL_ERROR: 0x06,
  SECURITY_ERROR: 0x08,
  WRITE_ERROR: 0x09,
  CANCELLED: 0x0a,
  LIMIT_EXCEEDED: 0x0b,
  NOT_WRITABLE: 0x0c,
  DICTIONARY_GAP: 0x0d,
} as const;

export const MAX_ERROR_MESSAGE_LENGTH = 1024;

export interface QwpResponse {
  status: number;
  sequence: number;
  tables: { name: string; seqTxn: bigint }[];
  errorMessage?: string;
}

export function decodeResponse(payload: Buffer): QwpResponse {
  if (payload.length < 3) throw new Error("invalid QWP response: truncated");
  const status = payload.readUInt8(0);

  if (status === STATUS.DURABLE_ACK) {
    const count = payload.readUInt16LE(1);
    return { status, sequence: -1, tables: readTables(payload, 3, count) };
  }

  if (payload.length < 11) throw new Error("invalid QWP response: truncated");
  const sequence = Number(payload.readBigUInt64LE(1));

  if (status === STATUS.OK) {
    const count = payload.readUInt16LE(9);
    return { status, sequence, tables: readTables(payload, 11, count) };
  }

  const len = payload.readUInt16LE(9);
  if (len > MAX_ERROR_MESSAGE_LENGTH) throw new Error("invalid QWP response: error message too long");
  return {
    status,
    sequence,
    tables: [],
    errorMessage: payload.subarray(11, 11 + len).toString("utf8"),
  };
}

function readTables(buf: Buffer, offset: number, count: number) {
  const out: { name: string; seqTxn: bigint }[] = [];
  let o = offset;
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(o);
    o += 2;
    const name = buf.subarray(o, o + n).toString("utf8");
    o += n;
    out.push({ name, seqTxn: buf.readBigInt64LE(o) });
    o += 8;
  }
  return out;
}
