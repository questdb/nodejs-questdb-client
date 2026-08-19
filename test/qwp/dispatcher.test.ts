import { describe, it, expect } from "vitest";
import { Dispatcher } from "../../src/qwp/dispatcher";
import { SenderOptions } from "../../src/options";
import { deriveConnectMode, ConnectMode } from "../../src/qwp/transport";

describe("Dispatcher", () => {
  it("drops the OLDEST entry when full and counts the drop", async () => {
    const seen: number[] = [];
    const d = new Dispatcher<number>(2, (v) => seen.push(v));
    d.offer(1);
    d.offer(2);
    d.offer(3); // evicts 1
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([2, 3]);
    expect(d.dropped).toBe(1);
  });

  it("never invokes the handler synchronously", () => {
    let called = false;
    const d = new Dispatcher<number>(4, () => (called = true));
    d.offer(1);
    expect(called).toBe(false);
  });

  it("survives a throwing handler", async () => {
    const d = new Dispatcher<number>(4, () => {
      throw new Error("bad handler");
    });
    d.offer(1);
    await new Promise((r) => setImmediate(r));
    expect(d.dropped).toBe(0);
  });
});

describe("connect mode derivation", () => {
  it("is OFF when no reconnect_* key is set", () => {
    expect(deriveConnectMode(new SenderOptions("ws::addr=h:9000;"))).toBe(ConnectMode.OFF);
  });

  it("is SYNC when any reconnect_* key is supplied", () => {
    expect(
      deriveConnectMode(new SenderOptions("ws::addr=h:9000;reconnect_max_backoff_millis=1000;")),
    ).toBe(ConnectMode.SYNC);
  });
});
