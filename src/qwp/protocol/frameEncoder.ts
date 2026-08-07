import { Buffer } from "node:buffer";
import { writeVarint, varintSize } from "./varint";
import { QwpTableBuffer } from "./tableBuffer";
import { columnPayloadSize, writeColumn, EncodeOpts } from "./columnWriter";
import {
  HEADER_SIZE,
  QWP_MAGIC,
  QWP_VERSION,
} from "./constants";

function utf8Size(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** varint length + utf8 bytes (spec 6.0 "string"). */
function writeString(buf: Buffer, offset: number, s: string): number {
  const n = utf8Size(s);
  const o = writeVarint(buf, offset, n);
  buf.write(s, o, "utf8");
  return o + n;
}

function stringSize(s: string): number {
  const n = utf8Size(s);
  return varintSize(n) + n;
}

function tableSize(t: QwpTableBuffer, colOpts: EncodeOpts): number {
  let n = stringSize(t.name) + varintSize(t.rowCount) + varintSize(t.columns.length);
  for (const c of t.columns) n += stringSize(c.name) + 1;
  for (const c of t.columns) n += columnPayloadSize(c, t.rowCount, colOpts);
  return n;
}

/** Encodes one QWP v1 message. No flags are set in this plan (spec 6.1). */
export function encodeFrame(tables: QwpTableBuffer[]): Buffer {
  const colOpts: EncodeOpts = { gorilla: false };
  const payloadLen = tables.reduce((a, t) => a + tableSize(t, colOpts), 0);
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
    for (const c of t.columns) o = writeColumn(buf, o, c, t.rowCount, colOpts);
  }
  if (o !== buf.length) {
    throw new Error(`frame size mismatch: wrote ${o}, sized ${buf.length}`);
  }
  return buf;
}
