import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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
  reclaimFile: "",
  runReclaim: async (): Promise<void> => {},
  renameFrom: "",
  runRename: async (): Promise<void> => {},
  /**
   * Models a filesystem that hands the inode freed by a reclaim straight back
   * to the replacement `mkdir`. ext4 does, which is what CI runs on; APFS does
   * not, which is what this was first written on. Pinning it here proves the
   * outcome is the same either way instead of leaving one of the two to a
   * platform nobody develops on.
   */
  reuseInodes: false,
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
      } else if (
        interleave.reclaimFile &&
        String(file) === interleave.reclaimFile
      ) {
        const run = interleave.runReclaim;
        // Let the successor's reclaim claim pass through while this stale
        // contender remains paused immediately before its own marker write.
        interleave.reclaimFile = "";
        await run();
      }
      return actual.writeFile(file, data, options);
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (interleave.renameFrom && String(from) === interleave.renameFrom) {
        const run = interleave.runRename;
        // One shot: whatever the hook itself renames must pass straight
        // through, and so must this acquisition's later renames.
        interleave.renameFrom = "";
        await run();
      }
      return actual.rename(from, to);
    },
    stat: async (
      target: Parameters<typeof actual.stat>[0],
      options?: Parameters<typeof actual.stat>[1],
    ) => {
      const stats = await actual.stat(target, options);
      if (!interleave.reuseInodes) return stats;
      // Keep every other field, including the mtime the liveness window reads,
      // by inheriting from the real result.
      const pinned = Object.create(stats) as typeof stats;
      Object.defineProperty(pinned, "ino", { value: 1 });
      Object.defineProperty(pinned, "dev", { value: 1 });
      return pinned;
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
  interleave.reclaimFile = "";
  interleave.runReclaim = async () => {};
  interleave.renameFrom = "";
  interleave.runRename = async () => {};
  interleave.reuseInodes = false;
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

it.each([
  ["the replacement is distinguishable", false],
  ["the freed inode is reused", true],
])(
  "refuses an acquisition reclaimed before its record landed, when %s",
  async (_label, reuseInodes) => {
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
    // fenced one of them. The record write is exclusive now, so the resumed
    // call fails on the record the contender already wrote -- which is why the
    // outcome does not depend on the directory identity check, and so not on
    // whether the filesystem reuses the inode.
    interleave.reuseInodes = reuseInodes;
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    const ownerFile = join(ownerPath, "owner");
    let successor: QwpNodeAdvisoryLock | undefined;
    let interleaved = false;

    interleave.ownerFile = ownerFile;
    interleave.run = async () => {
      interleaved = true;
      // Age the bare claim past the liveness window, then let the contender
      // reclaim and establish itself, exactly as it is allowed to.
      const aged = new Date(Date.now() - 60_000);
      await utimes(ownerPath, aged, aged);
      successor = await QwpNodeAdvisoryLock.acquire(directory);
    };

    try {
      await expect(
        QwpNodeAdvisoryLock.acquire(directory),
      ).rejects.toMatchObject({ name: "QwpNodeAdvisoryLockBusyError" });

      // The hook really did run, so the refusal above is the interleaving and
      // not some earlier rejection.
      expect(interleaved).toBe(true);
      expect(successor).toBeDefined();

      // The surviving record is the contender's. This is the invariant that
      // matters and the one that used to break: the loser overwrote this token
      // with its own, which both handed it a lock and fenced the real owner
      // out of its own slot. Comparing the record rather than the directory's
      // inode is what keeps this portable.
      const record = JSON.parse(await readFile(ownerFile, "utf8")) as {
        token?: string;
      };
      const successorToken = (successor as unknown as { token: string }).token;
      expect(record.token).toBe(successorToken);

      // ...and the contender keeps what it took: the loser neither displaced
      // its record nor removed its directory.
      expect(successor!.lost).toBe(false);
      await expect(successor!.ownership()).resolves.toBe("owned");
    } finally {
      await successor?.release().catch(() => undefined);
    }

    // The slot is usable afterwards, so the refusal left no wreckage behind.
    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).resolves.toEqual([]);
    await store.close();
  },
);

it("does not let a stale reclaimer remove a live successor", async () => {
  const directory = await trackedDirectory();
  const ownerPath = join(directory, ".lock.owner");
  const ownerFile = join(ownerPath, "owner");
  await mkdir(ownerPath);
  await writeFile(
    ownerFile,
    JSON.stringify({
      pid: 2_147_483_647,
      host: hostname(),
      token: "dead-owner",
    }),
  );

  let successor: QwpNodeAdvisoryLock | undefined;
  interleave.reclaimFile = join(ownerPath, ".reclaim");
  interleave.runReclaim = async () => {
    successor = await QwpNodeAdvisoryLock.acquire(directory);
  };

  try {
    await expect(QwpNodeAdvisoryLock.acquire(directory)).rejects.toMatchObject({
      name: "QwpNodeAdvisoryLockBusyError",
    });
    expect(successor).toBeDefined();
    await expect(successor!.ownership()).resolves.toBe("owned");
    const record = JSON.parse(await readFile(ownerFile, "utf8")) as {
      token?: string;
    };
    expect(record.token).toBe(
      (successor as unknown as { token: string }).token,
    );
    await expect(
      readFile(join(ownerPath, ".reclaim"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await successor?.release().catch(() => undefined);
  }
});

it("refuses a reclaim a successor has already superseded", async () => {
  // Every step before the rename is an observation, and this process can be
  // descheduled between making one and acting on it. Stall long enough and the
  // claim ages out, so a contender may legitimately remove it and take the
  // slot; resuming into that rename then moved the successor's directory aside
  // and produced two holders of one journal.
  const directory = await trackedDirectory();
  const ownerPath = join(directory, ".lock.owner");
  const ownerFile = join(ownerPath, "owner");
  await mkdir(ownerPath);
  await writeFile(
    ownerFile,
    JSON.stringify({
      pid: 2_147_483_647,
      host: hostname(),
      token: "dead-owner",
    }),
  );

  let successor: QwpNodeAdvisoryLock | undefined;
  let stalled = false;
  interleave.renameFrom = ownerPath;
  interleave.runRename = async () => {
    stalled = true;
    const aged = new Date(Date.now() - 60_000);
    await utimes(join(ownerPath, ".reclaim"), aged, aged);
    successor = await QwpNodeAdvisoryLock.acquire(directory);
  };

  try {
    await expect(QwpNodeAdvisoryLock.acquire(directory)).rejects.toMatchObject({
      name: "QwpNodeAdvisoryLockBusyError",
    });
    expect(stalled).toBe(true);
    expect(successor).toBeDefined();
    // The successor keeps the slot it took, record and directory intact.
    expect(successor!.lost).toBe(false);
    await expect(successor!.ownership()).resolves.toBe("owned");
    const record = JSON.parse(await readFile(ownerFile, "utf8")) as {
      token?: string;
    };
    expect(record.token).toBe(
      (successor as unknown as { token: string }).token,
    );
  } finally {
    await successor?.release().catch(() => undefined);
  }
});

it("recovers a reclaim marker whose contender was killed", async () => {
  const directory = await trackedDirectory();
  const ownerPath = join(directory, ".lock.owner");
  const deadPid = 2_147_483_647;
  await mkdir(ownerPath);
  await writeFile(
    join(ownerPath, "owner"),
    JSON.stringify({ pid: deadPid, host: hostname(), token: "dead-owner" }),
  );
  await writeFile(
    join(ownerPath, ".reclaim"),
    JSON.stringify({ pid: deadPid, host: hostname(), token: "dead-reclaimer" }),
  );

  const lock = await QwpNodeAdvisoryLock.acquire(directory);
  try {
    await expect(lock.ownership()).resolves.toBe("owned");
  } finally {
    await lock.release();
  }
});

it.each([
  ["was created but never filled", ""],
  ["was caught mid-write", '{"pid":123,"host":"'],
  [
    "names a PID the host has since reused",
    JSON.stringify({ pid: process.pid, host: hostname(), token: "reused" }),
  ],
])("recovers a slot whose reclaim marker %s", async (_label, contents) => {
  // writeFile() creates the marker before it fills it, so a contender killed
  // in that window -- or one whose write failed with ENOSPC after the create --
  // leaves bytes that name nobody. They are not a live claim, and nothing else
  // sweeps them: the exclusive create keeps failing, so the slot stayed locked
  // for good, with its journal unreadable, undrainable and unquarantinable.
  const directory = await trackedDirectory();
  const ownerPath = join(directory, ".lock.owner");
  const marker = join(ownerPath, ".reclaim");
  await mkdir(ownerPath);
  await writeFile(
    join(ownerPath, "owner"),
    JSON.stringify({
      pid: 2_147_483_647,
      host: hostname(),
      token: "dead-owner",
    }),
  );
  await writeFile(marker, contents);
  // A claim is held only across the rename that clears a defunct owner, so
  // age is what separates abandoned remains from a contender mid-write.
  const aged = new Date(Date.now() - 60_000);
  await utimes(marker, aged, aged);

  const lock = await QwpNodeAdvisoryLock.acquire(directory);
  try {
    await expect(lock.ownership()).resolves.toBe("owned");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await lock.release();
  }
});

it("leaves a reclaim marker that is still being established", async () => {
  // The same unparseable bytes inside the liveness window belong to a
  // contender that may be about to finish its write, so they keep excluding
  // this acquisition rather than handing one slot to two owners.
  const directory = await trackedDirectory();
  const ownerPath = join(directory, ".lock.owner");
  await mkdir(ownerPath);
  await writeFile(
    join(ownerPath, "owner"),
    JSON.stringify({
      pid: 2_147_483_647,
      host: hostname(),
      token: "dead-owner",
    }),
  );
  await writeFile(join(ownerPath, ".reclaim"), "");

  await expect(QwpNodeAdvisoryLock.acquire(directory)).rejects.toMatchObject({
    name: "QwpNodeAdvisoryLockBusyError",
  });
  await expect(readFile(join(ownerPath, ".reclaim"), "utf8")).resolves.toBe("");
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
