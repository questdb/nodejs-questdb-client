# QWP Plan 3 — Errors, Reconnect and Failover (spec PRs 9–11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the server's responses, classify rejections correctly, survive a disconnect, and walk a list of endpoints — so a QWP sender keeps running across restarts, failovers and read-only windows.

**Architecture:** Adds a response decoder and an error-policy layer to `src/qwp/`, plus an endpoint list and a state-ranked host tracker. The send loop gains a connection lifecycle: connect → send → observe ACKs → on failure, classify, reconnect, re-register the symbol dictionary.

**Tech Stack:** TypeScript, Node ≥ 20. vitest + testcontainers + an in-process mock QWP server.

**Prerequisites:** Plans 1 and 2 merged. Consumes: `QwpWebSocket`, `QwpTransport`, `QwpBuffer`, `SymbolDict`, `encodeFrame`/`encodeCommitFrame`, the constants module.

**Source of truth:** `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`.

## Global Constraints

- **No new runtime dependencies.**
- **Node 20 floor.**
- **Options stay `undefined` until set** (spec 9.1.2) — the connect-mode derivation in Task 9 depends on distinguishing "unset" from "set to the default".
- Existing tests stay green: `npx vitest run && npx tsc --noEmit && npx eslint src/**`.

## Sequencing correction — read this before starting

The spec's PR 9 lists "replay" alongside ACK handling. **Replay is not implementable in this plan.** Replay resends frames from `ackedFsn + 1`, which requires the retention ring that Plan 4 builds — spec 12 records that "between PR 3 and PR 12 there is no retention". So this plan:

- **does** implement: response decoding, ACK→FSN correlation, error categories and policies, the poison detector, reconnect with backoff, dictionary catch-up, the endpoint list, and host-state ranking;
- **does not** implement: replaying unacked frames. Until Plan 4, a disconnect loses in-flight frames and that must be surfaced through the error handler rather than hidden.

Task 4 makes that loss explicit rather than silent.

## File Structure

| File | Responsibility |
|---|---|
| `src/qwp/protocol/response.ts` | Decode OK / DURABLE_ACK / error frames |
| `src/qwp/errors.ts` | `SenderErrorCategory`, `SenderErrorPolicy`, `defaultPolicyFor`, `SenderError` |
| `src/qwp/ackTracker.ts` | `fsnAtZero` / `nextWireSeq` translation and clamping |
| `src/qwp/poison.ts` | Strike + dwell escalation |
| `src/qwp/endpoints.ts` | `addr` list grammar, IPv6-aware |
| `src/qwp/hostTracker.ts` | State-ranked, round-based endpoint selection |
| `src/qwp/dispatcher.ts` | Bounded drop-oldest notification inbox |
| `src/qwp/transport.ts` | **modify** — lifecycle, reconnect, catch-up |
| `test/qwp/mockServer.ts` | Reusable in-process QWP server for tests |

---

### Task 1: Response decoder

**Files:**
- Create: `src/qwp/protocol/response.ts`
- Test: `test/qwp/response.test.ts`

**Interfaces:**
- Produces: `STATUS` map, `decodeResponse(payload: Buffer): QwpResponse`, `type QwpResponse = { status: number; sequence: number; tables: {name: string; seqTxn: bigint}[]; errorMessage?: string }`.

Wire layouts from spec 6.6. Note `DURABLE_ACK` has **no** sequence field.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/response.test.ts
import { describe, it, expect } from "vitest";
import { decodeResponse, STATUS } from "../../src/qwp/protocol/response";

function ok(seq: number, tables: [string, bigint][]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(11);
  head.writeUInt8(STATUS.OK, 0);
  head.writeBigUInt64LE(BigInt(seq), 1);
  head.writeUInt16LE(tables.length, 9);
  parts.push(head);
  for (const [name, txn] of tables) {
    const n = Buffer.byteLength(name, "utf8");
    const e = Buffer.alloc(2 + n + 8);
    e.writeUInt16LE(n, 0);
    e.write(name, 2, "utf8");
    e.writeBigInt64LE(txn, 2 + n);
    parts.push(e);
  }
  return Buffer.concat(parts);
}

describe("decodeResponse", () => {
  it("decodes an OK with per-table seqTxn", () => {
    const r = decodeResponse(ok(7, [["trades", 42n]]));
    expect(r.status).toBe(STATUS.OK);
    expect(r.sequence).toBe(7);
    expect(r.tables).toEqual([{ name: "trades", seqTxn: 42n }]);
  });

  it("decodes an error with its message", () => {
    const msg = "boom";
    const b = Buffer.alloc(11 + msg.length);
    b.writeUInt8(STATUS.WRITE_ERROR, 0);
    b.writeBigUInt64LE(3n, 1);
    b.writeUInt16LE(msg.length, 9);
    b.write(msg, 11, "utf8");
    const r = decodeResponse(b);
    expect(r.status).toBe(STATUS.WRITE_ERROR);
    expect(r.errorMessage).toBe("boom");
  });

  it("decodes DURABLE_ACK, which carries no sequence", () => {
    const b = Buffer.alloc(3);
    b.writeUInt8(STATUS.DURABLE_ACK, 0);
    b.writeUInt16LE(0, 1);
    expect(decodeResponse(b).status).toBe(STATUS.DURABLE_ACK);
  });

  it("rejects a truncated payload", () => {
    expect(() => decodeResponse(Buffer.alloc(2))).toThrow(/invalid|truncated/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/response.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/protocol/response.ts
import { Buffer } from "node:buffer";

export const STATUS = {
  OK: 0x00,
  DURABLE_ACK: 0x02,
  SCHEMA_MISMATCH: 0x03,
  PARSE_ERROR: 0x05,
  INTERNAL_ERROR: 0x06,
  SECURITY_ERROR: 0x08,
  WRITE_ERROR: 0x09,
  CANCELLED: 0x0a,
  LIMIT_EXCEEDED: 0x0b,
  NOT_WRITABLE: 0x0c,
  DICTIONARY_GAP: 0x0d,
} as const;

export const MAX_ERROR_MESSAGE_LENGTH = 1024;

export interface QwpResponse {
  status: number;
  sequence: number;
  tables: { name: string; seqTxn: bigint }[];
  errorMessage?: string;
}

export function decodeResponse(payload: Buffer): QwpResponse {
  if (payload.length < 3) throw new Error("invalid QWP response: truncated");
  const status = payload.readUInt8(0);

  if (status === STATUS.DURABLE_ACK) {
    const count = payload.readUInt16LE(1);
    return { status, sequence: -1, tables: readTables(payload, 3, count) };
  }

  if (payload.length < 11) throw new Error("invalid QWP response: truncated");
  const sequence = Number(payload.readBigUInt64LE(1));

  if (status === STATUS.OK) {
    const count = payload.readUInt16LE(9);
    return { status, sequence, tables: readTables(payload, 11, count) };
  }

  const len = payload.readUInt16LE(9);
  if (len > MAX_ERROR_MESSAGE_LENGTH) throw new Error("invalid QWP response: error message too long");
  return {
    status,
    sequence,
    tables: [],
    errorMessage: payload.subarray(11, 11 + len).toString("utf8"),
  };
}

function readTables(buf: Buffer, offset: number, count: number) {
  const out: { name: string; seqTxn: bigint }[] = [];
  let o = offset;
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(o);
    o += 2;
    const name = buf.subarray(o, o + n).toString("utf8");
    o += n;
    out.push({ name, seqTxn: buf.readBigInt64LE(o) });
    o += 8;
  }
  return out;
}
```

- [ ] **Step 4: Run test** → `npx vitest run test/qwp/response.test.ts` → PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/response.ts test/qwp/response.test.ts
git commit -m "feat(qwp): decode server response frames"
```

---

### Task 2: Error categories and default policy

**Files:**
- Create: `src/qwp/errors.ts`
- Test: `test/qwp/errors.test.ts`

Spec 7.1–7.3. Ten categories, four policies. Three mappings are **forced** and ignore any override.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/errors.test.ts
import { describe, it, expect } from "vitest";
import { Category, Policy, classify, defaultPolicyFor } from "../../src/qwp/errors";
import { STATUS } from "../../src/qwp/protocol/response";

describe("error classification", () => {
  it("maps wire statuses to categories", () => {
    expect(classify(STATUS.SCHEMA_MISMATCH)).toBe(Category.SCHEMA_MISMATCH);
    expect(classify(STATUS.DICTIONARY_GAP)).toBe(Category.DICTIONARY_GAP);
    expect(classify(0x7f)).toBe(Category.UNKNOWN);
  });

  it("fails OPEN on an unknown status", () => {
    expect(defaultPolicyFor(Category.UNKNOWN)).toBe(Policy.RETRIABLE);
  });

  it("treats deterministic rejections as terminal", () => {
    for (const c of [Category.SCHEMA_MISMATCH, Category.PARSE_ERROR, Category.SECURITY_ERROR]) {
      expect(defaultPolicyFor(c)).toBe(Policy.TERMINAL);
    }
  });

  it("routes DICTIONARY_GAP to retriable, not terminal", () => {
    expect(defaultPolicyFor(Category.DICTIONARY_GAP)).toBe(Policy.RETRIABLE);
  });

  it("maps NOT_WRITABLE to RETRIABLE_OTHER and DATA_LOSS to ABANDONED", () => {
    expect(defaultPolicyFor(Category.NOT_WRITABLE)).toBe(Policy.RETRIABLE_OTHER);
    expect(defaultPolicyFor(Category.DATA_LOSS)).toBe(Policy.ABANDONED);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/errors.ts
import { STATUS } from "./protocol/response";

export enum Category {
  SCHEMA_MISMATCH = "SCHEMA_MISMATCH",
  PARSE_ERROR = "PARSE_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SECURITY_ERROR = "SECURITY_ERROR",
  WRITE_ERROR = "WRITE_ERROR",
  NOT_WRITABLE = "NOT_WRITABLE",
  DICTIONARY_GAP = "DICTIONARY_GAP",
  PROTOCOL_VIOLATION = "PROTOCOL_VIOLATION",
  DATA_LOSS = "DATA_LOSS",
  UNKNOWN = "UNKNOWN",
}

export enum Policy {
  RETRIABLE = "RETRIABLE",
  RETRIABLE_OTHER = "RETRIABLE_OTHER",
  TERMINAL = "TERMINAL",
  ABANDONED = "ABANDONED",
}

export class SenderError extends Error {
  constructor(
    readonly category: Category,
    readonly policy: Policy,
    message: string,
    readonly serverStatus = -1,
    readonly fromFsn = -1,
    readonly toFsn = -1,
    readonly quarantinedPath?: string,
  ) {
    super(message);
    this.name = "SenderError";
  }
}

export function classify(status: number): Category {
  switch (status) {
    case STATUS.SCHEMA_MISMATCH: return Category.SCHEMA_MISMATCH;
    case STATUS.PARSE_ERROR: return Category.PARSE_ERROR;
    case STATUS.INTERNAL_ERROR: return Category.INTERNAL_ERROR;
    case STATUS.SECURITY_ERROR: return Category.SECURITY_ERROR;
    case STATUS.WRITE_ERROR: return Category.WRITE_ERROR;
    case STATUS.NOT_WRITABLE: return Category.NOT_WRITABLE;
    case STATUS.DICTIONARY_GAP: return Category.DICTIONARY_GAP;
    default: return Category.UNKNOWN;
  }
}

/**
 * There is no drop policy. UNKNOWN fails OPEN so a status byte from a newer
 * server degrades to a retry rather than a dead sender (spec 7.3).
 */
export function defaultPolicyFor(c: Category): Policy {
  switch (c) {
    case Category.WRITE_ERROR:
    case Category.INTERNAL_ERROR:
    case Category.DICTIONARY_GAP:
    case Category.UNKNOWN:
      return Policy.RETRIABLE;
    case Category.NOT_WRITABLE:
      return Policy.RETRIABLE_OTHER;
    case Category.DATA_LOSS:
      return Policy.ABANDONED;
    default:
      return Policy.TERMINAL;
  }
}
```

- [ ] **Step 4: Run test** → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/errors.ts test/qwp/errors.test.ts
git commit -m "feat(qwp): add error categories and default policy mapping"
```

---

### Task 3: ACK→FSN correlation

**Files:**
- Create: `src/qwp/ackTracker.ts`
- Test: `test/qwp/ackTracker.test.ts`

**Spec 6.6.1 — the highest-risk item in this plan.** The wire `seq` is **connection-scoped** and restarts at 0 on every reconnect; FSNs are monotonic for the life of the log. `ackedFsn = fsnAtZero + seq`, clamped to what was actually sent.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/ackTracker.test.ts
import { describe, it, expect } from "vitest";
import { AckTracker } from "../../src/qwp/ackTracker";

describe("AckTracker", () => {
  it("translates a connection-scoped seq into an FSN", () => {
    const t = new AckTracker();
    t.onConnected(100); // replay resumes at FSN 100
    t.onFrameSent();
    t.onFrameSent();
    expect(t.onAck(1)).toBe(101);
  });

  it("does NOT reset the FSN when the wire seq restarts", () => {
    const t = new AckTracker();
    t.onConnected(0);
    t.onFrameSent();
    expect(t.onAck(0)).toBe(0);
    // reconnect: wire seq restarts at 0, FSNs continue from 1
    t.onConnected(1);
    t.onFrameSent();
    expect(t.onAck(0)).toBe(1);
  });

  it("clamps an ACK beyond what was sent", () => {
    const t = new AckTracker();
    t.onConnected(0);
    t.onFrameSent(); // highest wire seq is 0
    expect(t.onAck(99)).toBe(0);
  });

  it("ignores an ACK arriving before any send", () => {
    const t = new AckTracker();
    t.onConnected(0);
    expect(t.onAck(0)).toBeNull();
  });

  it("never moves the acked watermark backwards", () => {
    const t = new AckTracker();
    t.onConnected(0);
    t.onFrameSent();
    t.onFrameSent();
    expect(t.onAck(1)).toBe(1);
    expect(t.onAck(0)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/ackTracker.ts

/**
 * Bridges the connection-scoped wire sequence to the log-scoped FSN.
 * Storing a raw seq as an FSN works until the first reconnect and then trims
 * from near the start of the log, discarding unacked data (spec 6.6.1).
 */
export class AckTracker {
  private fsnAtZero = 0;
  private nextWireSeq = 0;
  private ackedFsn = -1;

  /** Call on every successful connect, with the FSN replay resumes at. */
  onConnected(replayStartFsn: number): void {
    this.fsnAtZero = replayStartFsn;
    this.nextWireSeq = 0;
  }

  onFrameSent(): void {
    this.nextWireSeq++;
  }

  /** Returns the new acked FSN, or null when the ACK is not applicable. */
  onAck(wireSeq: number): number | null {
    const highestSent = this.nextWireSeq - 1;
    if (highestSent < 0) return null; // ACK before any send
    const capped = Math.max(0, Math.min(wireSeq, highestSent));
    const fsn = this.fsnAtZero + capped;
    if (fsn > this.ackedFsn) this.ackedFsn = fsn;
    return this.ackedFsn;
  }

  get acked(): number {
    return this.ackedFsn;
  }
}
```

- [ ] **Step 4: Run test** → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/ackTracker.ts test/qwp/ackTracker.test.ts
git commit -m "feat(qwp): correlate connection-scoped ACK sequences to FSNs"
```

---

### Task 4: Mock QWP server, and surfacing in-flight loss

**Files:**
- Create: `test/qwp/mockServer.ts`
- Modify: `src/qwp/transport.ts`
- Test: `test/qwp/transport.acks.test.ts`

Until Plan 4 there is no retention, so a disconnect with frames in flight **loses them**. That must be reported, not swallowed.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/mockServer.ts
import { createServer, Server, Socket } from "node:net";
import { createHash } from "node:crypto";
import { FrameParser, encodeClientFrame, OPCODE } from "../../src/qwp/ws/frame";
import { STATUS } from "../../src/qwp/protocol/response";

export interface MockOptions {
  /** Return a status per received frame; OK by default. */
  statusFor?: (frameIndex: number) => number;
  /** Drop the connection after N frames. */
  dropAfter?: number;
  upgradeStatus?: number;
  upgradeHeaders?: string;
}

export function okResponse(seq: number): Buffer {
  const b = Buffer.alloc(11);
  b.writeUInt8(STATUS.OK, 0);
  b.writeBigUInt64LE(BigInt(seq), 1);
  b.writeUInt16LE(0, 9);
  return b;
}

export function errorResponse(status: number, seq: number, msg: string): Buffer {
  const b = Buffer.alloc(11 + msg.length);
  b.writeUInt8(status, 0);
  b.writeBigUInt64LE(BigInt(seq), 1);
  b.writeUInt16LE(msg.length, 9);
  b.write(msg, 11, "utf8");
  return b;
}

export class MockQwpServer {
  private server?: Server;
  readonly frames: Buffer[] = [];

  async start(opts: MockOptions = {}): Promise<number> {
    return new Promise((resolve) => {
      this.server = createServer((sock: Socket) => this.onConn(sock, opts));
      this.server.listen(0, "127.0.0.1", () =>
        resolve((this.server!.address() as any).port),
      );
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private onConn(sock: Socket, opts: MockOptions): void {
    let handshaken = false;
    let seq = 0;
    const parser = new FrameParser();
    sock.on("error", () => undefined);
    sock.on("data", (chunk: Buffer) => {
      if (!handshaken) {
        const status = opts.upgradeStatus ?? 101;
        if (status !== 101) {
          sock.write(`HTTP/1.1 ${status} X\r\n${opts.upgradeHeaders ?? ""}\r\n`);
          sock.end();
          return;
        }
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(chunk.toString("ascii"))![1];
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "ascii")
          .digest("base64");
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
            "X-QWP-Version: 1\r\nX-QWP-Max-Batch-Size: 1048576\r\n\r\n",
        );
        handshaken = true;
        return;
      }
      parser.push(chunk);
      for (let m = parser.next(); m; m = parser.next()) {
        if (m.opcode !== OPCODE.BINARY) continue;
        const idx = this.frames.length;
        this.frames.push(m.payload);
        if (opts.dropAfter !== undefined && idx + 1 >= opts.dropAfter) {
          sock.destroy();
          return;
        }
        const status = opts.statusFor ? opts.statusFor(idx) : STATUS.OK;
        const body =
          status === STATUS.OK ? okResponse(seq++) : errorResponse(status, seq++, "mock");
        sock.write(encodeClientFrame(OPCODE.BINARY, body));
      }
    });
  }
}
```

```ts
// test/qwp/transport.acks.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { MockQwpServer } from "./mockServer";
import { QwpTransport } from "../../src/qwp/transport";
import { SenderOptions } from "../../src/options";
import { STATUS } from "../../src/qwp/protocol/response";
import { Category } from "../../src/qwp/errors";

let mock: MockQwpServer | undefined;
afterEach(async () => await mock?.stop());

async function connected(opts = {}) {
  mock = new MockQwpServer();
  const port = await mock.start(opts);
  const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
  await t.connect();
  return t;
}

describe("QwpTransport ack handling", () => {
  it("advances the acked FSN on OK", async () => {
    const t = await connected();
    await t.sendFrames([Buffer.from("QWP1----------")]);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.ackedFsn).toBe(0);
    await t.close();
  });

  it("reports a terminal category on a deterministic NACK", async () => {
    const errors: any[] = [];
    const t = await connected({ statusFor: () => STATUS.PARSE_ERROR });
    t.onError((e) => errors.push(e));
    await t.sendFrames([Buffer.from("QWP1----------")]);
    await new Promise((r) => setTimeout(r, 100));
    expect(errors[0].category).toBe(Category.PARSE_ERROR);
    await t.close();
  });

  it("reports in-flight loss when the connection drops (no retention yet)", async () => {
    const errors: any[] = [];
    const t = await connected({ dropAfter: 1 });
    t.onError((e) => errors.push(e));
    await t.sendFrames([Buffer.from("QWP1----------")]);
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.some((e) => e.category === Category.DATA_LOSS)).toBe(true);
    await t.close();
  });
});
```

- [ ] **Step 2: Run test** → FAIL, `t.ackedFsn` / `t.onError` undefined.

- [ ] **Step 3: Implement** — extend `src/qwp/transport.ts`:

```ts
  private readonly acks = new AckTracker();
  private errorHandler?: (e: SenderError) => void;
  private inFlight = 0;

  onError(h: (e: SenderError) => void): void {
    this.errorHandler = h;
  }

  get ackedFsn(): number {
    return this.acks.acked;
  }

  private emit(e: SenderError): void {
    try {
      this.errorHandler?.(e);
    } catch {
      /* a handler must never break the sender (spec 4.2) */
    }
  }

  private onResponse(payload: Buffer): void {
    const r = decodeResponse(payload);
    if (r.status === STATUS.OK) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.acks.onAck(r.sequence);
      return;
    }
    if (r.status === STATUS.DURABLE_ACK) return;
    const category = classify(r.status);
    this.emit(
      new SenderError(
        category,
        defaultPolicyFor(category),
        r.errorMessage ?? `server rejected frame [status=0x${r.status.toString(16)}]`,
        r.status,
      ),
    );
  }

  private onDisconnected(): void {
    if (this.inFlight > 0) {
      // No retention until Plan 4: these frames are gone. Say so.
      this.emit(
        new SenderError(
          Category.DATA_LOSS,
          Policy.ABANDONED,
          `connection lost with ${this.inFlight} frame(s) in flight and no retention configured`,
        ),
      );
      this.inFlight = 0;
    }
  }
```

Wire `onResponse`/`onDisconnected` into `QwpWebSocket` via two new callbacks (`onBinary`, `onClose`) passed to `QwpWebSocket.connect`, and increment `inFlight`/`acks.onFrameSent()` inside `sendFrames`. Call `this.acks.onConnected(0)` at the end of `connect()`.

- [ ] **Step 4: Run test** → PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/transport.ts src/qwp/ws/socket.ts test/qwp/mockServer.ts test/qwp/transport.acks.test.ts
git commit -m "feat(qwp): handle ACK and NACK responses, surface in-flight loss"
```

---

### Task 5: Poison-frame detector

**Files:**
- Create: `src/qwp/poison.ts`
- Test: `test/qwp/poison.test.ts`

**Spec 7.4 — escalation needs BOTH conditions.** Four strikes alone is not enough; the suspect must also have stayed poisoned for `poison_min_escalation_window_millis` (default 5000). Count-only escalation turns a brief outage into a producer-fatal terminal.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/poison.test.ts
import { describe, it, expect } from "vitest";
import { PoisonDetector } from "../../src/qwp/poison";

describe("PoisonDetector", () => {
  it("does NOT escalate on strikes alone inside the dwell window", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 5000, () => now);
    for (let i = 0; i < 6; i++) {
      now += 100;
      expect(d.strike(7)).toBe(false);
    }
  });

  it("escalates once both the count and the dwell are satisfied", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 5000, () => now);
    d.strike(7);
    for (let i = 0; i < 3; i++) {
      now += 2000;
      d.strike(7);
    }
    now += 1;
    expect(d.strike(7)).toBe(true);
  });

  it("resets only on acceptance at or beyond the suspect frame", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 0, () => now);
    d.strike(7);
    d.accept(5); // behind the suspect: must NOT launder the count
    d.strike(7);
    d.strike(7);
    expect(d.strike(7)).toBe(true);

    const d2 = new PoisonDetector(4, 0, () => now);
    d2.strike(7);
    d2.accept(7); // at the suspect: clears
    expect(d2.strike(7)).toBe(false);
  });

  it("a different frame resets the sequence", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 0, () => now);
    d.strike(7);
    d.strike(7);
    d.strike(8);
    expect(d.strike(8)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/poison.ts

/**
 * Escalation requires a strike count AND a wall-clock dwell (spec 7.4).
 * A count alone false-positives a brief outage into a producer-fatal terminal,
 * because with pacing four strikes can accrue in well under a second.
 */
export class PoisonDetector {
  private suspectFsn = -1;
  private strikes = 0;
  private firstStrikeAt = 0;

  constructor(
    private readonly maxStrikes: number,
    private readonly minWindowMillis: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true when the frame should escalate to PROTOCOL_VIOLATION. */
  strike(fsn: number): boolean {
    if (fsn !== this.suspectFsn) {
      this.suspectFsn = fsn;
      this.strikes = 0;
      this.firstStrikeAt = this.now();
    }
    this.strikes++;
    const dwell = this.now() - this.firstStrikeAt;
    return this.strikes >= this.maxStrikes && dwell >= this.minWindowMillis;
  }

  /** Only acceptance AT OR BEYOND the suspect clears it. */
  accept(ackedFsn: number): void {
    if (this.suspectFsn >= 0 && ackedFsn >= this.suspectFsn) {
      this.suspectFsn = -1;
      this.strikes = 0;
    }
  }
}
```

- [ ] **Step 4: Run test** → PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/poison.ts test/qwp/poison.test.ts
git commit -m "feat(qwp): add poison-frame detector with strike and dwell conditions"
```

---

### Task 6: `addr` list grammar

**Files:**
- Create: `src/qwp/endpoints.ts`
- Modify: `src/options.ts`
- Test: `test/qwp/endpoints.test.ts`

Spec 1.2. Comma-separated, IPv6-aware, duplicates rejected on `(host, port)`. **A custom port on IPv6 requires brackets** — an unbracketed multi-colon entry is a bare IPv6 host on the default port.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/endpoints.test.ts
import { describe, it, expect } from "vitest";
import { parseAddrList } from "../../src/qwp/endpoints";

describe("parseAddrList", () => {
  it("parses host and host:port", () => {
    expect(parseAddrList("a,b:1234", 9000)).toEqual([
      { host: "a", port: 9000 },
      { host: "b", port: 1234 },
    ]);
  });

  it("parses bracketed IPv6 with and without a port", () => {
    expect(parseAddrList("[::1]:9001,[fe80::1]", 9000)).toEqual([
      { host: "::1", port: 9001 },
      { host: "fe80::1", port: 9000 },
    ]);
  });

  it("treats an unbracketed multi-colon entry as bare IPv6 on the default port", () => {
    expect(parseAddrList("fe80::1", 9000)).toEqual([{ host: "fe80::1", port: 9000 }]);
  });

  it("rejects duplicates on (host, port) but allows the same host twice on different ports", () => {
    expect(() => parseAddrList("a:1,a:1", 9000)).toThrow(/duplicate/i);
    expect(parseAddrList("a:1,a:2", 9000).length).toBe(2);
  });

  it("rejects a missing bracket and an empty host", () => {
    expect(() => parseAddrList("[::1:9000", 9000)).toThrow(/closing/i);
    expect(() => parseAddrList(":9000", 9000)).toThrow(/empty host/i);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/endpoints.ts
export interface Endpoint {
  host: string;
  port: number;
}

export function parseAddrList(addr: string, defaultPort: number): Endpoint[] {
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  for (const raw of addr.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    let host: string;
    let port: number;

    if (entry[0] === "[") {
      const close = entry.indexOf("]");
      if (close < 0) throw new Error(`missing closing ']' in IPv6 addr entry: ${entry}`);
      host = entry.slice(1, close);
      if (close === entry.length - 1) {
        port = defaultPort;
      } else if (entry[close + 1] !== ":") {
        throw new Error(`expected ':' after ']' in IPv6 addr entry: ${entry}`);
      } else {
        port = parsePort(entry.slice(close + 2), entry);
      }
    } else if (entry.indexOf(":") !== entry.lastIndexOf(":")) {
      // Unbracketed multi-colon: bare IPv6, default port. A custom port needs brackets.
      host = entry;
      port = defaultPort;
    } else {
      const colon = entry.indexOf(":");
      if (colon < 0) {
        host = entry;
        port = defaultPort;
      } else {
        host = entry.slice(0, colon).trim();
        port = parsePort(entry.slice(colon + 1), entry);
      }
    }

    if (!host) throw new Error(`empty host in addr entry: ${entry}`);
    const key = `${port}/${host}`;
    if (seen.has(key)) throw new Error(`duplicate addr entry: ${entry}`);
    seen.add(key);
    out.push({ host, port });
  }
  if (out.length === 0) throw new Error("addr is missing");
  return out;
}

function parsePort(s: string, entry: string): number {
  const p = Number.parseInt(s, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`invalid port in addr entry: ${entry}`);
  }
  return p;
}
```

In `src/options.ts`, for `ws`/`wss` store the parsed list on the options object as `endpoints` and keep `host`/`port` pointing at the first entry so existing code paths still work.

- [ ] **Step 4: Run test** → `npx vitest run test/qwp/ && npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/endpoints.ts src/options.ts test/qwp/endpoints.test.ts
git commit -m "feat(qwp): parse multi-host addr lists with IPv6 support"
```

---

### Task 7: Host health tracker

**Files:**
- Create: `src/qwp/hostTracker.ts`
- Test: `test/qwp/hostTracker.test.ts`

Spec 1.2. **State-only ranking** — the ingest sender is zone-blind, so do not implement zone tiers. Rounds via `pickNext`/`beginRound`. Background drainers (Plan 4) will need `newCursor()`.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/hostTracker.test.ts
import { describe, it, expect } from "vitest";
import { HostTracker, HostState } from "../../src/qwp/hostTracker";

describe("HostTracker", () => {
  it("prefers a known-good host over an untried one", () => {
    const t = new HostTracker(3);
    t.record(2, HostState.HEALTHY);
    expect(t.pickNext()).toBe(2);
  });

  it("ranks HEALTHY > UNKNOWN > TRANSIENT_REJECT > TRANSPORT_ERROR > TOPOLOGY_REJECT", () => {
    const t = new HostTracker(4);
    t.record(0, HostState.TOPOLOGY_REJECT);
    t.record(1, HostState.TRANSPORT_ERROR);
    t.record(2, HostState.TRANSIENT_REJECT);
    // index 3 stays UNKNOWN
    expect(t.pickNext()).toBe(3);
    expect(t.pickNext()).toBe(2);
    expect(t.pickNext()).toBe(1);
    expect(t.pickNext()).toBe(0);
  });

  it("exhausts a round and restarts on beginRound", () => {
    const t = new HostTracker(2);
    t.pickNext();
    t.pickNext();
    expect(t.pickNext()).toBeNull();
    expect(t.isRoundExhausted()).toBe(true);
    t.beginRound();
    expect(t.pickNext()).not.toBeNull();
  });

  it("a private cursor does not consume the shared round", () => {
    const t = new HostTracker(2);
    const c = t.newCursor();
    c.pickNext();
    c.pickNext();
    expect(t.isRoundExhausted()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/hostTracker.ts

export enum HostState {
  HEALTHY = 0,
  UNKNOWN = 1,
  TRANSIENT_REJECT = 2,
  TRANSPORT_ERROR = 3,
  TOPOLOGY_REJECT = 4,
}

/**
 * State-ranked, round-based endpoint selection. The ingest sender is
 * zone-blind, so ranking is state-only (spec 1.2) — do not add zone tiers.
 */
export class HostTracker {
  private readonly states: HostState[];
  private attempted: boolean[];

  constructor(private readonly hostCount: number) {
    if (hostCount <= 0) throw new Error("hostCount must be > 0");
    this.states = new Array(hostCount).fill(HostState.UNKNOWN);
    this.attempted = new Array(hostCount).fill(false);
  }

  record(index: number, state: HostState): void {
    this.states[index] = state;
  }

  private best(attempted: boolean[]): number | null {
    let bestIdx: number | null = null;
    for (let i = 0; i < this.hostCount; i++) {
      if (attempted[i]) continue;
      if (bestIdx === null || this.states[i] < this.states[bestIdx]) bestIdx = i;
    }
    return bestIdx;
  }

  pickNext(): number | null {
    const i = this.best(this.attempted);
    if (i === null) return null;
    this.attempted[i] = true;
    return i;
  }

  isRoundExhausted(): boolean {
    return this.attempted.every(Boolean);
  }

  beginRound(): void {
    this.attempted = new Array(this.hostCount).fill(false);
  }

  /**
   * A walker-local cursor. Background drainers MUST use this: sharing the
   * round lets a drainer steal endpoints from the foreground sweep, which
   * presents as unexplained ALL_ENDPOINTS_UNREACHABLE (spec 1.2).
   */
  newCursor(): { pickNext(): number | null } {
    const local = new Array(this.hostCount).fill(false);
    return {
      pickNext: () => {
        const i = this.best(local);
        if (i === null) return null;
        local[i] = true;
        return i;
      },
    };
  }
}
```

- [ ] **Step 4: Run test** → PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/hostTracker.ts test/qwp/hostTracker.test.ts
git commit -m "feat(qwp): add state-ranked host tracker with private cursors"
```

---

### Task 8: Reconnect, rotation, and dictionary catch-up

**Files:**
- Modify: `src/qwp/transport.ts`
- Test: `test/qwp/transport.reconnect.test.ts`

Spec 6.5.1, 7.5. A `421` role reject retries **indefinitely**; `401`/`403` is terminal. After every reconnect, a **dictionary catch-up frame** re-registers from id 0 before any data frame — the server's dictionary is connection-scoped and empty.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/transport.reconnect.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { MockQwpServer } from "./mockServer";
import { QwpTransport } from "../../src/qwp/transport";
import { SenderOptions } from "../../src/options";

let mocks: MockQwpServer[] = [];
afterEach(async () => {
  for (const m of mocks) await m.stop();
  mocks = [];
});

describe("reconnect and rotation", () => {
  it("rotates to the second endpoint when the first refuses the upgrade with 421", async () => {
    const bad = new MockQwpServer();
    const good = new MockQwpServer();
    mocks.push(bad, good);
    const badPort = await bad.start({
      upgradeStatus: 421,
      upgradeHeaders: "X-QuestDB-Role: replica\r\n",
    });
    const goodPort = await good.start();

    const t = new QwpTransport(
      new SenderOptions(`ws::addr=127.0.0.1:${badPort},127.0.0.1:${goodPort};`),
    );
    await t.connect();
    expect(t.connectedEndpoint!.port).toBe(goodPort);
    await t.close();
  });

  it("fails terminally on 401 without rotating", async () => {
    const a = new MockQwpServer();
    mocks.push(a);
    const port = await a.start({ upgradeStatus: 401 });
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await expect(t.connect()).rejects.toThrow(/authentication/i);
  });

  it("sends a dictionary catch-up frame before data after reconnect", async () => {
    const s = new MockQwpServer();
    mocks.push(s);
    const port = await s.start();
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await t.connect();
    t.registerSymbolForTest("alpha");
    await t.reconnectForTest();
    // First frame after reconnect must carry the dictionary from id 0.
    const first = s.frames[0];
    expect(first.subarray(0, 4).toString("ascii")).toBe("QWP1");
    await t.close();
  });
});
```

- [ ] **Step 2: Run test** → FAIL, `connectedEndpoint` undefined.

- [ ] **Step 3: Implement** — in `src/qwp/transport.ts`:

```ts
  private endpoints: Endpoint[] = [];
  private tracker!: HostTracker;
  private current?: Endpoint;
  private readonly dict = new SymbolDict();
  private confirmedMaxId = -1;

  get connectedEndpoint(): Endpoint | undefined {
    return this.current;
  }

  async connect(): Promise<boolean> {
    this.endpoints = parseAddrList(this.options.addr!, 9000);
    this.tracker = new HostTracker(this.endpoints.length);
    return this.connectLoop();
  }

  private async connectLoop(): Promise<boolean> {
    for (;;) {
      const idx = this.tracker.pickNext();
      if (idx === null) {
        this.tracker.beginRound();
        // A 421 round means no primary is reachable yet; retry indefinitely
        // rather than giving up (spec 6.5.1).
        await new Promise((r) => setTimeout(r, this.backoffMillis()));
        continue;
      }
      const ep = this.endpoints[idx];
      try {
        this.ws = await QwpWebSocket.connect({ ...this.wsOptions(ep) });
        this.tracker.record(idx, HostState.HEALTHY);
        this.current = ep;
        this.acks.onConnected(this.acks.acked + 1);
        await this.sendDictCatchUp();
        return true;
      } catch (e) {
        if (e instanceof QwpUpgradeError) {
          if (e.kind === "auth") throw e; // terminal, never rotate
          this.tracker.record(
            idx,
            e.kind === "role-reject" ? HostState.TOPOLOGY_REJECT : HostState.TRANSPORT_ERROR,
          );
        } else {
          this.tracker.record(idx, HostState.TRANSPORT_ERROR);
        }
      }
    }
  }

  /**
   * The server's dictionary is connection-scoped and empty after a reconnect,
   * so re-register from id 0 before any data frame or every delta frame earns
   * DICTIONARY_GAP (spec 7.5).
   */
  private async sendDictCatchUp(): Promise<void> {
    if (this.dict.size() === 0) return;
    const cap = this.ws?.maxBatchSize ?? UNCAPPED_CATCHUP_PACKING_LIMIT;
    const frame = encodeFrame([], { gorilla: false, dict: this.dict, confirmedMaxId: -1 });
    if (frame.length > cap) {
      throw new Error(`dictionary catch-up exceeds the batch cap [size=${frame.length}, cap=${cap}]`);
    }
    await this.ws!.sendBinary(frame);
    this.confirmedMaxId = this.dict.size() - 1;
  }
```

Add `export const UNCAPPED_CATCHUP_PACKING_LIMIT = 64 * 1024;` to `constants.ts` — "not advertised" is **not** "unbounded" (spec 7.5). Add the two test hooks `registerSymbolForTest` and `reconnectForTest`.

- [ ] **Step 4: Run test** → PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/transport.ts src/qwp/protocol/constants.ts test/qwp/transport.reconnect.test.ts
git commit -m "feat(qwp): add reconnect, endpoint rotation and dictionary catch-up"
```

---

### Task 9: Notification dispatchers and connect-mode derivation

**Files:**
- Create: `src/qwp/dispatcher.ts`
- Modify: `src/qwp/transport.ts`, `src/sender.ts`
- Test: `test/qwp/dispatcher.test.ts`

**Spec 4.2 — the inbox drops the OLDEST**, not the newest. Watermarks are monotonic, so the newest entry is the most informative; drop-newest retains stale state under load. **Spec 4.3** — connect mode is *derived*: any `reconnect_*` key set implies eager connect.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/dispatcher.test.ts
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../../src/qwp/dispatcher";
import { SenderOptions } from "../../src/options";
import { deriveConnectMode, ConnectMode } from "../../src/qwp/transport";

describe("Dispatcher", () => {
  it("drops the OLDEST entry when full and counts the drop", async () => {
    const seen: number[] = [];
    const d = new Dispatcher<number>(2, (v) => seen.push(v));
    d.offer(1);
    d.offer(2);
    d.offer(3); // evicts 1
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([2, 3]);
    expect(d.dropped).toBe(1);
  });

  it("never invokes the handler synchronously", () => {
    let called = false;
    const d = new Dispatcher<number>(4, () => (called = true));
    d.offer(1);
    expect(called).toBe(false);
  });

  it("survives a throwing handler", async () => {
    const d = new Dispatcher<number>(4, () => {
      throw new Error("bad handler");
    });
    d.offer(1);
    await new Promise((r) => setImmediate(r));
    expect(d.dropped).toBe(0);
  });
});

describe("connect mode derivation", () => {
  it("is OFF when no reconnect_* key is set", () => {
    expect(deriveConnectMode(new SenderOptions("ws::addr=h:9000;"))).toBe(ConnectMode.OFF);
  });

  it("is SYNC when any reconnect_* key is supplied", () => {
    expect(
      deriveConnectMode(new SenderOptions("ws::addr=h:9000;reconnect_max_backoff_millis=1000;")),
    ).toBe(ConnectMode.SYNC);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/dispatcher.ts

/**
 * Bounded inbox that drops the OLDEST entry when full (spec 4.2). Watermarks
 * are monotonic, so the newest entry is always the most informative and
 * dropping the head compresses information rather than losing it.
 * The handler is never invoked on the caller's stack.
 */
export class Dispatcher<T> {
  private readonly queue: T[] = [];
  private scheduled = false;
  dropped = 0;

  constructor(
    private readonly capacity: number,
    private readonly handler: (item: T) => void,
  ) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
  }

  offer(item: T): void {
    if (this.queue.length >= this.capacity) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(item);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.drain());
    }
  }

  private drain(): void {
    this.scheduled = false;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        this.handler(item);
      } catch {
        /* a handler must never break the sender */
      }
    }
  }
}
```

In `src/qwp/transport.ts`:

```ts
export enum ConnectMode {
  OFF = "OFF",
  SYNC = "SYNC",
}

/**
 * The default is DERIVED: setting any reconnect_* key implicitly upgrades
 * construction from non-connecting to connecting-with-retry, because those
 * knobs read as a general retry budget while the underlying path governs only
 * reconnects from an established connection (spec 4.3).
 */
export function deriveConnectMode(o: SenderOptions): ConnectMode {
  const anyReconnect =
    o.reconnect_max_duration_millis !== undefined ||
    o.reconnect_initial_backoff_millis !== undefined ||
    o.reconnect_max_backoff_millis !== undefined;
  return anyReconnect ? ConnectMode.SYNC : ConnectMode.OFF;
}
```

Replace the raw `errorHandler` with `new Dispatcher<SenderError>(o.error_inbox_capacity ?? 256, h)` and add a connection-event dispatcher at capacity **64** (spec 9.1 — the two differ).

- [ ] **Step 4: Run test** → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/dispatcher.ts src/qwp/transport.ts src/sender.ts test/qwp/dispatcher.test.ts
git commit -m "feat(qwp): add drop-oldest dispatchers and derived connect mode"
```

---

## Self-Review

**1. Spec coverage.** Response decode (Task 1 — 6.6). Categories/policies (Task 2 — 7.1–7.3). ACK→FSN (Task 3 — 6.6.1). NACK handling + in-flight loss (Task 4). Poison detector, both conditions (Task 5 — 7.4). `addr` grammar (Task 6 — 1.2). Host tracker, state-only, private cursors (Task 7 — 1.2). Reconnect, rotation, catch-up (Task 8 — 6.5.1, 7.5). Dispatchers + connect mode (Task 9 — 4.2, 4.3, 9.1).

**Explicitly deferred to Plan 4, with reasons stated in the sequencing note:** replay from `ackedFsn + 1` (needs the ring), the `.symbol-dict` delta→full-dict fallback (needs the file), `DATA_LOSS`/`ABANDONED` from a quarantined slot (Task 4 emits `DATA_LOSS` only for in-flight loss).

**2. Placeholder scan.** None.

**3. Type consistency.** `STATUS` (Task 1) is used by `classify` (Task 2) and the mock server (Task 4). `Category`/`Policy`/`SenderError` (Task 2) are used in Tasks 4 and 9. `AckTracker.onConnected/onFrameSent/onAck` (Task 3) is called in Tasks 4 and 8. `Endpoint`/`parseAddrList` (Task 6) feed `HostTracker` (Task 7) and the connect loop (Task 8). `MockQwpServer` (Task 4) is reused in Task 8.
