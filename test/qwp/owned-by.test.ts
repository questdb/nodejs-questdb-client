import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeClient,
  createQwpNodeSender,
  encodeQwpFrame,
  QWP_EGRESS_MESSAGE,
  QWP_SERVER_ROLE,
  QWP_STATUS,
  QWP_UPGRADE_ERROR_KIND,
  QwpByteWriter,
  QwpFailoverError,
  QwpOwnedByMismatchError,
  QwpUpgradeError,
  Sender,
} from "../../packages/nodejs-client/src";
// Internal: the package root exports neither the ingress-session factory nor
// the raw WebSocket connector, nor the store-and-forward journal.
import {
  connectQwpNodeIngress,
  connectQwpNodeWebSocket,
} from "../../packages/nodejs-client/src/qwp";
import { QwpNodeFileReplayStore } from "../../packages/nodejs-client/src/qwp-node/file-replay-store";
import {
  encodeQwpOwnedBy,
  validateQwpOwnedBy,
} from "../../packages/client-core/src/_qwp/owned-by";
import { sanitizeQwpDisplayText } from "../../packages/client-core/src/_qwp/_internal/display-text";
import { publishAndWait } from "./publish-and-wait";

/**
 * The `ownedBy` option of the Node.js client: the owner of the tables and
 * columns a sender auto-creates, sent as `X-QWP-Owned-By` on every `/write/v4`
 * upgrade and confirmed by the server's echo, and the reason a server gives
 * for rejecting an upgrade.
 */

// A name both sides must percent-encode: UTF-8, a space, '+' and '%'.
const OWNER = "café team+%1";
const OWNER_ENCODED = "caf%C3%A9%20team%2B%251";
const NO_ECHO = "<no X-QWP-Owned-By header>";

function unconfirmedOwnerMessage(url: string, echo: string): string {
  return `QWP server did not confirm owned_by, so it cannot set the owner of the tables and columns it auto-creates [url=${url}, owned_by=${OWNER}, echoed=${echo}]`;
}

interface UpgradeRequest {
  readonly path: string;
  /** The `X-QWP-Owned-By` value, or undefined when the request had none. */
  readonly ownedBy?: string;
}

/**
 * A QuestDB stand-in that records the owner each upgrade names and, like a
 * server that accepts it, echoes it back; `echo` and `reject` make it behave
 * like one that does not.
 */
interface OwnerServer {
  readonly url: string;
  readonly requests: UpgradeRequest[];
  readonly received: Uint8Array[];
  /**
   * `"request"` echoes the requested owner, `null` sends no echo, as a server
   * that predates the option does, and a string echoes that value instead.
   */
  echo: "request" | null | string;
  /** Rejects every upgrade with this status and text/plain body instead. */
  reject?: { status: number; body?: string };
  /** Drops every open connection, as a server that went away does. */
  terminateConnections(): void;
  close(): Promise<void>;
}

const servers: OwnerServer[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function ownerServer(): Promise<OwnerServer> {
  const requests: UpgradeRequest[] = [];
  const received: Uint8Array[] = [];
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (info, done) => {
      requests.push({
        path: info.req.url ?? "",
        ownedBy: info.req.headers["x-qwp-owned-by"] as string | undefined,
      });
      const reject = server.reject;
      if (reject) {
        done(false, reject.status, reject.body, {
          "Content-Type": "text/plain",
        });
      } else {
        done(true);
      }
    },
  });
  wss.on("headers", (headers: string[], request: IncomingMessage) => {
    headers.push("X-QWP-Version: 1");
    const requested = request.headers["x-qwp-owned-by"];
    if (requested === undefined || server.echo === null) return;
    headers.push(
      `X-QWP-Owned-By: ${server.echo === "request" ? requested : server.echo}`,
    );
  });
  wss.on("connection", (socket, request) => {
    if (request.url?.startsWith("/read/v1")) {
      socket.send(serverInfo());
      return;
    }
    let sequence = 0n;
    socket.on("message", (payload) => {
      received.push(new Uint8Array(payload as Buffer));
      socket.send(okResponse(sequence++));
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const { port } = wss.address() as AddressInfo;
  const server: OwnerServer = {
    url: `ws://127.0.0.1:${port}/write/v4`,
    requests,
    received,
    echo: "request",
    terminateConnections: () => {
      for (const client of wss.clients) client.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
  servers.push(server);
  return server;
}

function okResponse(sequence: bigint): Uint8Array {
  const table = new TextEncoder().encode("trades");
  return new QwpByteWriter()
    .writeUint8(QWP_STATUS.OK)
    .writeBigUint64(sequence)
    .writeUint16(1)
    .writeUint16(table.length)
    .writeBytes(table)
    .writeBigInt64(1n)
    .toUint8Array();
}

function serverInfo(): Uint8Array {
  return encodeQwpFrame(
    new QwpByteWriter()
      .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
      .writeUint8(QWP_SERVER_ROLE.STANDALONE)
      .writeBigUint64(1n)
      .writeUint32(0)
      .writeBigInt64(123n)
      .writeUint16(0)
      .writeUint16(0)
      .toUint8Array(),
  );
}

/**
 * A server that answers every upgrade request with `response`, written in one
 * piece, as QuestDB writes a rejection, and leaves the connection open unless
 * `end` is set. Resolves with its `/write/v4` URL.
 */
async function rawUpgradeServer(
  response: Buffer | ((request: string) => Buffer),
  end = true,
): Promise<string> {
  const sockets = new Set<Socket>();
  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let request = "";
    const onData = (chunk: Buffer): void => {
      request += chunk.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      socket.resume();
      const bytes =
        typeof response === "function" ? response(request) : response;
      if (end) socket.end(bytes);
      else socket.write(bytes);
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  });
  return `ws://127.0.0.1:${(tcp.address() as AddressInfo).port}/write/v4`;
}

/**
 * A rejected upgrade with `body`, its Content-Type and Content-Length overridden
 * when given, so that a test can send headers that do not describe the body.
 */
function rejection(
  status: string,
  body: string,
  contentType = "text/plain",
  contentLength?: string,
): Buffer {
  const bytes = Buffer.from(body, "utf8");
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: ${contentType}\r\nContent-Length: ${contentLength ?? bytes.byteLength}\r\n\r\n`,
      "latin1",
    ),
    bytes,
  ]);
}

/** A 101 that completes `request`'s upgrade and echoes `ownedBy` raw. */
function switchingProtocols(request: string, ownedBy: Buffer): Buffer {
  const key = /^sec-websocket-key:\s*(\S+)/im.exec(request)![1];
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-QWP-Version: 1\r\nX-QWP-Owned-By: `,
      "latin1",
    ),
    ownedBy,
    Buffer.from("\r\n\r\n", "latin1"),
  ]);
}

async function upgradeFailure(url: string): Promise<QwpUpgradeError> {
  const error = await connectQwpNodeWebSocket({
    url,
    closeTimeoutMs: 100,
  }).then(
    async (connection) => {
      await connection.close();
      throw new Error("expected the upgrade to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(QwpUpgradeError);
  return error as QwpUpgradeError;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qwp-owned-by-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("QWP owned_by encoding", () => {
  it("encodes an owner in the canonical form QuestDB echoes", () => {
    // RFC 3986 unreserved characters stay as they are.
    expect(encodeQwpOwnedBy("Team-A_1.x~")).toBe("Team-A_1.x~");
    // Everything else is percent-encoded UTF-8 with upper-case hex digits,
    // '%' and '+' included.
    expect(encodeQwpOwnedBy("a b+c%d/é表")).toBe(
      "a%20b%2Bc%25d%2F%C3%A9%E8%A1%A8",
    );
    expect(encodeQwpOwnedBy(OWNER)).toBe(OWNER_ENCODED);
    // The ends of the unreserved ranges stay, the characters just outside them
    // do not: the server re-encodes the owner it echoes, and the echo must
    // match what was sent byte for byte.
    expect(encodeQwpOwnedBy("AZaz09")).toBe("AZaz09");
    expect(encodeQwpOwnedBy("@[`{/:")).toBe("%40%5B%60%7B%2F%3A");
    // encodeURIComponent() leaves these as they are; the server does not.
    expect(encodeQwpOwnedBy("!'()*")).toBe("%21%27%28%29%2A");
    // A supplementary-plane character is one four-byte UTF-8 sequence.
    expect(encodeQwpOwnedBy("😀")).toBe("%F0%9F%98%80");
  });

  it("rejects an owner that names nobody or cannot be sent", () => {
    expect(validateQwpOwnedBy(undefined)).toBeUndefined();
    // Sent as it is: the server looks the name up verbatim.
    expect(validateQwpOwnedBy(" team ")).toBe(" team ");
    for (const blank of ["", " ", "\t\r\n"]) {
      expect(() => validateQwpOwnedBy(blank)).toThrow(
        new TypeError("ownedBy must not be empty or blank"),
      );
    }
    expect(() => validateQwpOwnedBy(42)).toThrow(
      new TypeError("ownedBy must be a string"),
    );
    // UTF-8 has no encoding for it: a URL would carry U+FFFD in its place.
    expect(() => validateQwpOwnedBy("team\uD800")).toThrow(
      new TypeError("ownedBy must not contain a lone surrogate"),
    );
    expect(() => validateQwpOwnedBy("", "owned_by")).toThrow(
      "owned_by must not be empty or blank",
    );
    // A sender reports it when it is created, not at its first connect.
    expect(() =>
      createQwpNodeSender({ url: "ws://127.0.0.1:1/write/v4", ownedBy: " " }),
    ).toThrow("ownedBy must not be empty or blank");
  });

  it("makes server text safe to display", () => {
    // Controls, CR/LF, bidirectional overrides, zero-width and other format
    // characters, line separators and lone surrogates.
    expect(
      sanitizeQwpDisplayText("a\r\n\u0007b\u202Ec\u200Bd\u2028e\uFEFF\uD800f"),
    ).toBe("abcdef");
    expect(sanitizeQwpDisplayText("x".repeat(256))).toBe("x".repeat(256));
    // Cut to 256 characters, the last three of which mark the cut.
    expect(sanitizeQwpDisplayText("x".repeat(257))).toBe(
      `${"x".repeat(253)}...`,
    );
    // A surrogate pair is never split.
    expect(sanitizeQwpDisplayText(`${"x".repeat(252)}${"😀".repeat(10)}`)).toBe(
      `${"x".repeat(252)}...`,
    );
  });
});

describe("QWP owned_by upgrade", () => {
  it("names the owner on the upgrade and accepts its echo", async () => {
    const server = await ownerServer();
    const connection = await connectQwpNodeWebSocket({
      url: server.url,
      ownedBy: OWNER,
    });
    await connection.close();
    expect(server.requests).toEqual([
      { path: "/write/v4", ownedBy: OWNER_ENCODED },
    ]);
  });

  it("names no owner unless asked to", async () => {
    const server = await ownerServer();
    const connection = await connectQwpNodeWebSocket({ url: server.url });
    await connection.close();
    expect(server.requests).toEqual([{ path: "/write/v4" }]);
  });

  it("fails an upgrade that does not confirm the owner", async () => {
    // A server that does not know the header completes the upgrade without the
    // echo. The tables the connection auto-created there would not get the
    // owner, so it fails rather than connects -- without an HTTP status, as
    // the server answered 101, and with the sweep free to try the next
    // endpoint, as for a missing durable ACK.
    const server = await ownerServer();
    for (const [echo, echoed] of [
      [null, NO_ECHO],
      ["other", "other"],
      // The server echoes the canonical encoding; anything else is not it.
      ["caf%c3%a9%20team%2b%251", "caf%c3%a9%20team%2b%251"],
    ] as const) {
      server.echo = echo;
      const error = await connectQwpNodeWebSocket({
        url: server.url,
        ownedBy: OWNER,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QwpOwnedByMismatchError);
      expect(error).toMatchObject({
        name: "QwpOwnedByMismatchError",
        kind: QWP_UPGRADE_ERROR_KIND.CAPABILITY_MISMATCH,
        retryable: false,
        tryNextEndpoint: true,
        statusCode: undefined,
        url: server.url,
        ownedBy: OWNER,
        message: unconfirmedOwnerMessage(server.url, echoed),
      } satisfies Partial<QwpOwnedByMismatchError>);
    }
  });

  it("keeps the echoed text it reports display-safe", async () => {
    // A header value reaches Node as Latin-1, so its obs-text bytes include the
    // C1 controls -- 0x9B is a terminal's CSI -- and nothing but the header
    // size limit bounds its length.
    const url = await rawUpgradeServer(
      (request) =>
        switchingProtocols(
          request,
          Buffer.concat([
            Buffer.from("team", "latin1"),
            Buffer.of(0x9b),
            Buffer.from(`31m${"y".repeat(300)}`, "latin1"),
          ]),
        ),
      false,
    );
    const error = (await connectQwpNodeWebSocket({
      url,
      ownedBy: "team",
      closeTimeoutMs: 100,
    }).catch((caught: unknown) => caught)) as QwpOwnedByMismatchError;
    expect(error).toBeInstanceOf(QwpOwnedByMismatchError);
    expect(error.message).toContain(
      `echoed=team31m${"y".repeat(253 - "team31m".length)}...]`,
    );
  });

  it("rejects an owner also spelled as a header", async () => {
    // The same rule as for Authorization: whichever won, the other would go
    // unconfirmed or never reach the wire.
    const server = await ownerServer();
    const error = await connectQwpNodeWebSocket({
      url: server.url,
      ownedBy: "team_a",
      headers: { "x-qwp-owned-by": "team_b" },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message:
        "an X-QWP-Owned-By header cannot be combined with the 'ownedBy' option; set exactly one of them",
      retryable: false,
    });
    expect(server.requests).toEqual([]);

    // The header on its own is the caller's escape hatch, sent unconfirmed.
    server.echo = null;
    const connection = await connectQwpNodeWebSocket({
      url: server.url,
      headers: { "X-QWP-Owned-By": "team_b" },
    });
    await connection.close();
    expect(server.requests).toEqual([{ path: "/write/v4", ownedBy: "team_b" }]);
  });

  it("reports a refused owner with the server's reason, like a rejected credential", async () => {
    // QuestDB refuses an owner the principal may not name with 403 and the
    // reason. The refusal holds on every node, so the sweep stops as it does
    // for a rejected credential, and the reason tells the two apart.
    const refusing = await ownerServer();
    refusing.reject = {
      status: 403,
      body: "owned_by refused: bob is not part of group team",
    };
    const next = await ownerServer();
    const error = await connectQwpNodeWebSocket({
      url: refusing.url,
      failoverUrls: [next.url],
      ownedBy: "team",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QwpUpgradeError);
    expect(error).toMatchObject({
      kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
      statusCode: 403,
      tryNextEndpoint: false,
      retryable: false,
      reason: "owned_by refused: bob is not part of group team",
      message:
        "QWP WebSocket upgrade rejected with HTTP 403 Forbidden [reason=owned_by refused: bob is not part of group team]",
    } satisfies Partial<QwpUpgradeError>);
    expect(refusing.requests).toEqual([{ path: "/write/v4", ownedBy: "team" }]);
    expect(next.requests).toEqual([]);
  });

  it("reports a reason only for a whole text/plain body", async () => {
    // Best effort: a text/plain body that arrived whole with the headers.
    // Anything else yields no reason rather than a guess.
    const reasonOf = async (response: Buffer, end = true) =>
      (await upgradeFailure(await rawUpgradeServer(response, end))).reason;

    expect(
      await reasonOf(
        rejection(
          "400 Bad Request",
          "owned_by refused: access control is disabled\r\n",
        ),
      ),
    ).toBe("owned_by refused: access control is disabled");
    expect(
      await reasonOf(rejection("400 Bad Request", "<p>no</p>", "text/html")),
    ).toBeUndefined();
    expect(
      await reasonOf(rejection("400 Bad Request", " \r\n\t ")),
    ).toBeUndefined();
    expect(await reasonOf(rejection("400 Bad Request", ""))).toBeUndefined();
    // One byte more than the 16 of the body: the rest is still in flight, and
    // the client waits for no more of it.
    expect(
      await reasonOf(
        rejection("400 Bad Request", "owned_by refused", "text/plain", "17"),
        false,
      ),
    ).toBeUndefined();
  });

  it("names the reason in the message, made safe to display", async () => {
    const failure = async (body: string) =>
      upgradeFailure(
        await rawUpgradeServer(
          rejection("400 Bad Request", body, "Text/Plain; charset=utf-8"),
        ),
      );

    const sanitized = await failure(
      "owned_by refused:\r\n\u0007bob\u202E is\u200B not part of group café",
    );
    expect(sanitized).toMatchObject({
      kind: QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED,
      statusCode: 400,
      reason: "owned_by refused:bob is not part of group café",
      message:
        "QWP WebSocket upgrade rejected with HTTP 400 Bad Request [reason=owned_by refused:bob is not part of group café]",
    } satisfies Partial<QwpUpgradeError>);

    const body = "x".repeat(300);
    expect((await failure(body)).reason).toBe(`${"x".repeat(253)}...`);
  });

  it("reports a mixed sweep's unconfirmed owner among its attempts", async () => {
    // A replica's 421 does not hide that the primary answered 101 without the
    // echo: a one-sweep startup fails with both attempts.
    const replica = await ownerServer();
    replica.reject = { status: 421 };
    const primary = await ownerServer();
    primary.echo = null;
    const error = await connectQwpNodeWebSocket({
      url: replica.url,
      failoverUrls: [primary.url],
      ownedBy: OWNER,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QwpFailoverError);
    const attempts = (error as QwpFailoverError).attempts;
    expect(attempts.map((attempt) => attempt.endpoint)).toEqual([
      replica.url,
      primary.url,
    ]);
    expect(attempts[0].error).toMatchObject({
      kind: QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED,
    });
    expect(attempts[1].error).toBeInstanceOf(QwpOwnedByMismatchError);
    expect((error as QwpFailoverError).cause).toBe(attempts[1].error);
  });
});

describe("QWP owned_by sender", () => {
  it("names the owner from a connect string and from the typed option", async () => {
    const server = await ownerServer();
    const configured = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${new URL(server.url).port};owned_by=${OWNER};`,
    );
    try {
      await configured.connect();
    } finally {
      await configured.close();
    }
    const typed = createQwpNodeSender({ url: server.url, ownedBy: "team_a" });
    try {
      await typed.connect();
    } finally {
      await typed.close();
    }
    expect(server.requests).toEqual([
      { path: "/write/v4", ownedBy: OWNER_ENCODED },
      { path: "/write/v4", ownedBy: "team_a" },
    ]);
  });

  it("fails its first connect when the owner is not confirmed", async () => {
    const server = await ownerServer();
    server.echo = null;
    const sender = createQwpNodeSender({ url: server.url, ownedBy: OWNER });
    try {
      await expect(sender.connect()).rejects.toThrow(
        unconfirmedOwnerMessage(server.url, NO_ECHO),
      );
    } finally {
      await sender.close().catch(() => undefined);
    }
  });

  it("does not retry an unconfirmed owner at a blocking startup", async () => {
    // A synchronous startup retries a failed connect within its budget, but
    // not a server that does not confirm the owner: like a rejected credential,
    // it is the caller's to see at startup. The short budget bounds a run that
    // wrongly retries.
    const server = await ownerServer();
    server.echo = null;
    const directory = await temporaryDirectory();
    for (const storeAndForward of [undefined, { directory }]) {
      server.requests.length = 0;
      await expect(
        connectQwpNodeIngress({
          url: server.url,
          ownedBy: OWNER,
          storeAndForward,
          initialConnectMode: "sync",
          reconnect: {
            reconnectMaxDurationMs: 1_000,
            reconnectInitialBackoffMs: 10,
            reconnectMaxBackoffMs: 20,
          },
        }),
      ).rejects.toBeInstanceOf(QwpOwnedByMismatchError);
      expect(server.requests, "the startup must not retry").toHaveLength(1);
    }
  });

  it("names the owner again on every reconnect", async () => {
    // The owner travels in every upgrade, not only in the first one, so the
    // tables auto-created over a re-established connection get it too.
    const server = await ownerServer();
    const session = await connectQwpNodeIngress({
      url: server.url,
      ownedBy: OWNER,
      reconnect: { reconnectInitialBackoffMs: 10, reconnectMaxBackoffMs: 20 },
    });
    try {
      await publishAndWait(session, Uint8Array.of(1), 5_000);
      server.terminateConnections();
      await vi.waitFor(() => expect(server.requests).toHaveLength(2), {
        timeout: 5_000,
      });
      await publishAndWait(session, Uint8Array.of(2), 5_000);
    } finally {
      await session.close();
    }
    expect(new Set(server.requests.map((request) => request.ownedBy))).toEqual(
      new Set([OWNER_ENCODED]),
    );
  });

  it("rides out an unconfirmed owner once a store-and-forward sender has connected", async () => {
    // An endpoint that stops confirming the owner lacks the feature, as one a
    // rolling upgrade has not reached does. A store-and-forward sender that has
    // connected keeps its rows and retries, and delivers them once the owner is
    // confirmed again.
    const server = await ownerServer();
    const directory = await temporaryDirectory();
    const session = await connectQwpNodeIngress({
      url: server.url,
      ownedBy: OWNER,
      storeAndForward: { directory },
      reconnect: { reconnectInitialBackoffMs: 10, reconnectMaxBackoffMs: 20 },
    });
    try {
      await publishAndWait(session, Uint8Array.of(1), 5_000);
      server.echo = null;
      const before = server.requests.length;
      server.terminateConnections();
      await session.publishFrame(Uint8Array.of(2));
      // Several reconnects, each refused for the missing echo.
      await vi.waitFor(
        () => expect(server.requests.length).toBeGreaterThan(before + 2),
        { timeout: 5_000 },
      );
      expect(server.received).not.toContainEqual(Uint8Array.of(2));
      server.echo = "request";
      await vi.waitFor(
        () => expect(server.received).toContainEqual(Uint8Array.of(2)),
        { timeout: 5_000 },
      );
    } finally {
      await session.close();
    }
  });

  it("drains an orphan slot under the owner its adopting sender names", async () => {
    // A drainer connects with the options of the sender that adopted the slot,
    // so the tables the replay auto-creates get that sender's owner too.
    const server = await ownerServer();
    const root = await temporaryDirectory();
    const orphanDirectory = join(root, "ghost");
    const orphan = new QwpNodeFileReplayStore({ directory: orphanDirectory });
    await orphan.load();
    await orphan.append({ frameSequence: 0n, payload: Uint8Array.of(7, 7) });
    await orphan.close();

    const session = await connectQwpNodeIngress({
      url: server.url,
      ownedBy: "team_a",
      senderId: "primary",
      storeAndForward: {
        directory: root,
        drainOrphans: true,
        orphanScanIntervalMs: 0,
      },
    });
    try {
      await vi.waitFor(
        async () => {
          expect(server.received).toContainEqual(Uint8Array.of(7, 7));
          expect(
            (await readdir(orphanDirectory)).filter((name) =>
              name.endsWith(".sfa"),
            ),
          ).toEqual([]);
        },
        { timeout: 5_000 },
      );
    } finally {
      await session.close();
    }
    // The foreground sender's upgrade and the drainer's, in either order.
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(server.requests.map((request) => request.ownedBy))).toEqual(
      new Set(["team_a"]),
    );
  });

  it("never names an owner on a query session", async () => {
    // A query session creates nothing, so a pooled client that names an owner
    // for its senders sends none on /read/v1.
    const server = await ownerServer();
    const client = await connectQwpNodeClient(
      `ws::addr=127.0.0.1:${new URL(server.url).port};owned_by=team_a;sender_pool_min=1;query_pool_min=1;`,
    );
    await client.close();
    expect(
      server.requests
        .map((request) => `${request.path} ${request.ownedBy ?? "-"}`)
        .sort(),
    ).toEqual(["/read/v1 -", "/write/v4 team_a"]);
  });
});
