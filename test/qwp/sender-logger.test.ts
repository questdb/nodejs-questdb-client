import { describe, expect, it } from "vitest";
import { QwpSender } from "../../packages/client-core/src/qwp";
import { createQwpBrowserSender } from "../../packages/browser-client/src";
import {
  Sender,
  createQwpNodeSender,
  createQwpNodeUdpSender,
  type QwpNodeUdpSocketLike,
} from "../../packages/nodejs-client/src";

/**
 * Logger routing for the two QWP senders that are built from a programmatic
 * options object rather than from a parsed ws/wss connect string.
 *
 * Both factories spread `options.qwp.sender` and then wrote `log: logger`,
 * where `logger` is already the module default whenever no top-level logger was
 * supplied. A caller who configured the documented `qwp.sender.log` callback
 * and nothing else therefore had it silently replaced: the sender's lifecycle
 * warnings -- rows about to be discarded, an open transaction about to be
 * rolled back -- went to the console instead of the sink that asked for them.
 */
class SilentUdpSocket implements QwpNodeUdpSocketLike {
  bind(_port: number, _address: string, callback: () => void): void {
    queueMicrotask(callback);
  }

  send(
    _message: Uint8Array,
    _port: number,
    _host: string,
    callback: (error: Error | null, bytes: number) => void,
  ): void {
    queueMicrotask(() => callback(null, _message.byteLength));
  }

  close(callback: () => void): void {
    queueMicrotask(callback);
  }

  on(): void {}

  setMulticastTTL(ttl: number): number {
    return ttl;
  }

  setMulticastInterface(): void {}
}

describe("programmatic QWP sender logging", () => {
  const unfinishedRowWarnings = (
    records: Array<[string, string | Error]>,
  ): string[] =>
    records
      .filter(([level]) => level === "warn")
      .map(([, message]) => String(message))
      .filter((message) => message.includes("unfinished column"));

  it("validates log centrally across direct and factory construction", () => {
    const builders = [
      (log: unknown) =>
        new QwpSender(
          async () => {
            throw new Error("session factory must stay lazy");
          },
          { log } as never,
        ),
      (log: unknown) =>
        createQwpNodeSender({ url: "ws://localhost:9000/write/v4" }, {
          log,
        } as never),
      (log: unknown) =>
        createQwpNodeUdpSender({ host: "localhost" }, { log } as never),
      (log: unknown) =>
        createQwpBrowserSender({ url: "ws://localhost:9000/write/v4" }, {
          log,
        } as never),
    ];

    for (const build of builders) {
      for (const log of [false, 0, "", NaN, {}]) {
        expect(() => build(log)).toThrow("Invalid logging function");
      }
      expect(() => build(null)).not.toThrow();
      expect(() => build(undefined)).not.toThrow();
    }
  });

  it("keeps qwp.sender.log on a programmatic ws sender", async () => {
    const records: Array<[string, string | Error]> = [];
    const sender = new Sender({
      protocol: "ws",
      host: "127.0.0.1",
      port: 9000,
      auto_flush: false,
      qwp: {
        sender: {
          log: (level, message) => records.push([level, message]),
        },
      },
    } as never);

    // An unfinished row is the documented close-time warning, and it needs no
    // server: nothing was completed, so close() never opens the socket.
    sender.table("events").intColumn("value", 1);
    await sender.close();

    expect(unfinishedRowWarnings(records)).toHaveLength(1);
  });

  it("keeps qwp.sender.log on a UDP sender built from a connect string", async () => {
    const records: Array<[string, string | Error]> = [];
    const sender = await Sender.fromConfig(
      "udp::addr=127.0.0.1:9009;auto_flush=off;",
      {
        qwp: {
          udp: { socketFactory: () => new SilentUdpSocket() },
          sender: {
            log: (level, message) => records.push([level, message]),
          },
        },
      },
    );

    sender.table("events").intColumn("value", 1);
    await sender.close();

    expect(unfinishedRowWarnings(records)).toHaveLength(1);
  });

  it("still prefers an explicit top-level logger over the QWP one", async () => {
    const topLevel: Array<[string, string | Error]> = [];
    const qwpLevel: Array<[string, string | Error]> = [];
    const sender = new Sender({
      protocol: "ws",
      host: "127.0.0.1",
      port: 9000,
      auto_flush: false,
      log: (level: string, message: string | Error) =>
        topLevel.push([level, message]),
      qwp: {
        sender: {
          log: (level, message) => qwpLevel.push([level, message]),
        },
      },
    } as never);

    sender.table("events").intColumn("value", 1);
    await sender.close();

    expect(unfinishedRowWarnings(topLevel)).toHaveLength(1);
    expect(qwpLevel).toEqual([]);
  });
});
