import { createServer, Server, Socket } from "node:net";
import { createHash } from "node:crypto";
import { applyMask } from "../../src/qwp/ws/mask";
import { STATUS } from "../../src/qwp/protocol/response";

export interface MockOptions {
  /** Return a status per received frame; OK by default. */
  statusFor?: (frameIndex: number) => number;
  /** Drop the connection after N frames. */
  dropAfter?: number;
  upgradeStatus?: number;
  upgradeHeaders?: string;
  /** Echo X-QWP-Durable-Ack: enabled on the 101 (durable-ack capable server). */
  durableAck?: boolean;
}

export function okResponse(seq: number): Buffer {
  const b = Buffer.alloc(11);
  b.writeUInt8(STATUS.OK, 0);
  b.writeBigUInt64LE(BigInt(seq), 1);
  b.writeUInt16LE(0, 9);
  return b;
}

export function errorResponse(status: number, seq: number, msg: string): Buffer {
  const b = Buffer.alloc(11 + msg.length);
  b.writeUInt8(status, 0);
  b.writeBigUInt64LE(BigInt(seq), 1);
  b.writeUInt16LE(msg.length, 9);
  b.write(msg, 11, "utf8");
  return b;
}

/**
 * Server → client frames are NEVER masked (RFC 6455 §5.1: only client frames
 * are). The shared encodeClientFrame masks, so the mock emits frames directly.
 */
function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 65536) headerLen += 8;
  else if (len >= 126) headerLen += 2;

  const out = Buffer.allocUnsafe(headerLen + len);
  out[0] = 0x80 | opcode;
  if (len < 126) {
    out[1] = len;
  } else if (len < 65536) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  payload.copy(out, headerLen);
  return out;
}

/**
 * Reads CLIENT frames, which ARE masked (the inverse of the library's
 * FrameParser, which rejects masked inbound). Unmask on arrival (spec 3.2.1).
 */
class MaskedFrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  next(): { opcode: number; payload: Buffer } | null {
    for (;;) {
      if (this.buf.length < 2) return null;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return null;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return null;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const payloadStart = offset + (masked ? 4 : 0);
      if (this.buf.length < payloadStart + len) return null;

      const payload = Buffer.from(this.buf.subarray(payloadStart, payloadStart + len));
      if (masked) applyMask(payload, this.buf.subarray(offset, offset + 4));
      this.buf = this.buf.subarray(payloadStart + len);
      return { opcode, payload };
    }
  }
}

export class MockQwpServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  readonly frames: Buffer[] = [];

  async start(opts: MockOptions = {}): Promise<number> {
    return new Promise((resolve) => {
      this.server = createServer((sock: Socket) => {
        this.sockets.add(sock);
        sock.on("close", () => this.sockets.delete(sock));
        this.onConn(sock, opts);
      });
      this.server.listen(0, "127.0.0.1", () =>
        resolve((this.server!.address() as any).port),
      );
    });
  }

  async stop(): Promise<void> {
    // Destroy any lingering half-open sockets first, or server.close() waits
    // for them and the callback never fires.
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private onConn(sock: Socket, opts: MockOptions): void {
    let handshaken = false;
    let seq = 0;
    const reader = new MaskedFrameReader();
    sock.on("error", () => undefined);
    sock.on("data", (chunk: Buffer) => {
      if (!handshaken) {
        const status = opts.upgradeStatus ?? 101;
        if (status !== 101) {
          sock.write(`HTTP/1.1 ${status} X\r\n${opts.upgradeHeaders ?? ""}\r\n`);
          sock.end();
          return;
        }
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(chunk.toString("ascii"))![1];
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "ascii")
          .digest("base64");
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
            "X-QWP-Version: 1\r\nX-QWP-Max-Batch-Size: 1048576\r\n" +
            `${opts.durableAck ? "X-QWP-Durable-Ack: enabled\r\n" : ""}\r\n`,
        );
        handshaken = true;
        return;
      }
      reader.push(chunk);
      for (let m = reader.next(); m; m = reader.next()) {
        if (m.opcode !== 0x2 /* BINARY */) continue;
        const idx = this.frames.length;
        this.frames.push(m.payload);
        if (opts.dropAfter !== undefined && idx + 1 >= opts.dropAfter) {
          sock.destroy();
          return;
        }
        const status = opts.statusFor ? opts.statusFor(idx) : STATUS.OK;
        const body =
          status === STATUS.OK ? okResponse(seq++) : errorResponse(status, seq++, "mock");
        sock.write(encodeServerFrame(0x2, body));
      }
    });
  }
}
