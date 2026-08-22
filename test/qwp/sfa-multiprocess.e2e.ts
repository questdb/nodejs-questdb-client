import { fork, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The store-and-forward exclusion, reclaim and release contract, exercised
 * with real OS processes against the built package.
 *
 * Everything here is cross-process by nature and cannot be reached from a
 * single-process suite. Two stores in one process share a module-global
 * pending-release list, one event loop, and every advisory-lock object, so
 * in-process tests can only observe the mechanisms in isolation -- never the
 * contract itself. The in-process lock tests in reconnect.test.ts also always
 * run against a fresh `mkdtemp` parent, which has no `.slot-locks/` directory
 * and no `.lock.pid` left by an earlier producer, so the state a contender
 * actually meets in production is structurally unreachable there.
 *
 * Requires a build. Run with `pnpm test:dist`.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DIST = path.join(ROOT, "dist");
const CHILD = path.join(ROOT, "test/qwp/sfa-multiprocess-child.mjs");

// One heartbeat interval plus slack: how long a holder needs before it can
// notice that its lock was taken. Both live in src/qwp-node/advisory-lock.ts.
const HEARTBEAT_INTERVAL_MS = 5_000;
const BEAT_SETTLE_MS = HEARTBEAT_INTERVAL_MS + 1_500;
const STALE_AFTER_MS = 15_000;

interface Reply {
  ok: boolean;
  recovered?: number;
  error?: { name: string; message: string; causeName?: string };
}

/** A forked producer, driven one request at a time. */
class Producer {
  private nextId = 0;
  private constructor(private readonly child: ChildProcess) {}

  static async start(directory: string): Promise<Producer> {
    const child = fork(CHILD, [DIST, directory], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("exit", (code) =>
        reject(new Error(`child exited early with ${code}`)),
      );
    });
    return new Producer(child);
  }

  send(command: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`child timed out on ${command}`)),
        30_000,
      );
      const onMessage = (message: Reply & { id: number }) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        this.child.off("message", onMessage);
        resolve(message);
      };
      this.child.on("message", onMessage);
      this.child.send({ id, command, args });
    });
  }

  /** SIGKILL, the way a crashed producer leaves a slot behind. */
  kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    return new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.kill(signal);
    });
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }
}

const running: Producer[] = [];
const track = async (directory: string): Promise<Producer> => {
  const producer = await Producer.start(directory);
  running.push(producer);
  return producer;
};

afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => (p.alive ? p.kill() : null)));
});

async function slot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "qwp-sfa-mp-"));
  const directory = path.join(root, "slot");
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * Leaves the slot in the shape a real one is in: opened and closed by an
 * earlier producer that has since exited, so `.lock` and `.lock.pid` persist
 * and the PID they name is dead. This is exactly the precondition an
 * `mkdtemp` parent cannot have.
 */
async function withPriorProducer(directory: string): Promise<void> {
  const seed = await Producer.start(directory);
  expect((await seed.send("open")).ok).toBe(true);
  expect((await seed.send("close")).ok).toBe(true);
  await seed.kill("SIGTERM");
  expect((await readdir(directory)).sort()).toEqual(
    expect.arrayContaining([".lock", ".lock.pid"]),
  );
}

/**
 * Backdates the owner directory so it looks like a holder whose heartbeat
 * lapsed, without spending the staleness window in real time. This is the
 * on-disk state a paused process, a suspended VM or a stalled filesystem
 * produces; the holder is still very much alive.
 */
async function simulateLapsedHeartbeat(directory: string): Promise<void> {
  const owner = path.join(directory, ".lock.owner");
  const when = new Date(Date.now() - STALE_AFTER_MS - 5_000);
  await utimes(owner, when, when);
}

async function markerCounts(
  directory: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".sfa")) continue;
    for (const byte of await readFile(path.join(directory, file))) {
      if (byte < 0x41 || byte > 0x5a) continue;
      const marker = String.fromCharCode(byte);
      counts[marker] = (counts[marker] ?? 0) + 1;
    }
  }
  return counts;
}

describe("QWP store-and-forward across processes", () => {
  it("hands one slot to exactly one of several contending processes", async () => {
    // A contract test, not a regression test: this passes against the code
    // before the acquisition-token fix too. It is here because nothing
    // previously asserted the exclusion contract across processes at all, and
    // because it is the only place the used-parent precondition exists -- the
    // in-process tests always start from an empty `mkdtemp` directory.
    const directory = await slot();
    await withPriorProducer(directory);

    const contenders = await Promise.all([
      track(directory),
      track(directory),
      track(directory),
      track(directory),
    ]);
    const replies = await Promise.all(contenders.map((p) => p.send("open")));

    const winners = replies.filter((reply) => reply.ok);
    expect(winners).toHaveLength(1);
    for (const loser of replies.filter((reply) => !reply.ok)) {
      // The designed error, not whatever an incidental filesystem race
      // produced on the way there.
      expect(loser.error?.name).toBe("QwpReplayStoreLockedError");
    }
  }, 60_000);

  it("refuses a contender while the holder keeps heartbeating", async () => {
    // Also a contract test: it guards the other direction of the reclaim rule,
    // that a holder still refreshing its mtime is never aged out.
    const directory = await slot();
    const holder = await track(directory);
    expect((await holder.send("open")).ok).toBe(true);
    expect((await holder.send("append", { sequence: 0, marker: "A" })).ok).toBe(
      true,
    );

    // Long enough for several heartbeats: a live holder must never age out.
    await new Promise((resolve) => setTimeout(resolve, BEAT_SETTLE_MS));

    const contender = await track(directory);
    const refused = await contender.send("open");
    expect(refused.ok).toBe(false);
    expect(refused.error?.name).toBe("QwpReplayStoreLockedError");
  }, 60_000);

  it("adopts a crashed producer's slot and recovers its frames", async () => {
    // Contract test: crash recovery worked before the lock changes, and has to
    // keep working now that a record-less directory no longer expires on the
    // dead PID in the sidecar.
    const directory = await slot();
    const crashing = await track(directory);
    expect((await crashing.send("open")).ok).toBe(true);
    for (let sequence = 0; sequence < 5; sequence++) {
      expect(
        (await crashing.send("append", { sequence, marker: "A" })).ok,
      ).toBe(true);
    }
    await crashing.kill();

    // No staleness wait: the owner record names a dead PID on this host, which
    // is the crash fast path.
    const successor = await track(directory);
    const opened = await successor.send("open");
    expect(opened.ok).toBe(true);
    expect(opened.recovered).toBe(5);
  }, 60_000);

  it("stops a reclaimed holder from overwriting the new owner's frames", async () => {
    const directory = await slot();
    const stalled = await track(directory);
    expect((await stalled.send("open")).ok).toBe(true);
    for (let sequence = 0; sequence < 5; sequence++) {
      expect((await stalled.send("append", { sequence, marker: "A" })).ok).toBe(
        true,
      );
    }

    await simulateLapsedHeartbeat(directory);
    const successor = await track(directory);
    expect((await successor.send("open")).ok).toBe(true);
    for (let sequence = 5; sequence < 10; sequence++) {
      expect(
        (await successor.send("append", { sequence, marker: "B" })).ok,
      ).toBe(true);
    }

    // The stalled holder needs one heartbeat to see that its directory moved.
    await new Promise((resolve) => setTimeout(resolve, BEAT_SETTLE_MS));

    const rejected = await stalled.send("append", {
      sequence: 5,
      marker: "A",
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.name).toBe("QwpReplayStoreLockLostError");

    // The decisive assertion: the successor's durable bytes are still there.
    // A frame's sequence comes from its position, so a same-width overwrite
    // would leave a journal that reopens as complete with these bytes gone.
    const counts = await markerCounts(directory);
    expect(counts.B).toBe(5 * 64);
    expect(counts.A).toBe(5 * 64);
  }, 60_000);

  it("does not let a stalled holder's release strip a live lock", async () => {
    const directory = await slot();
    const other = path.join(path.dirname(directory), "other-slot");
    await mkdir(other, { recursive: true });

    const stalled = await track(directory);
    expect((await stalled.send("open")).ok).toBe(true);

    // Reclaim the slot out from under it, then hand it back, so the stalled
    // holder's own release finds a directory that is no longer its own.
    await simulateLapsedHeartbeat(directory);
    const interloper = await track(directory);
    expect((await interloper.send("open")).ok).toBe(true);
    expect((await interloper.send("close")).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, BEAT_SETTLE_MS));
    await stalled.send("close");

    const owner = await track(directory);
    expect((await owner.send("open")).ok).toBe(true);
    const ownerInode = (await stat(path.join(directory, ".lock.owner"))).ino;

    // Acquiring any other lock drains this process's pending-release list.
    expect(
      (await stalled.send("openOther", { otherDirectory: other })).ok,
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect((await stat(path.join(directory, ".lock.owner"))).ino).toBe(
      ownerInode,
    );
    const gatecrasher = await track(directory);
    const refused = await gatecrasher.send("open");
    expect(refused.ok).toBe(false);
    expect(refused.error?.name).toBe("QwpReplayStoreLockedError");
  }, 60_000);
});
