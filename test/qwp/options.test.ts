import { describe, it, expect } from "vitest";
import { SenderOptions } from "../../src/options";
import { createBuffer } from "../../src/buffer";
import { createTransport } from "../../src/transport";
import { QwpBuffer } from "../../src/qwp/buffer";
import { QwpTransport } from "../../src/qwp/transport";

describe("ws:// wiring", () => {
  it("accepts ws:: and defaults the port to 9000", () => {
    const o = new SenderOptions("ws::addr=localhost;");
    expect(o.protocol).toBe("ws");
    expect(o.port).toBe(9000);
  });

  it("accepts wss:: ", () => {
    expect(new SenderOptions("wss::addr=localhost;").protocol).toBe("wss");
  });

  it("gives a ws:: sender a QwpBuffer, never an ILP buffer", () => {
    const o = new SenderOptions("ws::addr=localhost:9000;");
    expect(createBuffer(o)).toBeInstanceOf(QwpBuffer);
  });

  it("gives a ws:: sender a QwpTransport", () => {
    const o = new SenderOptions("ws::addr=localhost:9000;");
    expect(createTransport(o)).toBeInstanceOf(QwpTransport);
  });

  it("rejects protocol_version for ws:: (spec 9.2)", () => {
    expect(() => new SenderOptions("ws::addr=localhost:9000;protocol_version=2;")).toThrow(
      /not supported for WebSocket/i,
    );
  });

  it("still rejects a genuinely unknown protocol", () => {
    expect(() => new SenderOptions("wsx::addr=localhost;")).toThrow(/invalid protocol/i);
  });

  it("accepts sf_durability=periodic and sf_sync_interval_millis together (spec 9.2)", () => {
    const o = new SenderOptions(
      "ws::addr=localhost:9000;sf_dir=/tmp/x;sf_durability=periodic;sf_sync_interval_millis=2000;",
    );
    expect(o.sf_durability).toBe("periodic");
    expect(o.sf_sync_interval_millis).toBe(2000);
  });

  it("sf_sync_interval_millis requires sf_durability=periodic (spec 9.2)", () => {
    expect(() =>
      new SenderOptions("ws::addr=localhost:9000;sf_dir=/tmp/x;sf_sync_interval_millis=2000;"),
    ).toThrow(/sf_sync_interval_millis requires sf_durability=periodic/i);
  });

  it("sf_durability=periodic requires sf_dir (spec 9.2)", () => {
    expect(() =>
      new SenderOptions("ws::addr=localhost:9000;sf_durability=periodic;"),
    ).toThrow(/requires sf_dir/i);
  });

  it("drain_orphans requires sf_dir (spec 9.2)", () => {
    expect(() => new SenderOptions("ws::addr=localhost:9000;drain_orphans=on;")).toThrow(
      /requires sf_dir|not yet implemented/i,
    );
  });
});
