import { describe, it, expect, afterEach } from "vitest";
import { durableAckResponse, MockQwpServer, okResponse } from "./mockServer";
import { QwpTransport } from "../../src/qwp/transport";
import { SenderOptions } from "../../src/options";
import { STATUS } from "../../src/qwp/protocol/response";
import { Category, SenderError } from "../../src/qwp/errors";

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

  it("retains frames until durable table watermarks cover their OK", async () => {
    mock = new MockQwpServer();
    const port = await mock.start({
      durableAck: true,
      responseFor: (_idx, seq) => okResponse(seq, [["trades", 10n]]),
    });
    const t = new QwpTransport(
      new SenderOptions(`ws::addr=127.0.0.1:${port};request_durable_ack=on;`),
    );
    await t.connect();
    await t.sendFrames([Buffer.from("QWP1----------")]);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.ackedFsn).toBe(-1);

    mock.sendResponse(durableAckResponse([["trades", 9n]]));
    await new Promise((r) => setTimeout(r, 25));
    expect(t.ackedFsn).toBe(-1);
    mock.sendResponse(durableAckResponse([["trades", 10n]]));
    await new Promise((r) => setTimeout(r, 25));
    expect(t.ackedFsn).toBe(0);
    await t.close();
  });

  it("latches a terminal NACK and never trims through it", async () => {
    const errors: SenderError[] = [];
    const t = await connected({
      statusFor: (idx: number) => (idx === 0 ? STATUS.PARSE_ERROR : STATUS.OK),
    });
    t.onError((e) => errors.push(e));
    await t
      .sendFrames([
        Buffer.from("QWP1-first----"),
        Buffer.from("QWP1-second---"),
      ])
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(errors[0].category).toBe(Category.PARSE_ERROR);
    expect(t.ackedFsn).toBe(-1);
    await expect(t.sendFrames([Buffer.from("QWP1-third----")])).rejects.toBe(
      errors[0],
    );
    await t.close();
  });

  it("reconnects and replays a retriable NACK", async () => {
    const payload = Buffer.from("QWP1-retry----");
    const t = await connected({
      statusFor: (idx: number) => (idx === 0 ? STATUS.WRITE_ERROR : STATUS.OK),
    });
    await t.sendFrames([payload]).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      mock!.frames.filter((f) => f.equals(payload)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(t.ackedFsn).toBe(0);
    await t.close();
  });

  it("rotates/reconnects and replays a RETRIABLE_OTHER NACK", async () => {
    const payload = Buffer.from("QWP1-other----");
    const t = await connected({
      statusFor: (idx: number) => (idx === 0 ? STATUS.NOT_WRITABLE : STATUS.OK),
    });
    await t.sendFrames([payload]).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      mock!.frames.filter((f) => f.equals(payload)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(t.ackedFsn).toBe(0);
    await t.close();
  });

  it("reports a terminal category on a deterministic NACK", async () => {
    const errors: SenderError[] = [];
    const t = await connected({ statusFor: () => STATUS.PARSE_ERROR });
    t.onError((e) => errors.push(e));
    await t.sendFrames([Buffer.from("QWP1----------")]);
    await new Promise((r) => setTimeout(r, 100));
    expect(errors[0].category).toBe(Category.PARSE_ERROR);
    await t.close();
  });

  it("replays the frame instead of reporting loss when the connection drops", async () => {
    const errors: SenderError[] = [];
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
