import { Buffer } from "node:buffer";
import { newMaskKey, applyMask } from "./mask";

export const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

const MAX_CONTROL_PAYLOAD = 125;

/** Client->server frames are always FIN=1 and always masked (spec 3.2.1). */
export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 65536) headerLen += 8;
  else if (len >= 126) headerLen += 2;

  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len < 65536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  const key = newMaskKey();
  key.copy(out, headerLen);
  payload.copy(out, headerLen + 4);
  applyMask(out.subarray(headerLen + 4), key);
  return out;
}

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private fragOpcode = -1;
  private frags: Buffer[] = [];

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  /** Returns the next complete message, or null when more bytes are needed. */
  next(): { opcode: number; payload: Buffer } | null {
    for (;;) {
      if (this.buf.length < 2) return null;
      const b0 = this.buf[0];
      const b1 = this.buf[1];

      if ((b0 & 0x70) !== 0) throw new Error("websocket: non-zero RSV bits");
      if ((b1 & 0x80) !== 0) throw new Error("websocket: inbound frame must not be masked");

      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const isControl = (opcode & 0x08) !== 0;

      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return null;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return null;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket: frame too large");
        len = Number(big);
        offset = 10;
      }

      if (isControl) {
        if (len > MAX_CONTROL_PAYLOAD) {
          throw new Error(`websocket: control frame payload exceeds ${MAX_CONTROL_PAYLOAD}`);
        }
        if (!fin) throw new Error("websocket: control frame must not be fragmented");
      }

      if (this.buf.length < offset + len) return null;
      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      this.buf = this.buf.subarray(offset + len);

      // Control frames are never fragmented and interleave freely.
      if (isControl) return { opcode, payload };

      if (opcode === OPCODE.CONT) {
        if (this.fragOpcode === -1) throw new Error("websocket: continuation without start");
        this.frags.push(payload);
        if (!fin) continue;
        const full = Buffer.concat(this.frags);
        const op = this.fragOpcode;
        this.frags = [];
        this.fragOpcode = -1;
        return { opcode: op, payload: full };
      }

      if (!fin) {
        this.fragOpcode = opcode;
        this.frags = [payload];
        continue;
      }
      return { opcode, payload };
    }
  }
}
