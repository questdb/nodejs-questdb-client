import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QWP_SF_BACKPRESSURE_POLICY,
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  QwpReplayStoreAppendTimeoutError,
} from "../../packages/nodejs-client/src";
import {
  QWP_FLAG_DEFER_COMMIT,
  QWP_STATUS,
  QwpBinaryConnection,
  QwpByteWriter,
  QwpConnectionCloseInfo,
  QwpHandshakeMetadata,
  QwpIngressSession,
  QwpSender,
} from "../../packages/client-core/src/qwp";
import { QwpAsyncQueue } from "../../packages/client-core/src/_qwp/_internal/async-queue";

const SEGMENT_HEADER_SIZE = 24;
const FRAME_HEADER_SIZE = 8;

/**
 * QuestDB's transactional ACK model, reduced to what the journal depends on:
 * a frame that defers its commit is never acknowledged on its own, and any
 * frame that closes the transaction is acknowledged cumulatively.
 */
class DeferredAckConnection implements QwpBinaryConnection {
  readonly endpoint = "primary";
  readonly handshake: QwpHandshakeMetadata = { qwpVersion: 1 };
  readonly messages: AsyncIterable<Uint8Array>;
  readonly sent: Uint8Array[] = [];
  readonly closed: Promise<QwpConnectionCloseInfo>;
  private readonly incoming = new QwpAsyncQueue<Uint8Array>();
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  private closedSettled = false;

  constructor() {
    this.messages = this.incoming;
    let resolveClosed!: (info: QwpConnectionCloseInfo) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;
  }

  send(payload: Uint8Array): Promise<void> {
    this.sent.push(payload.slice());
    const wireSequence = BigInt(this.sent.length - 1);
    if ((payload[5] & QWP_FLAG_DEFER_COMMIT) === 0) {
      this.incoming.push(
        okResponse(wireSequence, [["events", wireSequence + 1n]]),
      );
    }
    return Promise.resolve();
  }

  close(code = 1000, reason = ""): Promise<void> {
    if (!this.closedSettled) {
      this.closedSettled = true;
      this.incoming.end();
      this.resolveClosed({ code, reason, wasClean: code === 1000 });
    }
    return Promise.resolve();
  }
}

function okResponse(
  sequence: bigint,
  tables: readonly [string, bigint][],
): Uint8Array {
  const writer = new QwpByteWriter()
    .writeUint8(QWP_STATUS.OK)
    .writeBigUint64(sequence)
    .writeUint16(tables.length);
  for (const [name, transaction] of tables) {
    const bytes = new TextEncoder().encode(name);
    writer
      .writeUint16(bytes.length)
      .writeBytes(bytes)
      .writeBigInt64(transaction);
  }
  return writer.toUint8Array();
}

function transactionalSender(session: QwpIngressSession): QwpSender {
  return new QwpSender(async () => session, {
    autoFlushRows: 1,
    autoFlushIntervalMs: 0,
    transactional: true,
    awaitServerAck: true,
  });
}

async function publishOneRowTransaction(sender: QwpSender): Promise<boolean> {
  await sender.table("events").longColumn("value", 42n).atNow();
  return sender.commit();
}

describe("QWP file replay store transaction liveness", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "qwp-sf-transaction-"));
    directories.push(directory);
    return directory;
  }

  /**
   * Frame sizes this producer emits, measured against the default in-memory
   * journal. The file store below is then sized so the deferred frame fills
   * its only segment exactly, without pinning the test to a frame encoding.
   */
  async function measureTransactionFrames(): Promise<readonly number[]> {
    const connection = new DeferredAckConnection();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 5_000,
      reconnect: { maxAttempts: 1 },
    });
    const sender = transactionalSender(session);
    try {
      await publishOneRowTransaction(sender);
      return connection.sent.map((frame) => frame.byteLength);
    } finally {
      await sender.close();
    }
  }

  it("admits a transaction commit when its deferred prefix fills the journal", async () => {
    const frameSizes = await measureTransactionFrames();
    expect(frameSizes).toHaveLength(2);
    // Sized so both frames fit a segment but never share one: the deferred
    // frame therefore fills the journal's only segment, and the commit that
    // would release it needs a segment the capacity target refuses.
    const maxSegmentBytes = Math.max(...frameSizes);
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes: SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes,
      durability: QWP_SF_DURABILITY.MEMORY,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 200,
    });
    const connection = new DeferredAckConnection();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 5_000,
      reconnect: { maxAttempts: 1 },
      replayStore: store,
    });
    const sender = transactionalSender(session);

    try {
      await sender.table("events").longColumn("value", 42n).atNow();
      expect(connection.sent).toHaveLength(1);
      expect(connection.sent[0][5] & QWP_FLAG_DEFER_COMMIT).toBe(
        QWP_FLAG_DEFER_COMMIT,
      );
      // The journal is exactly full and its single record can never be
      // acknowledged until the commit below reaches the transport.
      expect(store.metrics).toMatchObject({
        pendingRecords: 1,
        pendingSegments: 1,
        totalBytes: SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes,
      });

      const committing = sender.commit();
      await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
      expect(connection.sent[1][5] & QWP_FLAG_DEFER_COMMIT).toBe(0);
      await expect(committing).resolves.toBe(true);
      expect(sender.metrics.totalTransactionsCommitted).toBe(1);

      // The overshoot is temporary: the ACK the commit unblocks trims the
      // whole transaction back out of the journal.
      await vi.waitFor(() => expect(store.metrics.pendingRecords).toBe(0));
      expect(store.metrics.totalAppendTimeouts).toBe(0);
    } finally {
      await sender.close();
      await session.close();
    }
  });

  it("still enforces the journal ceiling outside an open transaction", async () => {
    // The liveness exception must cover only frames that close an already-open
    // transaction. A non-transactional producer that fills the journal keeps
    // the ordinary append deadline.
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 64,
      maxBytes: SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + 64,
      durability: QWP_SF_DURABILITY.MEMORY,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 50,
    });
    const connection = new DeferredAckConnection();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 5_000,
      reconnect: { maxAttempts: 1 },
      replayStore: store,
      // Withhold every ACK, so nothing trims and only capacity decides.
      backgroundStoreAndForward: true,
    });

    try {
      await session.publishFrame(new Uint8Array(60).fill(1));
      await expect(
        session.publishFrame(new Uint8Array(60).fill(2)),
      ).rejects.toBeInstanceOf(QwpReplayStoreAppendTimeoutError);
      expect(store.metrics.totalAppendTimeouts).toBe(1);
    } finally {
      await session.close();
    }
  });
});
