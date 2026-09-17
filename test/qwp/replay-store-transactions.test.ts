import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QWP_SF_BACKPRESSURE_POLICY,
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  QwpReplayStoreAppendTimeoutError,
  QwpReplayStoreBatchTooLargeError,
} from "../../packages/nodejs-client/src";
import {
  decodeQwpFrame,
  QWP_COLUMN_TYPE,
  QWP_FLAG_DEFER_COMMIT,
  QWP_STATUS,
  QwpBinaryConnection,
  QwpByteWriter,
  QwpConnectionCloseInfo,
  QwpHandshakeMetadata,
  QwpIngressSession,
  QwpSender,
  QwpTableBuffer,
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

/**
 * A server that accepts every frame and answers none, which is the shape an
 * overloaded or partitioned node presents to a store-and-forward producer:
 * the journal keeps growing and nothing ever trims it.
 */
class SilentConnection implements QwpBinaryConnection {
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

/**
 * A frame the journal reads exactly as it reads a real one: only the flags
 * byte decides whether it opens, continues or closes a transaction.
 */
function transactionFrame(payloadLength: number, deferCommit: boolean) {
  const payload = new Uint8Array(payloadLength).fill(7);
  payload[5] = deferCommit ? QWP_FLAG_DEFER_COMMIT : 0;
  return payload;
}

/** Rows large enough that `maxBatchSizeBytes` splits them into 2+ frames. */
function splittableTable(rows: number): QwpTableBuffer {
  const table = new QwpTableBuffer("events");
  for (let row = 0; row < rows; row++) {
    table
      .getOrCreateColumn("value", QWP_COLUMN_TYPE.VARCHAR)!
      .values.push(String.fromCharCode(97 + row).repeat(60));
    table.nextRow();
  }
  return table;
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

  it("closes a genuine retained-dictionary transaction at a non-divisible segment cap", async () => {
    const measureConnection = new DeferredAckConnection();
    const measureSession = await QwpIngressSession.connect(
      async () => measureConnection,
      {
        ackTimeoutMs: 5_000,
        reconnect: { maxAttempts: 1 },
      },
    );
    const measureSender = transactionalSender(measureSession);
    try {
      await measureSender
        .table("events")
        .symbol("kind", "retained-symbol")
        .atNow();
      await measureSender.commit();
      await measureSender
        .table("events")
        .stringColumn("payload", "x".repeat(256))
        .atNow();
      await measureSender
        .table("events")
        .stringColumn("payload", "x".repeat(256))
        .atNow();
      await measureSender.commit();
    } finally {
      await measureSender.close();
    }

    expect(
      measureConnection.sent.map(
        (frame) => decodeQwpFrame(frame).flags & QWP_FLAG_DEFER_COMMIT,
      ),
    ).toEqual([
      QWP_FLAG_DEFER_COMMIT,
      0,
      QWP_FLAG_DEFER_COMMIT,
      QWP_FLAG_DEFER_COMMIT,
      0,
    ]);
    const maxSegmentBytes = Math.max(
      ...measureConnection.sent.map((frame) => frame.byteLength),
    );
    const segmentFileSize =
      SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes;
    const maxBytes = Math.floor(segmentFileSize * 1.4);
    // This is the proven encoder shape: two rounded prefix reservations plus
    // one independently valid close do not fit the old raw 2 * maxBytes cap.
    expect({ maxSegmentBytes, segmentFileSize, maxBytes }).toEqual({
      maxSegmentBytes: 297,
      segmentFileSize: 329,
      maxBytes: 460,
    });
    expect(2 * maxBytes).toBeLessThan(3 * segmentFileSize);

    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes,
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
      await sender.table("events").symbol("kind", "retained-symbol").atNow();
      await sender.commit();
      await vi.waitFor(() => expect(store.metrics.pendingRecords).toBe(0));
      await expect(store.loadSymbolDictionary()).resolves.toContain(
        "retained-symbol",
      );

      await sender
        .table("events")
        .stringColumn("payload", "x".repeat(256))
        .atNow();
      await sender
        .table("events")
        .stringColumn("payload", "x".repeat(256))
        .atNow();
      await expect(sender.commit()).resolves.toBe(true);

      expect(
        connection.sent.map(
          (frame) => decodeQwpFrame(frame).flags & QWP_FLAG_DEFER_COMMIT,
        ),
      ).toEqual([
        QWP_FLAG_DEFER_COMMIT,
        0,
        QWP_FLAG_DEFER_COMMIT,
        QWP_FLAG_DEFER_COMMIT,
        0,
      ]);
      await vi.waitFor(() => expect(store.metrics.pendingRecords).toBe(0));
      expect(store.metrics.totalAppendTimeouts).toBe(0);
    } finally {
      await sender.close();
      await session.close();
    }
  });

  it("keeps a retained dictionary additive to a single-frame close ceiling", async () => {
    const maxSegmentBytes = 64;
    const segmentFileSize =
      SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes;
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes: segmentFileSize,
      durability: QWP_SF_DURABILITY.MEMORY,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 100,
    });
    await store.load();

    try {
      const segmentBytesBeforeDictionary = store.metrics.totalBytes;
      await store.appendSymbolDictionary(0, ["retained-symbol"]);
      const dictionaryBytes =
        store.metrics.totalBytes - segmentBytesBeforeDictionary;
      expect(dictionaryBytes).toBeGreaterThan(0);
      await store.append({
        frameSequence: 0n,
        payload: transactionFrame(maxSegmentBytes, true),
      });
      await expect(
        store.append({
          frameSequence: 1n,
          payload: transactionFrame(maxSegmentBytes, false),
        }),
      ).resolves.toBeUndefined();

      expect(store.metrics.totalBytes - dictionaryBytes).toBe(
        2 * segmentFileSize,
      );
      expect(store.metrics.totalBytes).toBeGreaterThan(2 * segmentFileSize);
      expect(store.metrics).toMatchObject({
        totalBackpressureStalls: 0,
        totalAppendTimeouts: 0,
      });

      await store.acknowledgeThrough(1n);
      await vi.waitFor(() => expect(store.metrics.pendingRecords).toBe(0));
    } finally {
      await store.close();
    }

    const recovered = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes: segmentFileSize,
      durability: QWP_SF_DURABILITY.MEMORY,
    });
    await expect(recovered.load()).resolves.toEqual([]);
    await expect(recovered.loadSymbolDictionary()).resolves.toEqual([]);
    await recovered.close();
  });

  it("admits a split close at a non-divisible retained-dictionary cap", async () => {
    const maxSegmentBytes = 297;
    const segmentFileSize =
      SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes;
    const maxBytes = 460;
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes,
      durability: QWP_SF_DURABILITY.MEMORY,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 100,
    });
    await store.load();

    try {
      const segmentBytesBeforeDictionary = store.metrics.totalBytes;
      await store.appendSymbolDictionary(0, ["retained-symbol"]);
      const dictionaryBytes =
        store.metrics.totalBytes - segmentBytesBeforeDictionary;
      await store.append({
        frameSequence: 0n,
        payload: transactionFrame(maxSegmentBytes, true),
      });
      await store.append({
        frameSequence: 1n,
        payload: transactionFrame(maxSegmentBytes, true),
      });
      const closing = [
        transactionFrame(100, true),
        transactionFrame(100, false),
      ];

      await expect(store.prepareAppendBatch(closing)).resolves.toBeUndefined();
      await store.append({ frameSequence: 2n, payload: closing[0] });
      await store.append({ frameSequence: 3n, payload: closing[1] });

      expect(store.metrics.totalBytes - dictionaryBytes).toBe(
        3 * segmentFileSize,
      );
      expect(store.metrics).toMatchObject({
        pendingRecords: 4,
        pendingSegments: 3,
        totalBackpressureStalls: 0,
        totalAppendTimeouts: 0,
      });
      await store.acknowledgeThrough(3n);
      await vi.waitFor(() => expect(store.metrics.pendingRecords).toBe(0));
    } finally {
      await store.close();
    }
  });

  it("keeps a retained dictionary additive to a split close ceiling", async () => {
    const maxSegmentBytes = 64;
    const segmentFileSize =
      SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes;
    const maxBytes = 2 * segmentFileSize;
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes,
      durability: QWP_SF_DURABILITY.MEMORY,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 100,
    });
    await store.load();

    try {
      const segmentBytesBeforeDictionary = store.metrics.totalBytes;
      await store.appendSymbolDictionary(0, ["retained-symbol"]);
      const dictionaryBytes =
        store.metrics.totalBytes - segmentBytesBeforeDictionary;
      await store.append({
        frameSequence: 0n,
        payload: transactionFrame(maxSegmentBytes, true),
      });
      await store.append({
        frameSequence: 1n,
        payload: transactionFrame(maxSegmentBytes, true),
      });
      const closing = [
        transactionFrame(maxSegmentBytes, true),
        transactionFrame(maxSegmentBytes, false),
      ];
      await expect(store.prepareAppendBatch(closing)).resolves.toBeUndefined();
      await store.append({ frameSequence: 2n, payload: closing[0] });
      await store.append({ frameSequence: 3n, payload: closing[1] });

      expect(store.metrics).toMatchObject({
        pendingRecords: 4,
        pendingSegments: 4,
        totalBackpressureStalls: 0,
        totalAppendTimeouts: 0,
      });
      expect(store.metrics.totalBytes - dictionaryBytes).toBe(2 * maxBytes);
      expect(store.metrics.totalBytes).toBeGreaterThan(2 * maxBytes);

      await store.acknowledgeThrough(3n);
      await vi.waitFor(() => expect(store.metrics.pendingRecords).toBe(0));
    } finally {
      await store.close();
    }

    const recovered = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes,
      durability: QWP_SF_DURABILITY.MEMORY,
    });
    await expect(recovered.load()).resolves.toEqual([]);
    await expect(recovered.loadSymbolDictionary()).resolves.toEqual([]);
    await recovered.close();
  });

  it.each([false, true])(
    "stops admitting transaction commits at the liveness ceiling (dictionary=%s)",
    async (withDictionary) => {
      // Two records per segment, one segment of target. A transaction whose
      // deferred prefix fills the journal then needs exactly one more segment
      // for its commit, and the segment it lands in has a free slot the next
      // transaction's deferred frame fits into -- so every later commit rotates
      // again. Granting each of them the liveness exception grew the journal by
      // a segment per transaction, forever, with no append ever timing out.
      const payloadLength = 32;
      const recordSize = FRAME_HEADER_SIZE + payloadLength;
      const maxSegmentBytes = 2 * recordSize - FRAME_HEADER_SIZE;
      const segmentFileSize =
        SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes;
      const directory = await temporaryDirectory();
      const store = new QwpNodeFileReplayStore({
        directory,
        maxSegmentBytes,
        maxBytes: segmentFileSize,
        durability: QWP_SF_DURABILITY.MEMORY,
        backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
        appendDeadlineMs: 50,
      });
      await store.load();
      const segmentBytesBeforeDictionary = store.metrics.totalBytes;
      if (withDictionary) {
        await store.appendSymbolDictionary(0, ["retained-symbol"]);
      }
      const dictionaryBytes =
        store.metrics.totalBytes - segmentBytesBeforeDictionary;
      let sequence = 0n;
      const append = (deferCommit: boolean) =>
        store.append({
          frameSequence: sequence++,
          payload: transactionFrame(payloadLength, deferCommit),
        });

      try {
        // Fill the journal with a deferred prefix, then close it.
        await append(true);
        await append(true);
        await append(false);
        expect(store.metrics.pendingSegments).toBe(2);
        expect(store.metrics.totalBytes - dictionaryBytes).toBe(
          2 * segmentFileSize,
        );

        // The commit landed in a segment with a free slot, so the next
        // transaction opens without needing one of its own.
        await append(true);
        expect(store.metrics.totalBytes - dictionaryBytes).toBe(
          2 * segmentFileSize,
        );

        // Nothing acknowledges, so that transaction -- and every attempt after
        // it -- is backpressured instead of buying another segment.
        for (let attempt = 0; attempt < 4; attempt++) {
          await expect(append(false)).rejects.toBeInstanceOf(
            QwpReplayStoreAppendTimeoutError,
          );
          // A refused frame never entered the journal, so the next attempt must
          // reuse its sequence to stay contiguous.
          sequence--;
          expect(store.metrics.totalBytes - dictionaryBytes).toBe(
            2 * segmentFileSize,
          );
        }
        expect(store.metrics).toMatchObject({
          pendingSegments: 2,
          totalAppendTimeouts: 4,
        });
      } finally {
        await store.close();
      }
    },
  );

  it("does not admit a commit over target once the journal is record-free", async () => {
    // A journal holding no record has no deferred prefix to release, so a
    // commit that arrives while its acknowledged segments are still being
    // trimmed has earned no exception: it must wait for that trimming like any
    // other frame instead of adding a segment beyond the target.
    const payloadLength = 32;
    const segmentFileSize =
      SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + payloadLength;
    // More segments than one trim batch retires, so trimming is still in
    // flight when the append below is queued behind the acknowledgement.
    const segmentCount = 20;
    const maxBytes = segmentCount * segmentFileSize;
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: payloadLength,
      maxBytes,
      durability: QWP_SF_DURABILITY.MEMORY,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 2_000,
    });
    await store.load();
    let sequence = 0n;

    try {
      for (let frame = 0; frame < segmentCount; frame++) {
        await store.append({
          frameSequence: sequence++,
          // The last frame leaves a transaction open, so the journal drains
          // while it still believes one is in flight.
          payload: transactionFrame(payloadLength, frame === segmentCount - 1),
        });
      }
      expect(store.metrics.totalBytes).toBe(maxBytes);

      const acknowledging = store.acknowledgeThrough(sequence - 1n);
      const appending = store.append({
        frameSequence: sequence++,
        payload: transactionFrame(payloadLength, false),
      });
      await acknowledging;
      await expect(appending).resolves.toBeUndefined();
      expect(store.metrics.totalBackpressureStalls).toBe(1);
      expect(store.metrics.totalBytes).toBeLessThanOrEqual(maxBytes);
    } finally {
      await store.close();
    }
  });

  it("refuses a transaction-closing split batch larger than the journal", async () => {
    // The whole-batch preflight admits every frame of a batch that closes an
    // open transaction. Without a bound on the batch itself, one split commit
    // was journalled in full however large it was: each frame then matched the
    // prepared batch and skipped the capacity gate in turn.
    const maxBytes = SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + 128;
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 128,
      maxBytes,
      durability: QWP_SF_DURABILITY.MEMORY,
      appendDeadlineMs: 50,
    });
    const preflights = vi.spyOn(store, "prepareAppendBatch");
    const connection = new SilentConnection();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 5_000,
      reconnect: { maxAttempts: 1 },
      replayStore: store,
      backgroundStoreAndForward: true,
      maxBatchSizeBytes: 128,
    });

    try {
      // Open a transaction the journal must keep until its commit arrives.
      await session.publishFrame(transactionFrame(60, true));
      const sending = session.sendTablesWithPublication([splittableTable(3)]);
      const acknowledged = sending.acknowledgement.catch(
        (error: unknown) => error,
      );
      await expect(sending.publication).rejects.toBeInstanceOf(
        QwpReplayStoreBatchTooLargeError,
      );
      await acknowledged;
      // The rejection came from the split-batch preflight, not from a
      // per-frame append that only this shape of flush can reach.
      expect((preflights.mock.calls[0]?.[0] ?? []).length).toBeGreaterThan(1);
      // Rejected as a batch: nothing of it entered the journal or the wire.
      expect(store.metrics).toMatchObject({
        pendingRecords: 1,
        pendingSegments: 1,
        totalBytes: maxBytes,
      });
      expect(connection.sent).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it("admits a transaction-closing split batch that fits the journal", async () => {
    // The other half of the same preflight: a split commit whose own footprint
    // fits the configured journal still releases the deferred prefix that
    // fills it, and the ACK that commit unblocks trims the overshoot away.
    const maxSegmentBytes = 128;
    const segmentFileSize =
      SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + maxSegmentBytes;
    const directory = await temporaryDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes,
      maxBytes: 2 * segmentFileSize,
      durability: QWP_SF_DURABILITY.MEMORY,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 200,
    });
    const preflights = vi.spyOn(store, "prepareAppendBatch");
    const connection = new DeferredAckConnection();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 5_000,
      reconnect: { maxAttempts: 1 },
      replayStore: store,
      maxBatchSizeBytes: 128,
    });

    try {
      // Two deferred frames, one per segment: the journal is at its target and
      // neither frame can be acknowledged before the commit below.
      await session.publishFrame(transactionFrame(100, true));
      await session.publishFrame(transactionFrame(100, true));
      expect(store.metrics).toMatchObject({
        pendingSegments: 2,
        totalBytes: 2 * segmentFileSize,
      });

      const sending = session.sendTablesWithPublication([splittableTable(2)]);
      await expect(sending.publication).resolves.toBeUndefined();
      expect(preflights.mock.calls[0][0].length).toBe(2);
      expect(connection.sent).toHaveLength(4);
      expect(store.metrics.totalBytes).toBeLessThanOrEqual(4 * segmentFileSize);

      await expect(sending.acknowledgement).resolves.toMatchObject({
        sequence: sending.sequence,
      });
      await vi.waitFor(() => expect(store.metrics.pendingRecords).toBe(0));
      expect(store.metrics.totalAppendTimeouts).toBe(0);
    } finally {
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
