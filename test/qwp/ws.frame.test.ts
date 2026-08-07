import { describe, it, expect } from "vitest";
import { encodeClientFrame, FrameParser, OPCODE } from "../../src/qwp/ws/frame";

/** Server->client frames are never masked (RFC 6455). */
function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const head: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length < 126) head.push(payload.length);
  else if (payload.length < 65536) head.push(126, payload.length >>> 8, payload.length & 0xff);
  else throw new Error("test helper: use a small payload");
  return Buffer.concat([Buffer.from(head), payload]);
}

describe("ws frame codec", () => {
  it("encodes a masked client binary frame", () => {
    const f = encodeClientFrame(OPCODE.BINARY, Buffer.from([1, 2, 3]));
    expect(f[0]).toBe(0x82); // FIN + binary
    expect(f[1] & 0x80).toBe(0x80); // mask bit set
    expect(f[1] & 0x7f).toBe(3);
    expect(f.length).toBe(2 + 4 + 3);
  });

  it("uses the 64-bit length form above 65535", () => {
    const f = encodeClientFrame(OPCODE.BINARY, Buffer.alloc(70000));
    expect(f[1] & 0x7f).toBe(127);
    expect(Number(f.readBigUInt64BE(2))).toBe(70000);
  });

  it("parses a frame split across chunks", () => {
    const whole = serverFrame(OPCODE.BINARY, Buffer.from("abcd"));
    const p = new FrameParser();
    p.push(whole.subarray(0, 3));
    expect(p.next()).toBeNull();
    p.push(whole.subarray(3));
    expect(p.next()!.payload.toString()).toBe("abcd");
  });

  it("defragments continuation frames", () => {
    const p = new FrameParser();
    p.push(serverFrame(OPCODE.BINARY, Buffer.from("ab"), false));
    expect(p.next()).toBeNull();
    p.push(serverFrame(OPCODE.CONT, Buffer.from("cd"), true));
    const msg = p.next()!;
    expect(msg.opcode).toBe(OPCODE.BINARY);
    expect(msg.payload.toString()).toBe("abcd");
  });

  it("rejects a masked inbound frame", () => {
    const f = serverFrame(OPCODE.BINARY, Buffer.from("x"));
    f[1] |= 0x80; // claim masked
    const p = new FrameParser();
    p.push(f);
    expect(() => p.next()).toThrow(/masked/i);
  });

  it("rejects non-zero RSV bits", () => {
    const f = serverFrame(OPCODE.BINARY, Buffer.from("x"));
    f[0] |= 0x40;
    const p = new FrameParser();
    p.push(f);
    expect(() => p.next()).toThrow(/rsv/i);
  });

  it("rejects an oversized control frame", () => {
    const f = serverFrame(OPCODE.PING, Buffer.alloc(126));
    const p = new FrameParser();
    p.push(f);
    expect(() => p.next()).toThrow(/control frame/i);
  });
});
