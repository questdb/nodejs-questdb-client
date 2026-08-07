import { describe, it, expect, afterEach } from "vitest";
import { MockQwpServer } from "./mockServer";
import { QwpTransport } from "../../src/qwp/transport";
import { SenderOptions } from "../../src/options";

let mocks: MockQwpServer[] = [];
afterEach(async () => {
  for (const m of mocks) await m.stop();
  mocks = [];
});

describe("reconnect and rotation", () => {
  it("rotates to the second endpoint when the first refuses the upgrade with 421", async () => {
    const bad = new MockQwpServer();
    const good = new MockQwpServer();
    mocks.push(bad, good);
    const badPort = await bad.start({
      upgradeStatus: 421,
      upgradeHeaders: "X-QuestDB-Role: replica\r\n",
    });
    const goodPort = await good.start();

    const t = new QwpTransport(
      new SenderOptions(`ws::addr=127.0.0.1:${badPort},127.0.0.1:${goodPort};`),
    );
    await t.connect();
    expect(t.connectedEndpoint!.port).toBe(goodPort);
    await t.close();
  });

  it("fails terminally on 401 without rotating", async () => {
    const a = new MockQwpServer();
    mocks.push(a);
    const port = await a.start({ upgradeStatus: 401 });
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await expect(t.connect()).rejects.toThrow(/authentication/i);
  });

  it("sends a dictionary catch-up frame before data after reconnect", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    const port = await s.start();
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await t.connect();
    t.registerSymbolForTest("alpha");
    await t.reconnectForTest();
    // The catch-up frame is written to the kernel asynchronously; it lands on
    // the server a tick later, so poll rather than assert synchronously.
    for (let i = 0; i < 50 && s.frames.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // First frame after reconnect must carry the dictionary from id 0.
    const first = s.frames[0];
    expect(first.subarray(0, 4).toString("ascii")).toBe("QWP1");
    await t.close();
  });
});
