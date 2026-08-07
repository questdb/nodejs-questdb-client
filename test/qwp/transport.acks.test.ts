import { describe, it, expect, afterEach } from "vitest";
import { MockQwpServer } from "./mockServer";
import { QwpTransport } from "../../src/qwp/transport";
import { SenderOptions } from "../../src/options";
import { STATUS } from "../../src/qwp/protocol/response";
import { Category } from "../../src/qwp/errors";

let mock: MockQwpServer | undefined;
afterEach(async () => await mock?.stop());

async function connected(opts = {}) {
  mock = new MockQwpServer();
  const port = await mock.start(opts);
  const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
  await t.connect();
  return t;
}

describe("QwpTransport ack handling", () => {
  it("advances the acked FSN on OK", async () => {
    const t = await connected();
    await t.sendFrames([Buffer.from("QWP1----------")]);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.ackedFsn).toBe(0);
    await t.close();
  });

  it("reports a terminal category on a deterministic NACK", async () => {
    const errors: any[] = [];
    const t = await connected({ statusFor: () => STATUS.PARSE_ERROR });
    t.onError((e) => errors.push(e));
    await t.sendFrames([Buffer.from("QWP1----------")]);
    await new Promise((r) => setTimeout(r, 100));
    expect(errors[0].category).toBe(Category.PARSE_ERROR);
    await t.close();
  });

  it("replays the frame instead of reporting loss when the connection drops", async () => {
    const errors: any[] = [];
    const t = await connected({ dropAfter: 1 });
    t.onError((e) => errors.push(e));
    const payload = Buffer.from("QWP1----------");
    await t.sendFrames([payload]);
    await new Promise((r) => setTimeout(r, 300));
    // Retention replaces in-flight-loss: no DATA_LOSS, and the frame is replayed.
    expect(errors.some((e) => e.category === Category.DATA_LOSS)).toBe(false);
    const matching = mock!.frames.filter((f) => f.equals(payload));
    expect(matching.length).toBeGreaterThanOrEqual(2);
    await t.close();
  });
});
