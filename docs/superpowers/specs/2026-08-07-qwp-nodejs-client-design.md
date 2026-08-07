# QWP ingest for the QuestDB Node.js client — design

Date: 2026-08-07
Status: approved, ready for implementation planning
Target repo: `questdb/nodejs-questdb-client` (`@questdb/nodejs-client`, currently 4.2.0)

## 1. Goal

Add QuestDB Wire Protocol (QWP) **ingest** over `ws://` / `wss://` to the Node.js
client, reaching functional parity with the Java client's ingest path, including
full store-and-forward.

Today the Node client speaks only ILP — text (v1) or binary (v2/v3) rows over
HTTP or TCP, about 3.1k lines across `src/sender.ts`, `src/transport/`, and
`src/buffer/`. QWP is a different shape: a columnar, multi-table binary protocol
over a WebSocket, with an asynchronous acknowledgement stream, a
connection-scoped symbol dictionary, and a durable client-side send log.

### 1.1 Out of scope

Each of these is a separate future spec:

- the query client (`QwpQueryClient`, result-batch decode, bind values);
- the `QuestDB` facade and its sender/query pooling;
- multi-host HA failover (`failover_*` keys, roles and zones);
- the UDP sender.

## 2. Normative sources — and which ones are traps

Pin these exactly. There are many checkouts of the QuestDB repo on any given
machine and they do not agree with each other.

**Authoritative:**

| Source | Pin |
|---|---|
| Java client | `java-questdb-client` @ **1.3.7-SNAPSHOT**, HEAD `8f5ed4f9`. Local checkout: `~/claude/wt/oss/wal-pending-negative/java-questdb-client`. Several other checkouts on disk are at 1.3.6-SNAPSHOT — check `core/pom.xml` before reading |
| Server-side QWP | `io.questdb.cutlass.qwp.*` in the parent `questdb` repo |
| Status-code reference | `https://questdb.com/docs/connect/wire-protocols/qwp-ingress-websocket/` — the URL `WebSocketResponse` itself cites |
| NACK policy rationale | `java-questdb-client/design/qwp-nack-policy-v2.md` — **rationale only**, see 2.1 |
| Second reference implementation | `c-questdb-client` (Rust): `src/ws/`, `src/egress/`, `src/ingress/sender/qwp_ws*` |

**Stale — do not use:** `docs/qwp/{wire-ingress,sf-client,wire-egress,failover}.md`
in the parent `questdb` repo. These were **deleted from master** by `d1c5b03415`
*("chore(qwp): simplify the wire protocol to one version with inline schemas
(#7200)")*. Copies survive in older worktrees (`ingestion-efficiency`,
`pr-7162-review` @ `5d302a6716`) and still document a `schema_id: varint` field
that no longer exists on the wire. `QwpSchema`'s javadoc is explicit: *"The
schema section carries no mode byte and no schema id."* Following these docs
would encode a removed field.

The code still cites `sf-client.md` and `connect-string.md` by section number in
javadoc. Those references are to the deleted documents; treat the code as truth
and the section numbers as historical breadcrumbs.

### 2.1 Where `qwp-nack-policy-v2.md` is out of date

The document describes itself as "implemented on `feat/nack-policy-v2`". Checked
against the shipping 1.3.7 code, it is stale in three ways:

1. **There are four policies, not three.** `SenderError.Policy` ships
   `RETRIABLE`, `RETRIABLE_OTHER`, `TERMINAL`, and **`ABANDONED`**.
2. **There are ten categories, not six.** Beyond the wire-mapped ones,
   `SenderError.Category` adds `PROTOCOL_VIOLATION`, `UNKNOWN`, and
   **`DATA_LOSS`**.
3. **`DICTIONARY_GAP` (0x0D) is a full category** mapped to `RETRIABLE`; the
   document's policy table omits it.

Section 7 below records the verified behaviour. Where the two disagree, the code
wins.

## 3. Architecture

### 3.1 Why this cannot just reuse the existing buffer/transport pair

The current internal contracts bottom out at a single opaque blob:

```ts
interface SenderBuffer   { toBufferNew(pos?: number): Buffer | null; /* ... */ }
interface SenderTransport{ send(data: Buffer): Promise<boolean>;     /* ... */ }
```

QWP needs multi-table columnar accumulation, sealing into *frames* that carry
sequence numbers, and a response stream that arrives asynchronously and out of
band from the sends. The **row-builder half** of `SenderBuffer`
(`table`/`symbol`/`stringColumn`/`floatColumn`/…/`at`) maps 1:1 onto a columnar
accumulator and is kept exactly as-is — that is what preserves the public API.
Only the **drain half** is widened.

### 3.2 Module layout

All new code lives under `src/qwp/`, in four layers with no upward dependencies:

```
src/qwp/
  ws/          frame.ts  handshake.ts  socket.ts  mask.ts
  protocol/    constants.ts  varint.ts  bits.ts  gorilla.ts  nullBitmap.ts
               columnWriter.ts  tableBuffer.ts  frameEncoder.ts
               symbolDict.ts  response.ts
  sf/          engine.ts  ring.ts  segment.ts  manifest.ts
               ackWatermark.ts  slotLock.ts  orphanScanner.ts  drainer.ts
  sendLoop.ts
  transport.ts
  buffer.ts
```

- **`ws/`** — RFC 6455, hand-rolled over `net.Socket` / `tls.TLSSocket`. Ports
  Java's `WebSocketFrameParser`/`WebSocketFrameWriter` and the Rust client's
  HTTP response parser. QWP frames are binary-only, always `FIN=1`, never
  fragmented, and use zstd at the protocol layer rather than
  `permessage-deflate`, so no WebSocket library is used.
- **`protocol/`** — pure functions over `Buffer`. No I/O, no `async`. Directly
  testable against golden vectors.
- **`sf/`** — store-and-forward. Ports `CursorSendEngine`, `SegmentRing`,
  `SegmentManager`, `OrphanScanner`, `BackgroundDrainer`.
- **`sendLoop.ts`** — publish → wire → ACK → trim. Port of
  `CursorWebSocketSendLoop`.

### 3.3 Why hand-roll the WebSocket layer

Both existing reference implementations hand-roll it, and the Rust client
records the reasoning in `src/ws/mod.rs`: it dropped `tungstenite` precisely
because a generic WebSocket library's feature set is all cost and no benefit for
QWP. Java goes further, building `WebSocketClient` on its own non-blocking
socket layer with per-OS epoll/kqueue/select subclasses; its only runtime
dependency is `slf4j-api`.

For Node this means `net`/`tls` plus our own frame codec. It keeps the package's
dependency count unchanged (currently just `undici`), gives direct backpressure
via `socket.write()`'s return value and `'drain'`, allows arbitrary `X-QWP-*`
upgrade headers, and preserves the Node 20 floor. Cost is roughly 500–700 lines
plus its own tests.

### 3.4 Runtime model

Java's three threads collapse onto the event loop:

| Java | Node |
|---|---|
| producer thread | the caller's own code |
| I/O send loop thread | an async task per connection |
| segment manager thread | an async task using `fs.promises` (libuv threadpool) |
| background drainer threads | async tasks, each owning its own WebSocket |

No `worker_threads`, no native dependencies. Two Java primitives have no core
Node equivalent and are replaced:

- **`mmap` segments** → plain files, positional writes via `fs.promises` +
  `fdatasync`. Node must copy into `Buffer`s regardless, so mmap's zero-copy
  reads buy much less here than in Java.
- **`flock` slot locks** → `O_EXCL` lockfile carrying pid + boot id, with a
  liveness probe (see 8.3).

### 3.5 Integration points in existing code

All additive:

- `src/options.ts` — add `WS`/`WSS` protocol constants and the QWP config keys
  (section 9).
- `src/transport/index.ts` — `case WS: case WSS: return new QwpTransport(options)`.
- `src/buffer/index.ts` — return `QwpBuffer` for `ws`/`wss`. `protocol_version`
  negotiation stays an ILP-only concern and is not consulted for QWP.
- `src/sender.ts` — public builder chain unchanged; the flush path internally
  gains a publish-vs-send distinction.
- `src/index.ts` — export the new types.

Version bump is a **minor** (4.3.0): nothing here changes existing behaviour.

## 4. Public API

Unchanged from the user's point of view — the protocol is a connect-string
change:

```ts
const sender = Sender.fromConfig("ws::addr=localhost:9000;");
await sender.table("trades")
  .symbol("symbol", "ETH-USD")
  .floatColumn("price", 2615.54)
  .at(Date.now(), "ms");
await sender.flush();
```

New surface, mirroring Java:

```ts
await sender.flush();                    // publish; does NOT wait for ACK
const fsn = await sender.flushAndGetSequence();  // highest FSN published, or -1
const ok  = await sender.drain(30_000);  // flush + await ACK watermark
sender.onError((e: SenderError) => { /* e.category, e.policy, e.fromFsn, e.toFsn */ });
```

### 4.1 Flush semantics

`flush()` resolves once the frame is **published into the store-and-forward
engine** — in RAM for memory mode, on disk for disk mode. It does *not* wait for
the server. This matches Java's `flush()` exactly.

This differs from what `http::` means in this client today, where `flush()`
awaits the HTTP response. The difference is safe here only because
store-and-forward guarantees the bytes survive; that is why section 8 is part of
this spec rather than a follow-up. It must be called out prominently in the
README and in the migration notes.

If the ring is at its `sf_max_total_bytes` cap, `flush()` awaits space for up to
`sf_append_deadline_millis` (default 30 s) and then throws.

## 5. Ingest data flow

```
sender.table("t").symbol("s","x").doubleColumn("p",1.5).at(ts)
   -> QwpBuffer routes into a per-table TableBuffer (column-wise typed arrays;
      a column not set in a given row is marked null in that row's bitmap)
   -> auto_flush_rows | auto_flush_bytes | auto_flush_interval, or flush()
   -> frameEncoder.seal(): all dirty tables -> ONE frame, assigned an FSN
      (payload optionally zstd-compressed when negotiated)
   -> sf.append(frame)              <-- flush() resolves here
   -> sendLoop: frames after sentFsn -> WS binary frames, honouring
      socket.write() backpressure and the server's X-QWP-Max-Batch-Size
   -> ACK -> ackedFsn advances -> ring trims -> space frees
```

## 6. Wire format

All little-endian, byte-level.

### 6.1 Message header — 12 bytes

```
"QWP1" (4) | version:u8 | flags:u8 | tableCount:u16 | payloadLen:u32
```

`MAGIC_MESSAGE = 0x31505751`, `VERSION = 1`.

Flags: `DEFER_COMMIT 0x01`, `GORILLA 0x04`, `DELTA_SYMBOL_DICT 0x08`,
`ZSTD 0x10`.

Both `GORILLA` and `DELTA_SYMBOL_DICT` are genuinely optional on the wire —
`QwpMessageCursor` branches on `isGorillaEnabled()` / `isDeltaSymbolDictEnabled()`
per message. Java's encoder always sets both, but the server accepts neither.
This is what makes the incremental stack in section 11 possible.

### 6.2 Payload

```
if DELTA_SYMBOL_DICT:  varint deltaStart, varint deltaCount,
                       deltaCount x [varint len][utf8]

per table:  [varint nameLen][utf8][varint rowCount][varint columnCount]
            schema:  columnCount x [varint nameLen][utf8][typeCode:u8]
            columns: [null bitmap ceil(rowCount/8)] + type-specific payload
```

The schema section carries **no mode byte and no schema id** — columns are
always inline (post-#7200).

### 6.3 Column payloads

| Type | Code | Wire |
|---|---|---|
| BOOLEAN | 0x01 | bit-packed, 1 bit/value |
| BYTE / SHORT / INT / LONG | 0x02/0x03/0x04/0x05 | 1/2/4/8 B LE |
| FLOAT / DOUBLE | 0x06/0x07 | IEEE 754 4/8 B |
| SYMBOL | 0x09 | non-delta: varint dictSize, entries `[varint len][utf8]`, then varint index per non-null value. Delta mode: indices into the connection dictionary |
| TIMESTAMP / TIMESTAMP_NANOS / DATE | 0x0A/0x10/0x0B | int64; under `FLAG_GORILLA` a per-column encoding byte precedes, `0x00` = raw |
| UUID | 0x0C | 16 B LE |
| LONG256 | 0x0D | 32 B LE |
| GEOHASH | 0x0E | varint precision + `ceil(precision/8)` B per value |
| VARCHAR / BINARY | 0x0F/0x17 | `(N+1) x u32` offsets + concatenated bytes |
| DOUBLE_ARRAY / LONG_ARRAY | 0x11/0x12 | `[nDims:u8][dimLen:u32 x N][flattened LE]` |
| DECIMAL64/128/256 | 0x13/0x14/0x15 | scale (1 B, in schema) + LE unscaled 8/16/32 B |
| CHAR | 0x16 | 2 B UTF-16 code unit |
| IPv4 | 0x18 | 4 B LE, as INT |

### 6.4 Limits (mirror server constants; enforce client-side before sending)

`MAX_COLUMNS_PER_TABLE` 2048 · `MAX_COLUMN_NAME_LENGTH` 127 ·
`MAX_TABLE_NAME_LENGTH` 127 · `MAX_SYMBOL_DICTIONARY_SIZE` 1,000,000 ·
`DEFAULT_MAX_BATCH_SIZE` 16 MiB (the server advertises the real value via
`X-QWP-Max-Batch-Size`).

The symbol cap must be enforced at registration time, before the row is
buffered, so that everything already buffered references ids the server will
accept.

### 6.5 Handshake

Request: `GET /write/v4` with `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`,
`X-QWP-Client-Id: nodejs/<pkg version>`, `X-QWP-Max-Version: 1`, and
`Authorization: Basic|Bearer` derived from `user`/`password`/`token`.

From the `101` response read: `X-QWP-Version`, `X-QWP-Max-Batch-Size`,
`X-QWP-Content-Encoding`, `X-QWP-Durable-Ack`, `X-QuestDB-Role`,
`X-QuestDB-Zone`.

### 6.6 Server responses

```
OK           : status:u8 | seq:u64 | tableCount:u16 | [nameLen:u16][name][seqTxn:i64] x n
DURABLE_ACK  : status:u8 |           tableCount:u16 | [nameLen:u16][name][seqTxn:i64] x n
error        : status:u8 | seq:u64 | errLen:u16 | utf8
```

`MAX_ERROR_MESSAGE_LENGTH` is 1024.

## 7. Error handling

### 7.1 Categories

Ten, ported from `SenderError.Category`. Seven map to wire status bytes; three
are client-originated.

| Category | Wire | Meaning |
|---|---|---|
| `SCHEMA_MISMATCH` | 0x03 | column missing, type clash, NOT NULL violated, no such table |
| `PARSE_ERROR` | 0x05 | malformed QWP payload — most likely a client bug |
| `INTERNAL_ERROR` | 0x06 | server-side fault, catch-all |
| `SECURITY_ERROR` | 0x08 | authn/authz failure |
| `WRITE_ERROR` | 0x09 | non-critical Cairo error, table not accepting writes |
| `NOT_WRITABLE` | 0x0C | node cannot serve writes; **reserved**, not currently emitted |
| `DICTIONARY_GAP` | 0x0D | delta dict began above the server's connection dict |
| `PROTOCOL_VIOLATION` | — | poison-frame detector fired |
| `DATA_LOSS` | — | durably buffered rows that will never be sent |
| `UNKNOWN` | any other | forward compatibility |

### 7.2 Policies

Four, from `SenderError.Policy`. There is **no drop policy** — the client never
discards data without saying so.

| Policy | Behaviour |
|---|---|
| `RETRIABLE` | recycle the connection, replay from `ackedFsn + 1`; handler delivery is informational |
| `RETRIABLE_OTHER` | same replay, but rotate endpoints rather than back off against the same node |
| `TERMINAL` | latch; next producer call throws; bytes stay on disk |
| `ABANDONED` | the rows are gone; nothing throws and the sender keeps running; bytes preserved at `quarantinedPath` |

### 7.3 Default mapping (`defaultPolicyFor`)

```
WRITE_ERROR, INTERNAL_ERROR, DICTIONARY_GAP, UNKNOWN  -> RETRIABLE
NOT_WRITABLE                                          -> RETRIABLE_OTHER
DATA_LOSS                                             -> ABANDONED
SCHEMA_MISMATCH, PARSE_ERROR, SECURITY_ERROR,
PROTOCOL_VIOLATION, (default)                         -> TERMINAL
```

Rationale worth preserving in comments: `UNKNOWN` **fails open** so a status
byte from a newer server degrades to a retry rather than a dead sender;
`SECURITY_ERROR` mid-stream can only mean ACL denial on a *writable* node,
because read-only refusals arrive as reconnect-eligible closes, so `TERMINAL` is
correct.

Three mappings are forced and ignore any user override:
`PROTOCOL_VIOLATION`→`TERMINAL`, `UNKNOWN`→`RETRIABLE`, `DATA_LOSS`→`ABANDONED`.

**No policy resolver is implemented in 1.3.7** and none will be ported. The
`SenderError.Policy` javadoc describes a precedence chain
(`errorPolicyResolver` → per-category → `on_*_error` → `on_server_error` →
defaults) that does not exist in the code; `errorPolicyResolver` appears in that
javadoc and nowhere else. Building it would be inventing behaviour.

### 7.4 WebSocket close codes carry zero policy weight

Every close is a transport event → reconnect + replay. The guarded case, a frame
that deterministically kills the connection *without* a NACK (for example an
intermediary's frame-size limit), is caught behaviourally by the **poison-frame
detector**:

- a server-active rejection (a `RETRIABLE` NACK, or a non-orderly close after at
  least one send) counts a **strike**, keyed on the rejected frame's FSN — the
  NACK-named frame, or the OK-level head-of-line frame for a close, never the
  engine's trim watermark;
- `RETRIABLE_OTHER` never counts a strike (it is a verdict on the node, not the
  bytes);
- orderly closes (`NORMAL_CLOSURE`, `GOING_AWAY`) never count strikes;
- `max_frame_rejections` consecutive strikes (default
  `DEFAULT_MAX_HEAD_FRAME_REJECTIONS = 4`) escalate to `PROTOCOL_VIOLATION`,
  which is `TERMINAL`;
- the counter resets **only** on OK-level acceptance at or beyond the suspect
  frame, so re-OKs of frames *behind* it cannot launder the count.

Below the threshold a `RETRIABLE` recycle is **paced**: the server is reachable
(it just answered), so the failed-connect backoff never engages. The recycle
parks *before* the first connect attempt, using the reconnect backoff dose —
initial, doubling per consecutive strike against the same frame, capped, plus
jitter. A NACK sequence that is making progress (a different frame each time)
resets to the initial dose.

### 7.5 Backpressure

The one structural difference from Java: Java spin-parks the producer thread. We
`await` a promise resolved either by ACK-driven trim or by `socket.on('drain')`,
with `sf_append_deadline_millis` as the rejection deadline.

## 8. Store-and-forward

Port of `CursorSendEngine` + `SegmentRing` + `SegmentManager` + `OrphanScanner`
+ `BackgroundDrainer` (~16.6k lines of Java).

### 8.1 Model

A chain of segments presented as one logical append-only log keyed by FSN.
Rotation when the active segment fills; ACK-driven trim of the oldest sealed
segments. Two watermarks, each single-writer: `publishedFsn` (producer) and
`ackedFsn` (I/O loop).

**Single producer per engine.** Java states this explicitly and we inherit it:
one `Sender` is owned by one logical writer. This matches the constraint the
Node README already documents for ILP ("each worker thread needs its own Sender
instance"), so it introduces nothing new for users — but it does mean a slot
directory is owned by exactly one `Sender` at a time, which 8.3 enforces.

Memory mode (PR 10) and disk mode (PR 11) share the ring; disk mode adds
file-backed segments, a manifest, and a persisted ack watermark.

### 8.2 Durability

`sf_durability` governs when `fdatasync` runs; `sf_sync_interval_millis` sets the
periodic barrier. Ordering rule: a segment's bytes must be durable before the
manifest entry that references them, so recovery never sees a manifest pointing
at bytes that are not there.

### 8.3 Slot locking without `flock`

Each slot directory holds a `.lock` file created `O_EXCL` containing pid and
boot id. A lock whose boot id differs from the current boot is stale by
definition. A lock with a matching boot id but a dead pid is stale after a
liveness probe. Anything else is live and the slot is skipped. This replaces
Java's `flock`, whose kernel-drops-on-exit property we lose and must emulate.

### 8.4 Recovery and orphans

On startup, if `drain_orphans` is enabled, scan for slot directories not held by
a live lock. Each is handed to a drainer task (bounded by
`max_background_drainers`) which opens its **own** WebSocket, replays the slot
read-only until `ackedFsn` catches the startup snapshot of `publishedFsn`, then
releases the slot.

A drainer that fails terminally drops a `.failed` sentinel into the slot and
exits; future scans skip that slot until an operator clears it — bounded
automatic retry, then human-in-the-loop. Abandonment fires `DATA_LOSS` /
`ABANDONED` with `quarantinedPath` set. Note that a transient all-replica
failover window is **not** terminal and is retried indefinitely.

Frames above the last commit-bearing (non-`DEFER_COMMIT`) FSN in a recovered
ring belong to a transaction whose commit frame was never published; the server
will never ACK them until a later commit covers them. Close-time drain must not
wait on ACKs that cannot arrive.

## 9. Configuration

Every key that exists in Java's `ConfigSchema` keeps its Java name exactly. Two
keys below (`init_buf_size`, `max_buf_size`) are pre-existing Node-client keys
with no Java counterpart; they carry over unchanged so `ws::` behaves like the
other Node protocols. Three tiers — the third is the one that is easy to get
wrong.

**Implemented:** `addr`, `auto_flush`, `auto_flush_rows`, `auto_flush_bytes`,
`auto_flush_interval`, `user`, `password`, `token`, `tls_verify`, `tls_roots`,
`tls_roots_password`, `init_buf_size`, `max_buf_size`, `client_id`,
`connect_timeout`, `auth_timeout_ms`, `sf_dir`, `sf_max_total_bytes`,
`sf_max_segment_bytes`, `sf_durability`, `sf_append_deadline_millis`,
`sf_sync_interval_millis`, `reconnect_initial_backoff_millis`,
`reconnect_max_backoff_millis`, `reconnect_max_duration_millis`,
`max_frame_rejections`, `zstd`, `compression`, `compression_level`,
`request_durable_ack`, `transaction`, `drain_orphans`,
`max_background_drainers`, `close_flush_timeout_millis`,
`error_inbox_capacity`, `connection_listener_inbox_capacity`.

**Accept-and-ignore, reserved** (Java: `Side.RESERVED`): `on_internal_error`,
`on_parse_error`, `on_schema_error`, `on_security_error`, `on_server_error`,
`on_write_error`.

**Accept-and-ignore, egress/failover** — so one connect string serves both the
sender and a future query client: `target`, `failover`, `failover_backoff_initial_ms`,
`failover_backoff_max_ms`, `failover_max_attempts`, `failover_max_duration_ms`,
`query_pool_min`, `query_pool_max`, `query_close_timeout_ms`, `zone`,
`sender_pool_min`, `sender_pool_max`, `sender_id`, and the other pool keys.

**Reject:** everything else. Unknown-key rejection is required, which is exactly
why both ignore-lists must be explicit rather than a catch-all. Java implements
this the same way and comments that "forward-compat is via the spec, not silent
ignore".

### 9.1 zstd and the Node version floor

`node:zlib`'s `zstdCompress` landed in **Node 22.15.0**. The client's documented
floor is Node 20 and CI runs `[20, 22, latest]`. A naive "require Node 22" rule
would still be wrong for 22.0–22.14.

Therefore: **feature-detect**. Probe for `zstdCompressSync` at connect time. If
present, send `X-QWP-Content-Encoding: zstd` and set `FLAG_ZSTD`; if absent,
negotiate uncompressed. The floor stays at Node 20 and the CI matrix is
unchanged.

## 10. Testing

Four tiers, all four required.

1. **Golden byte-vector fixtures.** A small harness in `java-questdb-client`
   emits canonical frames — every column type, null bitmaps, Gorilla on and off,
   delta-dictionary deltas, multi-table batches, the empty batch — to fixture
   files checked into the Node repo *alongside the emitting Java SHA*. Node unit
   tests assert byte-for-byte equality. This catches endianness, varint,
   zig-zag, bit-packing and null-bitmap drift at the point of the mistake rather
   than as a mysterious server NACK, and the recorded SHA makes drift visible.
2. **TypeScript mock QWP server.** Performs the upgrade, decodes frames, and
   drives the whole error matrix on demand: each NACK status, malformed frames,
   mid-frame disconnect, slow-consumer backpressure, server-initiated close, and
   poison-detector escalation at 4 strikes. A real QuestDB will not produce
   `INTERNAL_ERROR` or a torn frame to order.
3. **Testcontainers integration.** Extends the existing
   `sender.integration.test.ts` pattern: ingest over `ws://`, then verify via SQL
   that rows, types, nulls and symbols landed exactly. Requires an image with
   QWP ingress enabled.
4. **Crash-recovery tests.** Spawn a child process, ingest, `SIGKILL` mid-flight,
   then assert a fresh Sender recovers the orphan slot, replays from
   `ackedFsn + 1`, and rows land exactly once. Plus the abandonment path: corrupt
   a slot, assert it is quarantined with `quarantinedPath` set, `DATA_LOSS` /
   `ABANDONED` is delivered, and the sender keeps running.

## 11. PR stack

Thirteen stacked PRs, each independently reviewable and green. PRs 1–8 are the
wire; 9–12 are the reliability story; PR 3 is the first point at which a user
could actually use the feature.

| # | PR | Gate |
|---|---|---|
| 1 | `ws/`: framing, masking, handshake, net/tls socket | unit + mock server |
| 2 | `protocol/`: header, varint/zigzag, LONG/DOUBLE/TIMESTAMP/SYMBOL inline | golden vectors |
| 3 | Sender wiring: `ws://` config, `QwpBuffer`/`QwpTransport`, auto-flush | **testcontainers e2e green** |
| 4 | Remaining scalar types + null bitmap | golden + e2e |
| 5 | VARCHAR/BINARY/arrays/decimals/geohash/uuid/long256/char/ipv4 | golden + e2e |
| 6 | Delta symbol dictionary + `DICTIONARY_GAP` handling | golden + e2e |
| 7 | Gorilla timestamps + raw fallback | golden + e2e |
| 8 | defer-commit + zstd (feature-detected) | e2e both on and off |
| 9 | ACK/NACK matrix, `defaultPolicyFor`, reconnect, replay, poison detector | mock server |
| 10 | Memory-mode ring — makes publish semantics safe | mock + e2e |
| 11 | Disk segments, manifest, ack watermark, `fdatasync` | crash tests |
| 12 | Slot locks, orphan scan, drainers, `DATA_LOSS`/`ABANDONED` | crash tests |
| 13 | Docs, examples, README support matrix, 4.3.0 release | — |

## 12. Risks

- **Silent wire divergence.** Mitigated by golden vectors pinned to a Java SHA.
  The `schema_id` trap in section 2 is a live example of how this goes wrong.
- **Publish-semantics `flush()` before PR 10.** Between PR 3 and PR 10 there is
  no retention, so an unacked frame lost to a disconnect is lost. PRs 3–9 must
  document this in-tree and the feature must not be announced as
  production-ready until PR 10 lands.
- **Slot-lock emulation.** `O_EXCL` + pid/boot-id is weaker than `flock`, which
  the kernel releases on hard exit. A wrong liveness probe either strands data
  (too conservative) or races two processes onto one slot (too aggressive). This
  needs its own focused tests.
- **Event-loop stalls on large frames.** Encoding is synchronous. If frame
  encode time becomes a problem, the mitigation is chunking within
  `frameEncoder`, not `worker_threads`.
