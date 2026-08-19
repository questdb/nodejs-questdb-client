import { describe, it, expect, afterEach } from "vitest";
import { MockQwpServer } from "../mockServer";
import { QwpTransport } from "../../../src/qwp/transport";
import { SenderOptions } from "../../../src/options";

let mock: MockQwpServer | undefined;
afterEach(async () => await mock?.stop());

describe("replay", () => {
  it("resends unacked frames after a reconnect", async () => {
    mock = new MockQwpServer();
    // Drop the connection after the first frame, never ACKing it.
    const port = await mock.start({ dropAfter: 1 });
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await t.connect();
    await t.sendFrames([Buffer.from("QWP1frame-one")]);
    await new Promise((r) => setTimeout(r, 400));
    // The same payload must appear at least twice: original plus replay.
    const matching = mock.frames.filter((f) => f.toString().includes("frame-one"));
    expect(matching.length).toBeGreaterThanOrEqual(2);
    await t.close();
  });

  it("does not replay frames the server already acked", async () => {
    mock = new MockQwpServer();
    const port = await mock.start();
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await t.connect();
    await t.sendFrames([Buffer.from("QWP1acked-frame")]);
    await new Promise((r) => setTimeout(r, 150));
    await t.reconnectForTest();
    await new Promise((r) => setTimeout(r, 150));
    const matching = mock.frames.filter((f) => f.toString().includes("acked-frame"));
    expect(matching.length).toBe(1);
    await t.close();
  });
});
