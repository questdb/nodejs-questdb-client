import { describe, it, expect } from "vitest";
import { QwpTransport } from "../../src/qwp/transport";
import { SenderOptions } from "../../src/options";

describe("QwpTransport", () => {
  it("uses the QWP auto-flush row default, not the ILP one", () => {
    const t = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    expect(t.getDefaultAutoFlushRows()).toBe(1000);
  });

  it("refuses to send before connect", async () => {
    const t = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    await expect(t.send(Buffer.from([1]))).rejects.toThrow(/not connected/i);
  });
});
