import { beforeAll, describe, expect, it } from "vitest";
import { Sender } from "../../src";
import { preloadQwpNode } from "../../src/sender";

// The root Sender lazy-loads the QWP Node subsystem through the package's own
// subpath (the built artifact); against source, warm its cache with the source
// module so the Sender.fromConfig("udp::...") below runs the code under test.
beforeAll(preloadQwpNode);
import {
  QwpSymbolDictionary,
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

  bindError?: Error;

  bind(_port: number, _address: string, callback: () => void): void {
    queueMicrotask(() => {
      if (this.bindError) {
        this.errorListener?.(this.bindError);
        return;
      }
      callback();
    });
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
  it("rejects encode options a self-contained datagram cannot honour", async () => {
    // sendTables() accepts QwpIngressEncodeOptions but encodeUdpDatagrams
    // discarded them, so a caller who correctly passed a delta dictionary got
    // it silently ignored -- and the non-delta encoder then wrote every symbol
    // in the frame as the empty string.
    const socket = new FakeUdpSocket();
    const session = await connectQwpNodeUdp({
      host: "127.0.0.1",
      socketFactory: () => socket,
    });

    expect(() =>
      session.sendTables([longTable(1)], {
        dictionary: new QwpSymbolDictionary(),
      }),
    ).toThrow(/cannot use a delta symbol dictionary/);
    expect(() =>
      session.sendTables([longTable(1)], { confirmedMaxSymbolId: 0 }),
    ).toThrow(/no connection to track confirmed symbol IDs/);
    expect(socket.packets).toHaveLength(0);

    await session.close();
  });

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

  it("splits a large batch without re-encoding it once per datagram", async () => {
    // The search for each datagram's last row used to run to table.rowCount,
    // so the first probe of every datagram encoded half the rows still left.
    // That is O(rows^2 / rowsPerDatagram) row-encodes: a 40k-row flush blocked
    // the event loop for seconds and the cost quadrupled every time the batch
    // doubled. What matters is rows encoded, not probes -- the probe count was
    // always logarithmic; each one just encoded half of everything left. Every
    // probe slices exactly once, so summing the slice widths measures the work
    // exactly, and unlike wall-clock it cannot flake on a loaded machine.
    const slicedRows: number[] = [];
    for (const rows of [2000, 4000]) {
      const socket = new FakeUdpSocket();
      const session = await connectQwpNodeUdp({
        host: "localhost",
        port: 9007,
        maxDatagramSize: 200,
        socketFactory: () => socket,
      });
      const table = longTable(rows);
      const sliceRows = table.sliceRows.bind(table);
      let encoded = 0;
      table.sliceRows = (from: number, to: number) => {
        encoded += to - from;
        return sliceRows(from, to);
      };

      await session.sendTables([table]);

      slicedRows.push(encoded);
      // The split still has to hold: many self-contained frames, none over cap.
      expect(socket.packets.length).toBeGreaterThan(1);
      for (const packet of socket.packets) {
        expect(packet.byteLength).toBeLessThanOrEqual(200);
        expect(decodeQwpFrame(packet)).toMatchObject({
          flags: 0,
          tableCount: 1,
        });
      }
      await session.close();
    }

    // Doubling the rows must roughly double the work. The quadratic version
    // quadrupled it.
    const [small, large] = slicedRows;
    expect(large).toBeLessThan(small * 3);
    // And the work stays a small multiple of the batch, not a multiple of its
    // square: the quadratic version sliced hundreds of thousands of rows here.
    expect(large).toBeLessThan(4000 * 12);
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

  it("closes the socket when bind fails", async () => {
    // node:dgram keeps the handle open after a bind error, so a connect() that
    // fails on EACCES/EMFILE/EADDRNOTAVAIL used to leak one descriptor -- and a
    // reconnect loop retrying after EMFILE compounds the exhaustion it is
    // retrying from.
    const socket = new FakeUdpSocket();
    socket.bindError = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });

    await expect(
      connectQwpNodeUdp({
        host: "localhost",
        socketFactory: () => socket,
      }),
    ).rejects.toThrow(/EACCES/);
    expect(socket.closed).toBe(true);
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

  it("rejects security options supplied through programmatic UDP options", () => {
    const options = { protocol: "udp", host: "localhost", port: 9007 };
    for (const credentials of [
      { username: "admin" },
      { password: "secret" },
      { token: "bearer" },
    ]) {
      expect(() => new Sender({ ...options, ...credentials } as never)).toThrow(
        "authentication is not supported for QWP UDP transport",
      );
    }
    for (const tls of [
      { tls_verify: true },
      { tls_verify: false },
      { tls_ca: "test/certs/ca/ca.crt" },
    ]) {
      expect(() => new Sender({ ...options, ...tls } as never)).toThrow(
        "TLS is not supported for QWP UDP transport",
      );
    }
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
