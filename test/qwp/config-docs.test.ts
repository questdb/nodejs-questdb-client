import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  QwpSender,
  type QwpSenderSession,
} from "../../packages/client-core/src/qwp";
import { QWP_SUPPORTED_CONFIG_KEYS } from "../../packages/nodejs-client/src/qwp-node/client-config";
import * as nodeClient from "../../packages/nodejs-client/src";
import * as browserClient from "../../packages/browser-client/src";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("QWP configuration-string reference", () => {
  it("only names entry points the package actually exports", async () => {
    // config-docs checked key names but never function names, so QWP.md could
    // -- and did -- point readers at a connectQwpNodeQuery() that has never
    // existed. Every backticked connect/create entry point it names has to
    // resolve against the Node package's public surface.
    const doc = await readFile(path.join(ROOT, "QWP.md"), "utf8");
    const named = new Set(
      [...doc.matchAll(/`((?:connect|create)Qwp[A-Za-z0-9]*)\(\)`/g)].map(
        (match) => match[1],
      ),
    );
    expect(named.size).toBeGreaterThan(3);

    // QWP.md documents both distributions, so an entry point may live in
    // either package root.
    const exported = new Set([
      ...Object.keys(nodeClient),
      ...Object.keys(browserClient),
    ]);
    const missing = [...named].filter((name) => !exported.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("documents every key the parser accepts", async () => {
    // A key the parser takes but QWP.md never names is undiscoverable: the
    // connect string is the portable spelling shared with the other QuestDB
    // clients, so the reference has to track the schema.
    const doc = await readFile(path.join(ROOT, "QWP.md"), "utf8");
    const undocumented = [...QWP_SUPPORTED_CONFIG_KEYS]
      .filter((key) => !doc.includes(`\`${key}\``))
      .sort();

    expect(undocumented).toEqual([]);
  });

  it("does not document keys the parser rejects", async () => {
    // The reference tables are the only place these back-ticked snake_case
    // names appear, so anything listed there must really be accepted.
    const doc = await readFile(path.join(ROOT, "QWP.md"), "utf8");
    const start = doc.indexOf("## Configuration-string keys");
    const section = doc.slice(
      start,
      doc.indexOf("\n### Node.js fire-and-forget UDP", start),
    );
    const listed = new Set(
      [
        ...section.matchAll(/^\| `([a-z0-9_]+)`(?:, `([a-z0-9_]+)`)?/gm),
      ].flatMap((match) => [match[1], match[2]].filter(Boolean) as string[]),
    );

    const unknown = [...listed]
      .filter((key) => !QWP_SUPPORTED_CONFIG_KEYS.has(key))
      .sort();

    expect(unknown).toEqual([]);
    // Guard against the extraction silently matching nothing.
    expect(listed.size).toBeGreaterThan(50);
  });

  it("documents the auto-flush defaults the sender actually applies", async () => {
    // These two rows read "—" while every sibling gave a number, so a reader
    // had no way to learn that ws:: batches 75x smaller and flushes 10x more
    // often than http::. Pin the documented values to real behavior.
    const doc = await readFile(path.join(ROOT, "QWP.md"), "utf8");
    const documented = (key: string): number => {
      const row = new RegExp(
        `^\\| \`${key}\`\\s*\\|[^|]*\\|\\s*\`?(\\d+)\`?\\s*\\|`,
        "m",
      ).exec(doc);
      if (!row) throw new Error(`no numeric default documented for ${key}`);
      return Number(row[1]);
    };
    const rows = documented("auto_flush_rows");
    const intervalMs = documented("auto_flush_interval");

    const sends: number[] = [];
    const session = {
      publishedFrameSequence: -1n,
      acknowledgedFrameSequence: -1n,
      async publishTables(tables: readonly { rowCount: number }[]) {
        sends.push(tables[0].rowCount);
      },
      async publishTablesDelta(tables: readonly { rowCount: number }[]) {
        sends.push(tables[0].rowCount);
      },
      async sendTables() {
        return { status: 0, sequence: 0n, tables: [] };
      },
      async waitForDurable() {},
      async close() {},
    } as unknown as QwpSenderSession;

    // Freeze the clock while the row trigger is under test, so the interval
    // trigger cannot fire instead. Staging 999 rows is ~2ms of work but 999
    // awaits, and on a loaded CI runner the event loop can take longer than
    // the 100ms interval to get through them -- which flushed mid-loop and
    // failed this assertion with a partial row count. Only Date is faked, so
    // the flush machinery's own timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const byRows = new QwpSender(async () => session);
      for (let row = 0; row < rows - 1; row++) {
        await byRows.table("t").intColumn("a", row).atNow();
      }
      expect(sends).toEqual([]);
      await byRows.table("t").intColumn("a", rows).atNow();
      expect(sends).toEqual([rows]);
      await byRows.close();
    } finally {
      vi.useRealTimers();
    }

    sends.length = 0;
    vi.useFakeTimers();
    try {
      const byInterval = new QwpSender(async () => session);
      await byInterval.table("t").intColumn("a", 1).atNow();
      vi.advanceTimersByTime(intervalMs - 1);
      await byInterval.table("t").intColumn("a", 2).atNow();
      expect(sends).toEqual([]);
      vi.advanceTimersByTime(1);
      await byInterval.table("t").intColumn("a", 3).atNow();
      expect(sends).toEqual([3]);
      await byInterval.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
