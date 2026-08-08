import { describe, it, expect, afterEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockQwpServer } from "../mockServer";
import { Sender } from "../../../src";
import { readVarint } from "../../../src/qwp/protocol/varint";
import { TYPE_LONG } from "../../../src/qwp/protocol/constants";

let mocks: MockQwpServer[] = [];
let children: ChildProcess[] = [];
let dir: string | undefined;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

afterEach(async () => {
  for (const c of children) killTree(c);
  children = [];
  for (const m of mocks) await m.stop();
  mocks = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Spawns a tsx child, resolving once it prints FLUSHED. */
async function spawnCrasher(addr: string, sfDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Spawn the executable directly. Killing an `npx tsx ...` wrapper can leave
    // its real tsx child alive and still legitimately holding the slot lock.
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        "test/qwp/sf/crashChild.ts",
        addr,
        sfDir,
      ],
      { cwd: process.cwd(), detached: true },
    );
    children.push(child);
    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += String(d);
      if (buf.includes("FLUSHED")) resolve();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!buf.includes("FLUSHED"))
        reject(new Error(`crasher exited early (code=${code})`));
    });
  });
}

/**
 * Decodes the QWP frames a mock received and returns every value found under a
 * LONG column named "i". The crash child emits a single table with columns
 * ["i", designated timestamp], so the "i" payload is read directly and the
 * trailing (possibly Gorilla) timestamp payload is not parsed.
 */
function collectIntValues(frames: Buffer[]): number[] {
  const out: number[] = [];
  for (const f of frames) {
    if (f.length < 12 || f.subarray(0, 4).toString("ascii") !== "QWP1")
      continue;
    const flags = f.readUInt8(5);
    const tableCount = f.readUInt16LE(6);
    let o = 12;
    if (flags & 0x08) {
      // delta symbol dict: [deltaStart, count, count x string]
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
          break; // only need "i"; column order puts it first in this fixture
        }
      }
    }
  }
  return out;
}

describe("crash recovery", () => {
  it("leaves a slot on disk when the process is killed mid-flight", async () => {
    const mock = new MockQwpServer();
    mocks.push(mock);
    const port = await mock.start({ statusFor: () => 0x09 }); // never OK, nothing trims
    dir = mkdtempSync(join(tmpdir(), "qwp-sf-"));

    await spawnCrasher(`127.0.0.1:${port}`, dir);
    // Kill implicitly via afterEach? No -- kill now, then assert the slot files.
    for (const c of children) killTree(c);
    await new Promise((r) => setTimeout(r, 300));

    const slot = join(dir, "default");
    expect(readdirSync(slot).length).toBeGreaterThan(0);
  }, 120_000);

  it("recovers the orphan slot and replays with no row lost", async () => {
    // At-least-once: every row present, duplicates allowed (spec 5.1).
    const noAck = new MockQwpServer();
    const ack = new MockQwpServer();
    mocks.push(noAck, ack);
    const childPort = await noAck.start({ statusFor: () => 0x09 });
    const ackPort = await ack.start(); // ACKs -> trims the recovered replay
    dir = mkdtempSync(join(tmpdir(), "qwp-sf-"));

    // Produce unacked data on disk, then kill the producer (slot left orphaned).
    await spawnCrasher(`127.0.0.1:${childPort}`, dir);
    for (const c of children) killTree(c);
    await new Promise((r) => setTimeout(r, 300));

    // A fresh sender on the same sf_dir adopts the slot and replays unacked rows.
    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${ackPort};sf_dir=${dir};`,
    );
    await sender.connect();
    await new Promise((r) => setTimeout(r, 1000));

    const values = collectIntValues(ack.frames);
    for (let i = 0; i < 50; i++) expect(values).toContain(i);
    await sender.close();
  }, 120_000);
});
