import { describe, expect, it } from "vitest";
import { Sender } from "../../src";
import {
  connectQwpNodeUdp,
  connectQwpNodeUdpSender,
  createQwpNodeUdpSender,
  type QwpNodeUdpSocketLike,
} from "../../src/qwp/node";
import { decodeQwpFrame, QWP_COLUMN_TYPE, QwpTableBuffer } from "../../src/qwp";
import { QwpUdpDatagramTooLargeError } from "../../src/qwp/node";

class FakeUdpSocket implements QwpNodeUdpSocketLike {
  readonly packets: Uint8Array[] = [];
  readonly destinations: Array<{ host: string; port: number }> = [];
  multicastTtl = -1;
  multicastInterface?: string;
  sendError?: Error;
  closed = false;
  private errorListener?: (error: Error) => void;

  bind(_port: number, _address: string, callback: () => void): void {
    queueMicrotask(callback);
  }

  send(
    message: Uint8Array,
    port: number,
    host: string,
    callback: (error: Error | null, bytes: number) => void,
  ): void {
    this.packets.push(message.slice());
    this.destinations.push({ host, port });
    queueMicrotask(() => callback(this.sendError ?? null, message.byteLength));
  }

  close(callback: () => void): void {
    this.closed = true;
    queueMicrotask(callback);
  }

  on(_event: "error", listener: (error: Error) => void): unknown {
    this.errorListener = listener;
    return this;
  }

  setMulticastTTL(ttl: number): number {
    this.multicastTtl = ttl;
    return ttl;
  }

  setMulticastInterface(multicastInterface: string): void {
    this.multicastInterface = multicastInterface;
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

function longTable(rows: number): QwpTableBuffer {
  const table = new QwpTableBuffer("trades");
  for (let row = 0; row < rows; row++) {
    const column = table.getOrCreateColumn("price", QWP_COLUMN_TYPE.LONG)!;
    column.values.push(BigInt(row));
    table.nextRow();
  }
  return table;
}

function stringTable(value: string): QwpTableBuffer {
  const table = new QwpTableBuffer("events");
  const column = table.getOrCreateColumn("message", QWP_COLUMN_TYPE.VARCHAR)!;
  column.values.push(value);
  table.nextRow();
  return table;
}

describe("QWP Node UDP sender", () => {
  it("splits at row boundaries into self-contained one-table datagrams", async () => {
    const socket = new FakeUdpSocket();
    const session = await connectQwpNodeUdp({
      host: "239.1.2.3",
      port: 9007,
      maxDatagramSize: 80,
      multicastTtl: 2,
      multicastInterface: "127.0.0.1",
      socketFactory: () => socket,
    });

    await session.sendTables([longTable(20)]);

    expect(socket.packets.length).toBeGreaterThan(1);
    for (const packet of socket.packets) {
      expect(packet.byteLength).toBeLessThanOrEqual(80);
      expect(decodeQwpFrame(packet)).toMatchObject({
        flags: 0,
        tableCount: 1,
      });
    }
    expect(socket.destinations).toEqual(
      socket.packets.map(() => ({ host: "239.1.2.3", port: 9007 })),
    );
    expect(socket.multicastTtl).toBe(2);
    expect(socket.multicastInterface).toBe("127.0.0.1");
    expect(session.udpMetrics).toMatchObject({
      totalDatagramsSent: socket.packets.length,
      totalSendErrors: 0,
    });
    await session.close();
    expect(socket.closed).toBe(true);
  });

  it("rejects one oversized row before sending any datagram", async () => {
    const socket = new FakeUdpSocket();
    const session = await connectQwpNodeUdp({
      host: "localhost",
      maxDatagramSize: 64,
      socketFactory: () => socket,
    });

    // Synchronously, before the returned promise exists -- QwpSender relies on
    // that to keep the batch staged when encoding fails.
    expect(() => session.sendTables([stringTable("x".repeat(256))])).toThrow(
      QwpUdpDatagramTooLargeError,
    );
    expect(() => session.publishTables([stringTable("x".repeat(256))])).toThrow(
      QwpUdpDatagramTooLargeError,
    );
    expect(socket.packets).toEqual([]);
    await session.close();
  });

  it("retains a batch whose oversized row cannot be encoded", async () => {
    // The session-level test above never reaches QwpSender, which is where row
    // ownership transfers. An encode failure happens before any datagram is
    // handed to the socket, so it is not the "already on the network" case the
    // fire-and-forget contract covers: the rows that do fit must survive for
    // the caller to retry, and none of them may be counted as published.
    const socket = new FakeUdpSocket();
    const sender = await connectQwpNodeUdpSender(
      { host: "localhost", maxDatagramSize: 256, socketFactory: () => socket },
      { autoFlush: false },
    );
    for (const message of ["abc", "abc", "abc"]) {
      await sender.table("events").stringColumn("message", message).atNow();
    }
    await sender
      .table("events")
      .stringColumn("message", "x".repeat(2000))
      .atNow();

    await expect(sender.flush()).rejects.toBeInstanceOf(
      QwpUdpDatagramTooLargeError,
    );
    expect(socket.packets).toEqual([]);
    expect(sender.metrics).toMatchObject({
      pendingRows: 4,
      totalRowsPublished: 0,
    });

    // Dropping the offending row lets the retry deliver the three that fit.
    sender.reset();
    for (const message of ["abc", "abc", "abc"]) {
      await sender.table("events").stringColumn("message", message).atNow();
    }
    await expect(sender.flush()).resolves.toBe(true);
    expect(socket.packets).toHaveLength(1);
    await sender.close();
  });

  it("reports local send failures without retrying fire-and-forget rows", async () => {
    const socket = new FakeUdpSocket();
    socket.sendError = new Error("network unreachable");
    const errors: Error[] = [];
    const session = await connectQwpNodeUdp({
      host: "localhost",
      socketFactory: () => socket,
      onError: (error) => errors.push(error),
    });

    await expect(session.sendTables([longTable(1)])).resolves.toMatchObject({
      status: 0,
      sequence: 0n,
    });
    expect(errors.map((error) => error.message)).toEqual([
      "network unreachable",
    ]);
    expect(session.udpMetrics).toMatchObject({
      publishedDatagramSequence: 0n,
      totalDatagramsSent: 0,
      totalSendErrors: 1,
    });
    await session.close();
  });

  it("integrates UDP with the fluent sender and top-level config API", async () => {
    const directSocket = new FakeUdpSocket();
    const direct = await connectQwpNodeUdpSender(
      {
        host: "localhost",
        socketFactory: () => directSocket,
      },
      { autoFlush: false },
    );
    direct.table("trades").longColumn("price", 42n);
    await direct.atNow();
    await expect(direct.flush()).resolves.toBe(true);
    expect(directSocket.packets).toHaveLength(1);
    await direct.close();

    const configuredSocket = new FakeUdpSocket();
    const configured = await Sender.fromConfig(
      "udp::addr=localhost;max_datagram_size=256;multicast_ttl=1;auto_flush=off;",
      { qwp: { udp: { socketFactory: () => configuredSocket } } },
    );
    await configured.connect();
    configured.table("trades").intColumn("price", 7);
    await configured.atNow();
    await configured.flush();
    expect(configuredSocket.packets).toHaveLength(1);
    expect(configuredSocket.multicastTtl).toBe(1);
    await configured.close();
  });

  it("rejects acknowledgement and transaction options that UDP cannot honor", () => {
    const options = {
      host: "localhost",
      socketFactory: () => new FakeUdpSocket(),
    };
    expect(() =>
      createQwpNodeUdpSender(options, { transactional: true }),
    ).toThrow(/does not support transactions/);
    expect(() =>
      createQwpNodeUdpSender(options, { awaitDurableAck: true }),
    ).toThrow(/does not support durable acknowledgements/);
  });
});
