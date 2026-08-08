import { afterEach, describe, expect, it } from "vitest";
import { Sender } from "../../src";
import { readVarint } from "../../src/qwp/protocol/varint";
import { MockQwpServer } from "./mockServer";

let mock: MockQwpServer | undefined;
afterEach(async () => mock?.stop());

function deltaHeader(frame: Buffer): { start: number; count: number } {
  const start = readVarint(frame, 12);
  const count = readVarint(frame, start.offset);
  return { start: start.value, count: count.value };
}

describe("QWP Sender concurrent flush", () => {
  it("seals and publishes dictionary deltas in flush order", async () => {
    mock = new MockQwpServer();
    const port = await mock.start();
    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${port};auto_flush_interval=60000;`,
    );
    await sender.connect();

    await sender.table("t").symbol("s", "alpha").at(1n, "us");
    const first = sender.flush();
    await sender.table("t").symbol("s", "beta").at(2n, "us");
    const second = sender.flush();
    const closing = sender.close();
    await Promise.all([first, second, closing]);
    const deadline = Date.now() + 1000;
    while (mock.frames.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(mock.frames).toHaveLength(2);
    expect(deltaHeader(mock.frames[0])).toEqual({ start: 0, count: 1 });
    expect(deltaHeader(mock.frames[1])).toEqual({ start: 1, count: 1 });
  });
});
