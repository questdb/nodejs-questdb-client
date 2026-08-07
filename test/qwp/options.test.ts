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
});
