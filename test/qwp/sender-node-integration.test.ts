import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Sender } from "../../src";
import { QWP_MAGIC, QWP_STATUS, QwpByteWriter } from "../../src/qwp/node";

function okResponse(sequence: bigint, table: string): Uint8Array {
  const encodedTable = new TextEncoder().encode(table);
  return new QwpByteWriter()
    .writeUint8(QWP_STATUS.OK)
    .writeBigUint64(sequence)
    .writeUint16(1)
    .writeUint16(encodedTable.length)
    .writeBytes(encodedTable)
    .writeBigInt64(1n)
    .toUint8Array();
}

describe("Sender QWP integration", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("uses ws:: configuration, bearer authentication, and fluent rows", async () => {
    const frames: Uint8Array[] = [];
    let authorization: string | undefined;
    let requestPath: string | undefined;
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Max-Batch-Size: 1048576");
    });
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      requestPath = request.url;
      socket.on("message", (payload) => {
        frames.push(new Uint8Array(payload as Buffer));
        socket.send(okResponse(BigInt(frames.length - 1), "trades"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;

    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${port};token=secret;auto_flush=off`,
    );
    await sender.connect();
    await sender
      .table("trades")
      .symbol("symbol", "ETH-USD")
      .floatColumn("price", 2_615.54)
      .intColumn("amount", 2)
      .atNow();
    await expect(sender.flush()).resolves.toBe(true);
    await sender.close();

    expect(authorization).toBe("Bearer secret");
    expect(requestPath).toBe("/write/v4");
    expect(frames).toHaveLength(1);
    expect(
      new DataView(
        frames[0].buffer,
        frames[0].byteOffset,
        frames[0].byteLength,
      ).getUint32(0, true),
    ).toBe(QWP_MAGIC);
  });
});
