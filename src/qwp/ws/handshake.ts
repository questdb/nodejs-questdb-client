import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { WRITE_PATH } from "../protocol/constants";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type UpgradeFailureKind = "role-reject" | "auth" | "other";

export class QwpUpgradeError extends Error {
  readonly status: number;
  readonly kind: UpgradeFailureKind;
  /** 421 role rejects retry indefinitely; auth failures never do (spec 6.5.1). */
  readonly retriable: boolean;
  readonly role?: string;

  constructor(status: number, kind: UpgradeFailureKind, message: string, role?: string) {
    super(message);
    this.name = "QwpUpgradeError";
    this.status = status;
    this.kind = kind;
    this.retriable = kind === "role-reject";
    this.role = role;
  }
}

export interface UpgradeResult {
  accept: string;
  qwpVersion?: number;
  maxBatchSize?: number;
  role?: string;
  /** "enabled" when this connection is durable-ack capable (spec 6.5.1). */
  durableAck?: string;
  /** Bytes already received after the header terminator. */
  leftover: Buffer;
}

export function computeAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID, "ascii").digest("base64");
}

export function buildUpgradeRequest(opts: {
  host: string;
  port: number;
  clientId: string;
  authorization?: string;
  requestDurableAck?: boolean;
}): { request: Buffer; key: string } {
  const key = randomBytes(16).toString("base64");
  const lines = [
    `GET ${WRITE_PATH} HTTP/1.1`,
    `Host: ${opts.host}:${opts.port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
    "X-QWP-Max-Version: 1",
    `X-QWP-Client-Id: ${opts.clientId}`,
  ];
  if (opts.authorization) lines.push(`Authorization: ${opts.authorization}`);
  // Durable-ack opt-in. The server echoes X-QWP-Durable-Ack: enabled only when
  // it can back this connection with its durable-ack registry (spec 6.5.1); an
  // opted-in client treats a missing echo as a hard capability gap and fails
  // fast rather than silently running without the durability it asked for.
  if (opts.requestDurableAck) lines.push("X-QWP-Request-Durable-Ack: true");
  return { request: Buffer.from(lines.join("\r\n") + "\r\n\r\n", "ascii"), key };
}

export function parseUpgradeResponse(raw: Buffer): UpgradeResult {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("incomplete HTTP upgrade response");
  const head = raw.subarray(0, end).toString("ascii");
  const leftover = Buffer.from(raw.subarray(end + 4));

  const [statusLine, ...headerLines] = head.split("\r\n");
  const status = Number.parseInt(statusLine.split(" ")[1], 10);

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }

  if (status !== 101) {
    const role = headers.get("x-questdb-role");
    if (status === 421 && role) {
      throw new QwpUpgradeError(status, "role-reject", `node cannot accept writes [role=${role}]`, role);
    }
    if (status === 401 || status === 403) {
      throw new QwpUpgradeError(status, "auth", `authentication failed [status=${status}]`);
    }
    throw new QwpUpgradeError(status, "other", `websocket upgrade failed [status=${status}]`);
  }

  const accept = headers.get("sec-websocket-accept");
  if (!accept) throw new Error("upgrade response missing Sec-WebSocket-Accept");

  const version = headers.get("x-qwp-version");
  const cap = headers.get("x-qwp-max-batch-size");
  return {
    accept,
    qwpVersion: version ? Number.parseInt(version, 10) : undefined,
    maxBatchSize: cap ? Number.parseInt(cap, 10) : undefined,
    role: headers.get("x-questdb-role"),
    durableAck: headers.get("x-qwp-durable-ack"),
    leftover,
  };
}
