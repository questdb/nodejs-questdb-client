import { beforeAll, bench, describe } from "vitest";
import {
  encodeQwpIngressFrame,
  QWP_STATUS,
  QwpSymbolDictionary,
  type QwpIngressEncodeOptions,
  type QwpIngressResponse,
  type QwpTableBuffer,
} from "../src/qwp/core";
import { QwpSender, type QwpSenderSession } from "../src/qwp/sender";
import { BENCHMARK_WORKLOADS, type BenchmarkRow } from "./workloads";

const ROWS = 10_000;
let sink = 0;

class EncodingSession implements QwpSenderSession {
  private readonly dictionary = new QwpSymbolDictionary();
  private confirmedMaxSymbolId = -1;
  private publishedSequence = -1n;

  get publishedFrameSequence(): bigint {
    return this.publishedSequence;
  }

  get acknowledgedFrameSequence(): bigint {
    return this.publishedSequence;
  }

  async sendTables(
    tables: readonly QwpTableBuffer[],
    options: QwpIngressEncodeOptions = {},
  ): Promise<QwpIngressResponse> {
    this.encode(tables, options);
    return this.response();
  }

  async sendTablesDelta(
    tables: readonly QwpTableBuffer[],
    options: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit"> = {},
  ): Promise<QwpIngressResponse> {
    this.encodeDelta(tables, options);
    return this.response();
  }

  async publishTables(
    tables: readonly QwpTableBuffer[],
    options: QwpIngressEncodeOptions = {},
  ): Promise<void> {
    this.encode(tables, options);
  }

  async publishTablesDelta(
    tables: readonly QwpTableBuffer[],
    options: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit"> = {},
  ): Promise<void> {
    this.encodeDelta(tables, options);
  }

  async waitForDurable(): Promise<void> {}

  async close(): Promise<void> {}

  private encode(
    tables: readonly QwpTableBuffer[],
    options: QwpIngressEncodeOptions,
  ): void {
    sink += encodeQwpIngressFrame(tables, options).byteLength;
    this.publishedSequence++;
  }

  private encodeDelta(
    tables: readonly QwpTableBuffer[],
    options: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): void {
    sink += encodeQwpIngressFrame(tables, {
      ...options,
      dictionary: this.dictionary,
      confirmedMaxSymbolId: this.confirmedMaxSymbolId,
    }).byteLength;
    this.confirmedMaxSymbolId = this.dictionary.size - 1;
    this.publishedSequence++;
  }

  private response(): QwpIngressResponse {
    return {
      status: QWP_STATUS.OK,
      sequence: this.publishedSequence,
      tables: [],
    };
  }
}

async function fillSender(
  sender: QwpSender,
  rows: readonly BenchmarkRow[],
): Promise<void> {
  for (const row of rows) {
    sender.table(row.table);
    for (const [name, value] of row.symbols) sender.symbol(name, value);
    for (const [name, value] of row.longs) sender.longColumn(name, value);
    for (const [name, value] of row.doubles) {
      sender.doubleColumn(name, value);
    }
    for (const [name, value] of row.strings) {
      sender.stringColumn(name, value);
    }
    await sender.at(row.timestamp);
  }
}

function senderFor(
  session: EncodingSession,
  symbolDictionary: "delta" | "full",
): QwpSender {
  return new QwpSender(async () => session, {
    autoFlush: false,
    closeFlushTimeoutMs: 0,
    encode: { symbolDictionary },
  });
}

describe("high-level QwpSender build and encode", () => {
  for (const name of ["trades", "wide", "sparse"] as const) {
    const rows = BENCHMARK_WORKLOADS[name].rows(ROWS);
    bench(name, async () => {
      const sender = senderFor(new EncodingSession(), "full");
      await fillSender(sender, rows);
      await sender.flush();
    });
  }
});

describe("high-level symbol dictionary modes", () => {
  const rows = BENCHMARK_WORKLOADS.highCardinalitySymbols.rows(ROWS);
  const steadySession = new EncodingSession();

  beforeAll(async () => {
    const sender = senderFor(steadySession, "delta");
    await fillSender(sender, rows);
    await sender.flush();
  });

  bench("full dictionary", async () => {
    const sender = senderFor(new EncodingSession(), "full");
    await fillSender(sender, rows);
    await sender.flush();
  });

  bench("delta dictionary / cold", async () => {
    const sender = senderFor(new EncodingSession(), "delta");
    await fillSender(sender, rows);
    await sender.flush();
  });

  bench("delta dictionary / confirmed steady state", async () => {
    const sender = senderFor(steadySession, "delta");
    await fillSender(sender, rows);
    await sender.flush();
  });
});

export const senderBenchmarkSink = (): number => sink;
