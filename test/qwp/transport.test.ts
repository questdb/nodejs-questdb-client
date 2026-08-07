import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QwpTransport } from "../../src/qwp/transport";
import { QwpBuffer } from "../../src/qwp/buffer";
import { FLAG_DELTA_SYMBOL_DICT } from "../../src/qwp/protocol/constants";
import { readVarint } from "../../src/qwp/protocol/varint";
import { SenderOptions } from "../../src/options";
import { MockQwpServer } from "./mockServer";

let mocks: MockQwpServer[] = [];
afterEach(async () => {
  for (const m of mocks) await m.stop();
  mocks = [];
});

describe("QwpTransport", () => {
  it("uses the QWP auto-flush row default, not the ILP one", () => {
    const t = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    expect(t.getDefaultAutoFlushRows()).toBe(1000);
  });

  it("refuses to send before connect", async () => {
    const t = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    await expect(t.send(Buffer.from([1]))).rejects.toThrow(/not connected/i);
  });

  it("an explicit connect() joins an in-flight connect instead of double-opening the slot", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    const port = await s.start();
    const dir = mkdtempSync(join(tmpdir(), "qwp-cc-"));
    try {
      const t = new QwpTransport(
        new SenderOptions(`ws::addr=127.0.0.1:${port};sf_dir=${dir};`),
      );
      // Two concurrent connects must share one engine open: a second open would
      // trip the slot lock and reject (spec 4.3 / shortened C4).
      const [a, b] = await Promise.all([t.connect(), t.connect()]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      await t.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("connect() after an established connection returns without reopening", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    const port = await s.start();
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    expect(await t.connect()).toBe(true);
    expect(await t.connect()).toBe(true);
    await t.close();
  });

  it("request_durable_ack=on fails fast on a server that cannot confirm it (spec 6.5.1)", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    const port = await s.start(); // no X-QWP-Durable-Ack: enabled echo
    const t = new QwpTransport(
      new SenderOptions(`ws::addr=127.0.0.1:${port};request_durable_ack=on;`),
    );
    await expect(t.connect()).rejects.toThrow(/durable.*ack/i);
  });

  it("request_durable_ack=on connects when the server confirms durable acks", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    const port = await s.start({ durableAck: true });
    const t = new QwpTransport(
      new SenderOptions(`ws::addr=127.0.0.1:${port};request_durable_ack=on;`),
    );
    expect(await t.connect()).toBe(true);
    await t.close();
  });

  it("delta mode wires buffer->transport and advances the baseline on publish (spec 5.2, 8.1.6)", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    const port = await s.start();
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    const b = new QwpBuffer();
    t.attachSymbolBuffer(b);
    await t.connect();

    // First batch introduces alpha; the emitted frame must carry a delta flag.
    b.table("t").symbol("s", "alpha").intColumn("x", 1);
    b.at(1n, "us");
    await t.sendFrames(b.sealFrames(1 << 20));
    await new Promise((r) => setTimeout(r, 100));
    expect(s.frames[0].readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(FLAG_DELTA_SYMBOL_DICT);

    // Second batch reuses confirmed alpha and introduces only beta, so its
    // delta must begin at id 1 (baseline 0) and carry exactly one entry.
    b.table("t").symbol("s", "beta").intColumn("x", 2);
    b.at(2n, "us");
    await t.sendFrames(b.sealFrames(1 << 20));
    await new Promise((r) => setTimeout(r, 100));
    const start = readVarint(s.frames[1], 12);
    const count = readVarint(s.frames[1], start.offset);
    expect(start.value).toBe(1);
    expect(count.value).toBe(1);
    await t.close();
  });
});
