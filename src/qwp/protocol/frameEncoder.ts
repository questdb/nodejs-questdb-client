import { Buffer } from "node:buffer";
import { writeVarint, varintSize } from "./varint";
import { QwpTableBuffer } from "./tableBuffer";
import { columnPayloadSize, writeColumn, EncodeOpts } from "./columnWriter";
import { SymbolDict } from "./symbolDict";
import {
  HEADER_SIZE,
  QWP_MAGIC,
  QWP_VERSION,
  FLAG_GORILLA,
  FLAG_DELTA_SYMBOL_DICT,
  FLAG_DEFER_COMMIT,
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
  let n =
    stringSize(t.name) +
    varintSize(t.rowCount) +
    varintSize(t.columns.length);
  for (const c of t.columns) n += stringSize(c.name) + 1;
  for (const c of t.columns) n += columnPayloadSize(c, t.rowCount, colOpts);
  return n;
}

export interface FrameOpts {
  gorilla: boolean;
  /** Present means delta mode; absent means full-dict/inline mode. */
  dict?: SymbolDict;
  /** Highest symbol id the server has already confirmed. */
  confirmedMaxId?: number;
  deferCommit?: boolean;
}

/** Encodes one QWP v1 message (spec 6.1, 6.2). */
export function encodeFrame(tables: QwpTableBuffer[], opts: FrameOpts): Buffer {
  const delta = opts.dict !== undefined;
  const deltaStart = delta ? (opts.confirmedMaxId ?? -1) + 1 : 0;
  const entries = delta ? opts.dict!.entriesFrom(deltaStart) : [];

  let flags = 0;
  if (opts.gorilla) flags |= FLAG_GORILLA;
  if (delta) flags |= FLAG_DELTA_SYMBOL_DICT;
  if (opts.deferCommit) flags |= FLAG_DEFER_COMMIT;

  let payloadLen = 0;
  if (delta) {
    payloadLen += varintSize(deltaStart) + varintSize(entries.length);
    for (const s of entries) {
      const n = utf8Size(s);
      payloadLen += varintSize(n) + n;
    }
  }
  const colOpts: EncodeOpts = { gorilla: opts.gorilla, delta };
  payloadLen += tables.reduce((a, t) => a + tableSize(t, colOpts), 0);

  const buf = Buffer.allocUnsafe(HEADER_SIZE + payloadLen);
  QWP_MAGIC.copy(buf, 0);
  buf.writeUInt8(QWP_VERSION, 4);
  buf.writeUInt8(flags, 5);
  buf.writeUInt16LE(tables.length, 6);
  buf.writeUInt32LE(payloadLen, 8);

  let o = HEADER_SIZE;
  if (delta) {
    o = writeVarint(buf, o, deltaStart);
    o = writeVarint(buf, o, entries.length);
    for (const s of entries) {
      const n = utf8Size(s);
      o = writeVarint(buf, o, n);
      buf.write(s, o, "utf8");
      o += n;
    }
  }
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

/**
 * A commit carries no rows and MUST carry no symbols. The empty delta is built
 * by construction from [baseline+1 .. baseline] — deriving the bound from batch
 * state re-ships the whole dictionary in a frame no chunker covers (spec 5.1.1).
 */
export function encodeCommitFrame(
  dict: SymbolDict | undefined,
  baseline: number,
): Buffer {
  return encodeFrame([], {
    gorilla: false,
    dict,
    confirmedMaxId: baseline,
    deferCommit: false,
  });
}
