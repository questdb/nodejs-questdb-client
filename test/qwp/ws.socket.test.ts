import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import { createServer, Server, Socket } from "node:net";
import { createHash } from "node:crypto";
import { QwpWebSocket } from "../../src/qwp/ws/socket";
import { encodeClientFrame, OPCODE } from "../../src/qwp/ws/frame";

let server: Server | undefined;
afterEach(() => server?.close());

/**
 * Decodes client->server frames, which RFC 6455 requires to be MASKED.
 * (The client-side FrameParser deliberately rejects masked frames, so it can't
 * be reused here — a real server must unmask client frames.)
 */
function maskedFrameDecoder() {
  let buf = Buffer.alloc(0);
  return function decode(chunk: Buffer): { opcode: number; payload: Buffer }[] {
    buf = Buffer.concat([buf, chunk]);
    const out: { opcode: number; payload: Buffer }[] = [];
    for (;;) {
      if (buf.length < 2) break;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const keyLen = masked ? 4 : 0;
      if (buf.length < off + keyLen + len) break;
      const key = buf.subarray(off, off + keyLen);
      const payload = Buffer.from(
        buf.subarray(off + keyLen, off + keyLen + len),
      );
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      buf = buf.subarray(off + keyLen + len);
      out.push({ opcode, payload });
    }
    return out;
  };
}

function serverBinaryFrame(payload: Buffer): Buffer {
  if (payload.length >= 126) throw new Error("test payload is too large");
  return Buffer.concat([Buffer.from([0x82, payload.length]), payload]);
}

/** Minimal QWP-ish websocket server: completes the upgrade, echoes nothing. */
function startServer(
  onBinary: (b: Buffer) => void,
  afterHandshake?: (socket: Socket) => void,
  handshakeSuffix?: Buffer,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((sock) => {
      let handshaken = false;
      const decode = maskedFrameDecoder();
      sock.on("data", (chunk) => {
        if (!handshaken) {
          const text = chunk.toString("ascii");
          const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(text)![1];
          const accept = createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "ascii")
            .digest("base64");
          const response = Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
              `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
              "X-QWP-Version: 1\r\nX-QWP-Max-Batch-Size: 1048576\r\n\r\n",
            "ascii",
          );
          sock.write(
            handshakeSuffix
              ? Buffer.concat([response, handshakeSuffix])
              : response,
          );
          handshaken = true;
          if (afterHandshake) setTimeout(() => afterHandshake(sock), 10);
          return;
        }
        for (const m of decode(chunk)) {
          if (m.opcode === OPCODE.BINARY) onBinary(m.payload);
          if (m.opcode === OPCODE.PING)
            sock.write(encodeClientFrame(OPCODE.PONG, m.payload));
        }
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve((server!.address() as AddressInfo).port),
    );
  });
}

describe("QwpWebSocket", () => {
  it("connects, negotiates, and sends a binary frame", async () => {
    const received: Buffer[] = [];
    const port = await startServer((b) => received.push(b));
    const ws = await QwpWebSocket.connect({
      host: "127.0.0.1",
      port,
      tls: false,
      clientId: "nodejs/1.0.0",
    });
    expect(ws.maxBatchSize).toBe(1048576);
    await ws.sendBinary(Buffer.from("payload"));
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(1);
    expect(received[0].toString()).toBe("payload");
    await ws.close();
  });

  it("dispatches coalesced handshake leftovers only after connect resolves", async () => {
    const payload = Buffer.from("early-response");
    let connectResolved = false;
    let callbackAfterResolve = false;
    const port = await startServer(
      () => undefined,
      undefined,
      serverBinaryFrame(payload),
    );
    const ws = await QwpWebSocket.connect({
      host: "127.0.0.1",
      port,
      tls: false,
      clientId: "x",
      onBinary: (received) => {
        callbackAfterResolve = connectResolved && received.equals(payload);
      },
    });
    connectResolved = true;
    await new Promise((r) => setImmediate(r));
    expect(callbackAfterResolve).toBe(true);
    await ws.close();
  });

  it("turns malformed inbound framing into one abrupt close", async () => {
    const closes: { orderly: boolean; framesSent: number }[] = [];
    const port = await startServer(
      () => undefined,
      (sock) => sock.write(Buffer.from([0x82, 0x80])), // masked server frame
    );
    const ws = await QwpWebSocket.connect({
      host: "127.0.0.1",
      port,
      tls: false,
      clientId: "x",
      onClose: (info) => closes.push(info),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toEqual([{ orderly: false, framesSent: 0 }]);
    await ws.close();
  });

  it("contains an exception thrown by the binary response callback", async () => {
    const closes: { orderly: boolean; framesSent: number }[] = [];
    const payload = Buffer.from("bad-qwp-response");
    const frame = serverBinaryFrame(payload);
    const port = await startServer(
      () => undefined,
      (sock) => sock.write(frame),
    );
    const ws = await QwpWebSocket.connect({
      host: "127.0.0.1",
      port,
      tls: false,
      clientId: "x",
      onBinary: () => {
        throw new Error("decoder rejected payload");
      },
      onClose: (info) => closes.push(info),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toEqual([{ orderly: false, framesSent: 0 }]);
    await ws.close();
  });

  it("rejects a bad Sec-WebSocket-Accept", async () => {
    server = createServer((sock) => {
      sock.on("data", () =>
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
        ),
      );
    });
    const port: number = await new Promise((r) =>
      server!.listen(0, "127.0.0.1", () =>
        r((server!.address() as AddressInfo).port),
      ),
    );
    await expect(
      QwpWebSocket.connect({
        host: "127.0.0.1",
        port,
        tls: false,
        clientId: "x",
      }),
    ).rejects.toThrow(/accept/i);
  });
});
