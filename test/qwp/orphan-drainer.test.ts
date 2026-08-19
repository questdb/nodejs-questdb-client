import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QWP_ORPHAN_DRAIN_EVENT_KIND,
  QWP_ORPHAN_FAILED_SENTINEL,
  QwpNodeOrphanDrainer,
  QwpReplayStoreLockedError,
  retryQwpNodeOrphanSlot,
  scanQwpNodeOrphanSlots,
  type QwpNodeOrphanDrainSession,
} from "../../src/qwp/node";
import {
  QWP_RECONNECT_EVENT_KIND,
  QWP_SENDER_ERROR_CATEGORY,
  QWP_SENDER_ERROR_POLICY,
  type QwpSenderError,
} from "../../src/qwp";

class FakeDrainSession implements QwpNodeOrphanDrainSession {
  pendingReplayFrames = 1;
  readonly closed: Promise<{
    code: number;
    reason: string;
    wasClean: boolean;
  }>;
  private resolveClosed!: (info: {
    code: number;
    reason: string;
    wasClean: boolean;
  }) => void;
  lastError?: Error;
  closes = 0;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get metrics() {
    return {
      pendingReplayFrames: this.pendingReplayFrames,
      pendingReplayBytes: this.pendingReplayFrames,
      lastError: this.lastError,
    };
  }

  pollDurableAck(): Promise<void> {
    this.pendingReplayFrames = 0;
    return Promise.resolve();
  }

  close(code = 1000, reason = ""): Promise<void> {
    if (this.closes++ === 0) {
      this.resolveClosed({ code, reason, wasClean: code === 1000 });
    }
    return Promise.resolve();
  }

  fail(error: Error): void {
    this.lastError = error;
    this.resolveClosed({ code: 1011, reason: error.message, wasClean: false });
  }
}

function assignedSfaSegment(): Buffer {
  const bytes = Buffer.alloc(24 + 8);
  bytes.write("SF01", 0, "ascii");
  bytes.writeUInt8(1, 4);
  // A non-zero envelope probe is enough for the read-only orphan scanner;
  // adoption performs full CRC and manifest validation under the slot lock.
  bytes.writeUInt8(1, 24);
  return bytes;
}

describe("QWP Node orphan drainer", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function root(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "qwp-orphans-"));
    roots.push(directory);
    return directory;
  }

  async function recordSlot(
    rootDirectory: string,
    name: string,
  ): Promise<string> {
    const directory = join(rootDirectory, name);
    await mkdir(directory);
    await writeFile(
      join(directory, "sf-0000000000000000.sfa"),
      assignedSfaSegment(),
    );
    return directory;
  }

  it("finds record-bearing child slots while excluding live and failed slots", async () => {
    const rootDirectory = await root();
    const orphan = await recordSlot(rootDirectory, "orphan");
    const segmented = join(rootDirectory, "segmented");
    await mkdir(segmented);
    await writeFile(
      join(segmented, "sf-0000000000000000.sfa"),
      assignedSfaSegment(),
    );
    await recordSlot(rootDirectory, "live");
    const failed = await recordSlot(rootDirectory, "failed");
    await writeFile(join(failed, QWP_ORPHAN_FAILED_SENTINEL), "inspect me");
    await recordSlot(rootDirectory, "sender-0.unreplayable-0");
    await mkdir(join(rootDirectory, "empty"));

    await expect(
      scanQwpNodeOrphanSlots(rootDirectory, (name) => name === "live"),
    ).resolves.toEqual([orphan, segmented]);
    await expect(
      scanQwpNodeOrphanSlots(join(rootDirectory, "missing")),
    ).resolves.toEqual([]);
  });

  it("adopts and drains discovered slots with bounded background workers", async () => {
    const rootDirectory = await root();
    const first = await recordSlot(rootDirectory, "first");
    const second = await recordSlot(rootDirectory, "second");
    const sessions = new Map<string, FakeDrainSession>();
    const events: string[] = [];
    let activeCreations = 0;
    let maximumCreations = 0;
    const drainer = new QwpNodeOrphanDrainer({
      rootDirectory,
      maxConcurrent: 1,
      scanIntervalMs: 0,
      durableAckPollIntervalMs: 1,
      createSession: async (directory) => {
        activeCreations++;
        maximumCreations = Math.max(maximumCreations, activeCreations);
        const session = new FakeDrainSession();
        sessions.set(directory, session);
        const close = session.close.bind(session);
        session.close = async (code, reason) => {
          await close(code, reason);
          activeCreations--;
        };
        return session;
      },
      onEvent: (event) => events.push(`${event.kind}:${event.directory}`),
    });

    drainer.start();
    await vi.waitFor(() => expect(drainer.metrics.drained).toBe(2));
    expect(new Set(sessions.keys())).toEqual(new Set([first, second]));
    expect(maximumCreations).toBe(1);
    expect(events).toContain(`${QWP_ORPHAN_DRAIN_EVENT_KIND.DRAINED}:${first}`);
    expect(events).toContain(
      `${QWP_ORPHAN_DRAIN_EVENT_KIND.DRAINED}:${second}`,
    );
    await drainer.close();
    expect(drainer.metrics).toMatchObject({ active: 0, closed: true });
  });

  it("discovers a slot orphaned after the startup scan", async () => {
    const rootDirectory = await root();
    const drainer = new QwpNodeOrphanDrainer({
      rootDirectory,
      scanIntervalMs: 10,
      durableAckPollIntervalMs: 1,
      createSession: async (directory) => {
        const session = new FakeDrainSession();
        session.pollDurableAck = async () => {
          session.pendingReplayFrames = 0;
          await rm(join(directory, "sf-0000000000000000.sfa"));
        };
        return session;
      },
    });
    drainer.start();
    await vi.waitFor(() => expect(drainer.metrics.scans).toBeGreaterThan(0));

    await recordSlot(rootDirectory, "late-producer");
    await vi.waitFor(() => expect(drainer.metrics.drained).toBe(1));
    expect(drainer.metrics.scans).toBeGreaterThan(1);
    await drainer.close();
  });

  it("forwards durable-ACK and primary-unavailable reconnect events", async () => {
    const rootDirectory = await root();
    const directory = await recordSlot(rootDirectory, "rolling-upgrade");
    const events: Array<{
      kind: string;
      directory?: string;
      attempt?: number;
      episodeMs?: number;
    }> = [];
    const drainer = new QwpNodeOrphanDrainer({
      rootDirectory,
      scanIntervalMs: 0,
      durableAckPollIntervalMs: 1,
      createSession: async (_directory, onReconnectEvent) => {
        onReconnectEvent?.({
          kind: QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
          attempt: 3,
          timestampMs: Date.now(),
          episodeMs: 25,
        });
        onReconnectEvent?.({
          kind: QWP_RECONNECT_EVENT_KIND.PRIMARY_UNAVAILABLE,
          attempt: 2,
          timestampMs: Date.now(),
        });
        onReconnectEvent?.({
          kind: QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
          attempt: 16,
          timestampMs: Date.now(),
          episodeMs: 300_000,
          cause: new Error("durable ACK remained unavailable"),
        });
        return new FakeDrainSession();
      },
      onEvent: (event) => events.push(event),
    });

    drainer.start();
    await vi.waitFor(() => expect(drainer.metrics.drained).toBe(1));
    await vi.waitFor(() =>
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: QWP_ORPHAN_DRAIN_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
            directory,
            attempt: 3,
            episodeMs: 25,
          }),
          expect.objectContaining({
            kind: QWP_ORPHAN_DRAIN_EVENT_KIND.PRIMARY_UNAVAILABLE,
            directory,
            attempt: 2,
          }),
          expect.objectContaining({
            kind: QWP_ORPHAN_DRAIN_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
            directory,
            attempt: 16,
            episodeMs: 300_000,
            error: expect.objectContaining({
              message: "durable ACK remained unavailable",
            }),
          }),
        ]),
      ),
    );
    await drainer.close();
  });

  it("skips live locked slots without quarantining them", async () => {
    const rootDirectory = await root();
    const directory = await recordSlot(rootDirectory, "live");
    const drainer = new QwpNodeOrphanDrainer({
      rootDirectory,
      scanIntervalMs: 0,
      createSession: async () => {
        throw new QwpReplayStoreLockedError(directory, process.pid);
      },
    });
    drainer.start();
    await vi.waitFor(() => expect(drainer.metrics.locked).toBe(1));
    expect(await readdir(directory)).not.toContain(QWP_ORPHAN_FAILED_SENTINEL);
    await drainer.close();
  });

  it("quarantines terminal failures until an operator explicitly retries", async () => {
    const rootDirectory = await root();
    const directory = await recordSlot(rootDirectory, "corrupt");
    const terminal = new Error("corrupt replay record");
    const senderErrors: QwpSenderError[] = [];
    const events: string[] = [];
    const drainer = new QwpNodeOrphanDrainer({
      rootDirectory,
      scanIntervalMs: 0,
      createSession: async () => {
        throw terminal;
      },
      onEvent: (event) => {
        if (event.senderError) events.push(event.senderError.category);
      },
      onSenderError: (error) => senderErrors.push(error),
    });
    drainer.start();
    await vi.waitFor(() => expect(drainer.metrics.failed).toBe(1));
    expect(await readdir(directory)).toContain(QWP_ORPHAN_FAILED_SENTINEL);
    await vi.waitFor(() => expect(senderErrors).toHaveLength(1));
    await vi.waitFor(() => expect(events).toEqual(["data-loss"]));
    expect(senderErrors[0]).toMatchObject({
      category: QWP_SENDER_ERROR_CATEGORY.DATA_LOSS,
      appliedPolicy: QWP_SENDER_ERROR_POLICY.ABANDONED,
      quarantinedPath: directory,
      serverMessage: terminal.message,
    });
    expect(drainer.metrics).toMatchObject({
      deliveredNotifications: expect.any(Number),
      droppedNotifications: 0,
      deliveredErrorNotifications: 1,
      droppedErrorNotifications: 0,
    });
    await expect(scanQwpNodeOrphanSlots(rootDirectory)).resolves.toEqual([]);

    await retryQwpNodeOrphanSlot(directory);
    await expect(scanQwpNodeOrphanSlots(rootDirectory)).resolves.toEqual([
      directory,
    ]);
    await drainer.close();
  });

  it("stops active sessions when the owning client closes", async () => {
    const rootDirectory = await root();
    await recordSlot(rootDirectory, "offline");
    const session = new FakeDrainSession();
    session.pollDurableAck = () => Promise.resolve();
    const drainer = new QwpNodeOrphanDrainer({
      rootDirectory,
      scanIntervalMs: 0,
      createSession: async () => session,
    });
    drainer.start();
    await vi.waitFor(() => expect(drainer.metrics.active).toBe(1));
    await drainer.close();
    expect(session.closes).toBeGreaterThan(0);
    expect(drainer.metrics.closed).toBe(true);
  });
});
