import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QwpTransport } from "../../src/qwp/transport";
import { QwpBuffer } from "../../src/qwp/buffer";
import { FLAG_DELTA_SYMBOL_DICT } from "../../src/qwp/protocol/constants";
import { readVarint } from "../../src/qwp/protocol/varint";
import { SenderOptions } from "../../src/options";
import { SenderError, Category, Policy } from "../../src/qwp/errors";
import { STATUS } from "../../src/qwp/protocol/response";
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

  it("uses the QWP auto-flush INTERVAL default (100 ms), not the ILP 1000 ms (spec 9.1)", () => {
    const t = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    expect(t.getDefaultAutoFlushInterval()).toBe(100);
  });

  it("applies the 128 MiB memory retention default without sf_dir and 10 GiB with it (spec 9.1)", () => {
    const mem = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    expect(mem.engineMaxTotalBytes).toBe(128 * 1024 * 1024);
    const disk = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;sf_dir=/tmp/x;"));
    expect(disk.engineMaxTotalBytes).toBe(10 * 1024 * 1024 * 1024);
  });

  it("an explicit sf_max_total_bytes overrides either mode default", () => {
    const t = new QwpTransport(
      new SenderOptions("ws::addr=localhost:9000;sf_dir=/tmp/x;sf_max_total_bytes=1048576;"),
    );
    expect(t.engineMaxTotalBytes).toBe(1024 * 1024);
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

  it("escalates a repeatedly rejected frame to a terminal PROTOCOL_VIOLATION (spec 7.4)", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    // Drop the connection after every frame so the unacked frame is re-sent on
    // each reconnect; each non-orderly close after a send counts a strike, and
    // with a 0 dwell window the strike threshold latches terminal.
    const port = await s.start({ dropAfter: 1 });
    const t = new QwpTransport(
      new SenderOptions(
        `ws::addr=127.0.0.1:${port};max_frame_rejections=3;poison_min_escalation_window_millis=0;`,
      ),
    );
    const errors: SenderError[] = [];
    t.onError((e) => errors.push(e));
    await t.connect();

    const b = new QwpBuffer();
    t.attachSymbolBuffer(b);
    b.table("t").symbol("s", "a").intColumn("x", 1);
    b.at(1n, "us");
    await t.sendFrames(b.sealFrames(1 << 20));

    // Give the reconnect/replay cycles time to accrue strikes (3) and latch.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const escalated = errors.find((e) => e.category === Category.PROTOCOL_VIOLATION);
      if (escalated) {
        expect(escalated.policy).toBe(Policy.TERMINAL);
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      errors.some((e) => e.category === Category.PROTOCOL_VIOLATION && e.policy === Policy.TERMINAL),
    ).toBe(true);
    // The transport is now terminal: further sends must throw, not reconnect.
    await expect(t.send(Buffer.alloc(8))).rejects.toThrow(/poisoned/i);
    await t.close();
  });
});
