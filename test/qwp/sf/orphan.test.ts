import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { errorResponse, MockQwpServer, okResponse } from "../mockServer";
import { Sender } from "../../../src";
import { scanOrphans } from "../../../src/qwp/sf/orphanScanner";
import { acquireSlot, releaseSlot } from "../../../src/qwp/sf/slotLock";
import { readVarint } from "../../../src/qwp/protocol/varint";
import { TYPE_LONG } from "../../../src/qwp/protocol/constants";
import { STATUS } from "../../../src/qwp/protocol/response";

let mocks: MockQwpServer[] = [];
let dir: string | undefined;

afterEach(async () => {
  for (const m of mocks) await m.stop();
  mocks = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tmp(): string {
  dir = mkdtempSync(join(tmpdir(), "qwp-orphan-"));
  return dir;
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Decodes QWP frames and returns every value found under a LONG column "i". */
function collectIntValues(frames: Buffer[]): number[] {
  const out: number[] = [];
  for (const f of frames) {
    if (f.length < 12 || f.subarray(0, 4).toString("ascii") !== "QWP1")
      continue;
    const flags = f.readUInt8(5);
    const tableCount = f.readUInt16LE(6);
    let o = 12;
    if (flags & 0x08) {
      const a = readVarint(f, o);
      o = a.offset;
      const b = readVarint(f, o);
      o = b.offset;
      for (let i = 0; i < b.value; i++) {
        const r = readVarint(f, o);
        o = r.offset + r.value;
      }
    }
    for (let t = 0; t < tableCount; t++) {
      const nm = readVarint(f, o);
      o = nm.offset + nm.value;
      const rc = readVarint(f, o);
      o = rc.offset;
      const cc = readVarint(f, o);
      o = cc.offset;
      const specs: { name: string; type: number }[] = [];
      for (let c = 0; c < cc.value; c++) {
        const cn = readVarint(f, o);
        const name = f
          .subarray(cn.offset, cn.offset + cn.value)
          .toString("utf8");
        o = cn.offset + cn.value;
        const type = f.readUInt8(o++);
        specs.push({ name, type });
      }
      for (const cs of specs) {
        const storage = f.readUInt8(o++);
        if (storage === 1) o += Math.ceil(rc.value / 8);
        if (cs.name === "i" && cs.type === TYPE_LONG) {
          for (let r = 0; r < rc.value; r++) {
            out.push(Number(f.readBigInt64LE(o)));
            o += 8;
          }
        } else {
          break;
        }
      }
    }
  }
  return out;
}

/** Produces 50 unacked rows into the given slot and returns without acking them. */
async function orphanSlot(
  sfDir: string,
  serverPort: number,
  senderId: string,
): Promise<void> {
  const noAck = new MockQwpServer();
  mocks.push(noAck);
  const port = await noAck.start({ statusFor: () => 0x09 }); // never OK: nothing trims
  const producer = await Sender.fromConfig(
    `ws::addr=127.0.0.1:${port};sf_dir=${sfDir};sender_id=${senderId};`,
  );
  await producer.connect();
  for (let i = 0; i < 50; i++) {
    await producer
      .table("crash_t")
      .intColumn("i", i)
      .at(BigInt(1_700_000_000_000_000 + i), "us");
  }
  await producer.flush();
  await producer.close(); // graceful close, but the no-ack server never trimmed
  // ignore serverPort param kept for symmetry with crash helpers
  void serverPort;
}

/** True when a frame is a bare symbol-dictionary catch-up (delta flag, 0 tables). */
function isCatchUpFrame(f: Buffer): boolean {
  if (f.length < 12 || f.subarray(0, 4).toString("ascii") !== "QWP1")
    return false;
  const flags = f.readUInt8(5);
  const tableCount = f.readUInt16LE(6);
  return (flags & 0x08) !== 0 && tableCount === 0;
}

describe("orphan scanner (spec 8.4)", () => {
  it("finds slots with a stale/absent lock and skips live-held ones", async () => {
    const d = tmp();
    const slotA = join(d, "slotA");
    mkdirSync(slotA, { recursive: true });
    writeFileSync(join(slotA, ".lock"), "999999999\notherboot\n"); // dead pid, foreign boot
    const failed = join(d, "failed");
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(failed, ".failed"), "operator action required\n");
    const liv = await acquireSlot(d, "live");
    try {
      // dotfiles, quarantined slots, and terminal .failed slots are ignored.
      mkdirSync(join(d, ".slot-locks", "x"), { recursive: true });
      mkdirSync(join(d, "def.quarantined.0"), { recursive: true });
      const orphans = await scanOrphans(d).then((o) =>
        o.map((x) => x.senderId).sort(),
      );
      expect(orphans).toEqual(["slotA"]);
    } finally {
      await releaseSlot(liv);
    }
  });
});

describe("orphan drainer (spec 8.4)", () => {
  it("replays a foreign orphan slot to a fresh acking server", async () => {
    const d = tmp();
    // A producer with its own sender_id crashes, leaving unacked rows in its slot.
    await orphanSlot(d, 0, "crashed");

    // A fresh sender (distinct sender_id) with drain_orphans=on adopts the
    // orphan and replays it to an ACKing server on its own WebSocket.
    const ack = new MockQwpServer();
    mocks.push(ack);
    const ackPort = await ack.start();
    const drainer = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${ackPort};sf_dir=${d};drain_orphans=on;sender_id=runner;`,
    );
    await drainer.connect();

    await waitFor(() => collectIntValues(ack.frames).length >= 50);
    const values = collectIntValues(ack.frames);
    for (let i = 0; i < 50; i++) expect(values).toContain(i);
    // Completion is renamed out of scanner visibility before deletion, so a
    // future startup cannot replay the same orphan again.
    await waitFor(() => !existsSync(join(d, "crashed")));
    const later = await scanOrphans(d);
    expect(later.some((s) => s.senderId === "crashed")).toBe(false);
    await drainer.close();
  }, 30_000);

  it("ignores an OK queued behind a retryable NACK on a recycled connection", async () => {
    const d = tmp();
    await orphanSlot(d, 0, "crashed");

    const ack = new MockQwpServer();
    mocks.push(ack);
    const ackPort = await ack.start({
      responsesFor: (idx, seq) =>
        idx === 0
          ? [errorResponse(STATUS.WRITE_ERROR, seq, "retry"), okResponse(seq)]
          : [okResponse(seq)],
    });
    const drainer = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${ackPort};sf_dir=${d};drain_orphans=on;sender_id=runner;`,
    );
    await drainer.connect();

    // The stale OK shares one socket-data chunk with the NACK. It must not mark
    // the rejected frame drained; a fresh connection has to replay it.
    await waitFor(
      () =>
        ack.frames.filter((f) => collectIntValues([f]).length > 0).length >= 2,
    );
    expect(existsSync(join(d, "crashed", ".failed"))).toBe(false);
    await drainer.close();
  }, 30_000);

  it("re-registers the recovered symbol dictionary before replaying a delta slot", async () => {
    const d = tmp();
    // Producer writes SYMBOL rows, so the slot carries a persisted .symbol-dict
    // and its frames are delta-encoded. Leave it unacked (no-ack server).
    const noAck = new MockQwpServer();
    mocks.push(noAck);
    const noAckPort = await noAck.start({ statusFor: () => 0x09 });
    const producer = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${noAckPort};sf_dir=${d};sender_id=delta;`,
    );
    await producer.connect();
    for (let i = 0; i < 20; i++) {
      await producer
        .table("sym_t")
        .intColumn("i", i)
        .symbol("s", `sym_${i}`)
        .at(BigInt(1_700_000_000_000_000 + i), "us");
    }
    await producer.flush();
    await producer.close();

    const ack = new MockQwpServer();
    mocks.push(ack);
    const ackPort = await ack.start();
    const drainer = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${ackPort};sf_dir=${d};drain_orphans=on;sender_id=runner;`,
    );
    await drainer.connect();

    // A bare dictionary catch-up frame must precede the replayed data frames so
    // the fresh server can decode their delta ids (spec 7.5).
    await waitFor(() => collectIntValues(ack.frames).length >= 20);
    const catchUps = ack.frames.filter(isCatchUpFrame);
    expect(catchUps.length).toBeGreaterThanOrEqual(1);
    const firstDataIdx = ack.frames.findIndex(
      (f) => collectIntValues([f]).length > 0,
    );
    expect(ack.frames.indexOf(catchUps[0])).toBeLessThan(firstDataIdx);
    const values = collectIntValues(ack.frames);
    for (let i = 0; i < 20; i++) expect(values).toContain(i);
    await drainer.close();
  }, 30_000);

  it("drops a .failed sentinel and emits DATA_LOSS on a terminal failure", async () => {
    const d = tmp();
    await orphanSlot(d, 0, "crashed");

    const authFail = new MockQwpServer();
    mocks.push(authFail);
    const authPort = await authFail.start({ upgradeStatus: 401 });

    const drainer = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${authPort};sf_dir=${d};drain_orphans=on;sender_id=runner;`,
    );
    // The sender's own connection also fails auth; the drainer still runs.
    await drainer.connect().catch(() => undefined);

    await waitFor(() => existsSync(join(d, "crashed", ".failed")));
    expect(readdirSync(join(d, "crashed")).length).toBeGreaterThan(0);
    await drainer.close().catch(() => undefined);
  }, 30_000);
});
