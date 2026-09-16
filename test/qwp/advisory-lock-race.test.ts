import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Holds one acquisition open inside its owner-record write. That write is the
// step which turns a bare `.lock.owner` claim into a slot that names an owner,
// and it is the only point at which the interleaving below can be forced from
// a single process: `node:fs/promises` is frozen, so the module has to be
// replaced rather than spied on, and it is replaced in this file alone.
const interleave = vi.hoisted(() => ({
  ownerFile: "",
  run: async (): Promise<void> => {},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (
      file: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options: Parameters<typeof actual.writeFile>[2],
    ) => {
      if (interleave.ownerFile && String(file) === interleave.ownerFile) {
        const run = interleave.run;
        // One shot: the contender's own record write must pass straight
        // through, and so must this acquisition's retry of anything later.
        interleave.ownerFile = "";
        await run();
      }
      return actual.writeFile(file, data, options);
    },
  };
});

// vi.mock() is hoisted above these, so both see the replaced module.
import { QwpNodeAdvisoryLock } from "../../packages/nodejs-client/src/qwp-node/advisory-lock";
import { QwpNodeFileReplayStore } from "../../packages/nodejs-client/src";

const directories: string[] = [];

afterEach(async () => {
  interleave.ownerFile = "";
  interleave.run = async () => {};
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

async function trackedDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qwp-lock-race-"));
  directories.push(directory);
  return directory;
}

it("refuses an acquisition whose claim was reclaimed before its record landed", async () => {
  // The window every acquisition passes through, held open. Between the mkdir
  // that claims the mutex and the write that names its owner, the directory
  // names nobody -- and reclaimIfDefunct() is entitled to take an aged one,
  // because that state is also what a process killed mid-acquisition leaves
  // behind. So a contender may legitimately rename this directory aside and
  // create its own at the same pathname.
  //
  // The resumed call then wrote its record straight through the replacement,
  // overwrote the live holder's token, and returned a lock of its own: two
  // acquisitions of one slot, both reporting ownership until a heartbeat
  // fenced one of them. The record write is exclusive now, and the acquisition
  // proves its directory was not replaced before reporting a lock.
  const directory = await trackedDirectory();
  const ownerPath = join(directory, ".lock.owner");
  let successor: QwpNodeAdvisoryLock | undefined;
  let claimedInode: number | undefined;

  interleave.ownerFile = join(ownerPath, "owner");
  interleave.run = async () => {
    claimedInode = (await stat(ownerPath)).ino;
    // Age the bare claim past the liveness window, then let the contender
    // reclaim and establish itself, exactly as it is allowed to.
    const aged = new Date(Date.now() - 60_000);
    await utimes(ownerPath, aged, aged);
    successor = await QwpNodeAdvisoryLock.acquire(directory);
  };

  try {
    await expect(QwpNodeAdvisoryLock.acquire(directory)).rejects.toMatchObject({
      name: "QwpNodeAdvisoryLockBusyError",
    });

    expect(successor).toBeDefined();
    // The contender really did replace the pathname rather than reuse it, so
    // the refusal above rests on the identity the acquisition claimed.
    expect((await stat(ownerPath)).ino).not.toBe(claimedInode);
    // ...and it keeps the slot it took: the loser neither displaced its record
    // nor removed its directory.
    expect(successor!.lost).toBe(false);
    await expect(successor!.ownership()).resolves.toBe("owned");
  } finally {
    await successor?.release().catch(() => undefined);
  }

  // The slot is usable afterwards, so the refusal left no wreckage behind.
  const store = new QwpNodeFileReplayStore({ directory });
  await expect(store.load()).resolves.toEqual([]);
  await store.close();
});

it("keeps a normal acquisition working through the same write path", async () => {
  // Guards the mock itself: with no interleaving armed, acquisition is the
  // ordinary one, so a failure above cannot be an artefact of replacing the
  // filesystem module.
  const directory = await trackedDirectory();
  const lock = await QwpNodeAdvisoryLock.acquire(directory);
  try {
    expect(lock.lost).toBe(false);
    await expect(lock.ownership()).resolves.toBe("owned");
    await expect(QwpNodeAdvisoryLock.acquire(directory)).rejects.toMatchObject({
      name: "QwpNodeAdvisoryLockBusyError",
    });
  } finally {
    await lock.release();
  }
  const reacquired = await QwpNodeAdvisoryLock.acquire(directory);
  await reacquired.release();
});
