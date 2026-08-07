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
               ackWatermark.ts  symbolDictFile.ts  crc32c.ts
               slotLock.ts  orphanScanner.ts  drainer.ts
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
  `MmapSegment`, `SegmentManager`, `SfManifest`, `AckWatermark`,
  `PersistedSymbolDict`, `SlotLock`, `OrphanScanner`, `BackgroundDrainer`.
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

### 6.0 Primitives

- **`varint`** — unsigned **LEB128**: 7 data bits per byte, high bit `0x80` set
  means another byte follows. `MAX_VARINT_BYTES = 10` for a 64-bit value. It is
  *unsigned*; there is no implicit zig-zag.
- **`zigzag`** — `encode(n) = (n << 1) ^ (n >> 63)`,
  `decode(n) = (n >>> 1) ^ -(n & 1)`. Applied only where a codec explicitly
  calls for it (Gorilla), never implicitly by `varint`.
- **`string`** — `varint` byte length followed by UTF-8 bytes. This is Java's
  `putString`, and it is what every `[varint nameLen][utf8]` below expands to.
  (`putUtf8` writes raw bytes with no length prefix and is not used in the frame
  structure.)

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
            columns: per column, in schema order:
                     [nullHeader:u8]
                     if nullHeader != 0: [null bitmap ceil(rowCount/8)]
                     type-specific payload, for valueCount values
```

The schema section carries **no mode byte and no schema id** — columns are
always inline (post-#7200). The type byte is written verbatim: the client's
`QwpColumnDef.getWireTypeCode()` returns `typeCode` unchanged. Some javadoc
refers to a "null bitmap flag" in the type code; that phrasing is vestigial and
there is no such flag bit — nullability is the `nullHeader` byte below.

### 6.2.1 Null encoding — read this carefully

Every column payload begins with a **1-byte null header**: `0` means no nulls
and no bitmap follows; non-zero means a bitmap of `ceil(rowCount/8)` bytes
follows. Java writes `1`; a decoder must treat any non-zero value as "bitmap
present".

Bitmap semantics (`QwpNullBitmap`): **bit `i` set means row `i` is NULL**, bit
order **LSB-first within each byte**. Row 9 is therefore byte 1, bit 1.

Critically, **values are compacted**: the payload carries only the non-null
values. Java computes `valueCount = rowCount - nullCount` and every writer is
driven by `valueCount`, not `rowCount`. There are no placeholder slots for null
rows. This applies to fixed-width values, VARCHAR/BINARY offsets, symbol
indices, array entries — everything. Getting this wrong produces a frame whose
length is right for the wrong data.

### 6.3 Column payloads

`V` below is `valueCount` — the **non-null** row count (see 6.2.1), never
`rowCount`.

| Type | Code | Wire |
|---|---|---|
| BOOLEAN | 0x01 | bit-packed over `V` values, `ceil(V/8)` bytes, LSB-first |
| BYTE / SHORT / INT / LONG | 0x02/0x03/0x04/0x05 | `V x` 1/2/4/8 B LE |
| FLOAT / DOUBLE | 0x06/0x07 | `V x` IEEE 754 4/8 B |
| SYMBOL | 0x09 | non-delta: `varint dictSize`, `dictSize x [varint len][utf8]`, then `V x varint` index. Delta mode: **no dictionary**, just `V x varint` global id |
| TIMESTAMP / TIMESTAMP_NANOS | 0x0A/0x10 | see 6.3.1 |
| DATE | 0x0B | `V x` 8 B LE — **never Gorilla-encoded**, no encoding byte |
| UUID | 0x0C | `V x` 16 B (lo then hi, matching wire order) |
| LONG256 | 0x0D | `V x` 32 B (4 contiguous LE longs) |
| GEOHASH | 0x0E | `varint precision` **once per column**, then `V x ceil(precision/8)` B LE |
| VARCHAR / BINARY | 0x0F/0x17 | `(V+1) x u32` offsets + concatenated bytes. BINARY shares VARCHAR's layout exactly; only the byte-stream contract differs (opaque vs UTF-8) |
| DOUBLE_ARRAY / LONG_ARRAY | 0x11/0x12 | **per value**: `[nDims:u8][dimLen:u32 x nDims][prod(dims) x 8 B LE]`. Shape is per row, not per column |
| DECIMAL64/128/256 | 0x13/0x14/0x15 | `scale:u8` **once, at the start of the column payload**, then `V x` LE unscaled 8/16/32 B |
| CHAR | 0x16 | `V x` 2 B UTF-16 code unit |
| IPv4 | 0x18 | `V x` 4 B LE, as INT |

Note on DECIMAL: `QwpConstants`' javadoc says *"[scale (1B in schema)]"*. That
is wrong — `writeDecimal64Column` emits `buffer.putByte(scale)` into the
**column payload**, and the schema section carries only name and type. Trust the
code.

### 6.3.1 Timestamp encoding byte

The encoding byte exists **only when `FLAG_GORILLA` is set on the message**. If
the flag is clear, timestamps are raw `V x 8 B` with no prefix byte at all.

With the flag set, per `writeTimestampColumn`:

- `V > 2` and the delta-of-delta fits: `0x01` (`ENCODING_GORILLA`) + bit-packed
  payload;
- `V > 2` but it does not fit: `0x00` (`ENCODING_UNCOMPRESSED`) + raw `V x 8 B`;
- `V <= 2`: `0x00` + raw `V x 8 B`.

So a Gorilla-advertising client must still emit the byte for tiny columns. DATE
is excluded from this path entirely.

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
`X-QWP-Client-Id`, `X-QWP-Max-Version: 1`, and `Authorization: Basic|Bearer`
derived from `user`/`password`/`token`.

`X-QWP-Client-Id` follows Java's convention of `<lang>/<protocol-client-version>`
— Java 1.3.7 sends the constant `"java/1.0.2"`, which is deliberately **not** the
artifact version. Node therefore sends `nodejs/<qwp-client-version>` from a
dedicated constant, not `package.json`'s version.

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
- escalation to `PROTOCOL_VIOLATION` (which is `TERMINAL`) requires **both**
  conditions, not just the first:
  1. `max_frame_rejections` consecutive strikes
     (`DEFAULT_MAX_HEAD_FRAME_REJECTIONS = 4`), **and**
  2. the suspect frame has stayed poisoned for at least
     `poison_min_escalation_window_millis`
     (`DEFAULT_POISON_MIN_ESCALATION_WINDOW_MILLIS = 5_000`); `0` means escalate
     immediately at the strike threshold;
- the counter resets **only** on OK-level acceptance at or beyond the suspect
  frame, so re-OKs of frames *behind* it cannot launder the count.

The dwell window is not optional polish. Java's reasoning: a strike count
measures "how many times did we look", not "how long has this been true", and
with pacing four strikes can accrue in well under a second — for example an
accepting load balancer that closes each cycle while its backend is briefly
down. Count alone would escalate that transient into a producer-fatal terminal.
Implementing only the count is a correctness bug, not a simplification.

The orphan drainer's symbol-dict catch-up cap gap uses the same two-condition
shape — `MAX_CATCHUP_CAP_GAP_ATTEMPTS = 16` attempts **and**
`catch_up_cap_gap_min_escalation_window_millis` (300,000) of dwell — for the
same stated reason: a strike count measures "how many times did we look", not
"how long has this been true". See 7.5.

Below the threshold a `RETRIABLE` recycle is **paced**: the server is reachable
(it just answered), so the failed-connect backoff never engages. The recycle
parks *before* the first connect attempt, using the reconnect backoff dose —
initial, doubling per consecutive strike against the same frame, capped, plus
jitter. A NACK sequence that is making progress (a different frame each time)
resets to the initial dose.

### 7.5 Reconnect requires a symbol-dictionary catch-up

The delta symbol dictionary is **connection-scoped on the server**. After a
reconnect the fresh server's dictionary is empty, while every surviving frame in
the SF log references ids assigned on the old connection. Replaying data frames
directly would earn `STATUS_DICTIONARY_GAP` immediately.

So on every reconnect, before replaying any data frame, the send loop emits a
**dictionary catch-up frame** re-registering the dictionary from id 0. This is
the mechanism behind 7.3's "`DICTIONARY_GAP` → re-register and replay"; the spec
previously named the outcome without naming the mechanism, which is not
implementable.

Chunking rules:

- The catch-up is packed against the server's advertised `X-QWP-Max-Batch-Size`.
- **"Not advertised" is not "unbounded."** If the server omits the header (older
  build, or a derived cap that collapsed to zero), pack against
  `UNCAPPED_CATCHUP_PACKING_LIMIT = 64 KiB` — deliberately well below the 128 KiB
  default receive buffer. The transport still closes anything larger than the
  receive buffer with WS 1009, and a catch-up-only close is deliberately
  non-terminal, so an unchunked catch-up would reconnect into the identical
  oversized frame forever.
- The packing limit bounds **multi-entry** packing only. A single oversized entry
  is measured against a separate, more generous limit, so an entry that already
  shipped inside a data frame is never reclassified as unsendable.

**Cap gap.** If a catch-up reaches a fresh server and finds a single entry too
large for that server's cap, that is a cap-gap attempt. A homogeneous cluster
never trips it — an entry that fit its data frame under a cap always fits its
bare catch-up frame under the same cap — so it only arises in a heterogeneous or
rolling-cap cluster after failover to a smaller-cap node.

The asymmetry matters: **a foreground sender retries forever; only an orphan
drainer may latch a terminal**, after `MAX_CATCHUP_CAP_GAP_ATTEMPTS = 16`
consecutive cap gaps *and* `catch_up_cap_gap_min_escalation_window_millis`
(default **300,000**, i.e. 5 min) of dwell. The counter increments *only* when a
node was reached and an entry was oversized. A successful catch-up ends the
episode, as does any unrelated reconnect state (connect refusal, catch-up send
failure, upgrade or role rejection) — otherwise unrelated downtime would count
toward the dwell. A cap-gap exception itself does *not* reset the episode, so
consecutive small-cap nodes still accumulate.

### 7.6 Backpressure

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

Memory mode (PR 10) and disk mode (PR 11) share the ring **and the segment
abstraction**: Java's `MmapSegment` has a `memoryBacked` flag selecting a
malloc'd buffer instead of a file mapping, with the same cursor architecture.
Port that flag rather than writing two segment types.

**Publish barrier.** Each segment carries an `appendCursor` (producer-only) and a
`publishedCursor`. The consumer **must not read any byte at offset
`>= publishedOffset()`**. That single rule is what makes the whole thing
lock-free, and it is easy to lose in a port where `await` interleaves differently
than Java's threads.

### 8.1.0 Hot-spare provisioning — the producer never creates a segment

`SegmentManager` is a background worker that keeps every registered ring
supplied with a **pre-created hot-spare segment**, and trims segments once their
frames are ACKed. The point is to keep the expensive operations — segment
creation (`open + allocate + map`) and trim (`unmap + unlink`) — **off both the
producer and the I/O path entirely**. On rotation the producer swaps in an
already-existing spare; it never waits on file creation.

- One manager serves many rings (Java: typically every `Sender` in the JVM). In
  Node this is a shared module-level async task, not one per `Sender`.
- Poll tick default **1 ms** — short enough that a producer rarely observes
  `BACKPRESSURE_NO_SPARE` in steady state, long enough that an idle process does
  not burn CPU.
- `MIN_LIVE_SEGMENTS = 2` (active + one spare) is the minimum working set for a
  producer to advance at all.
- Trim is staged and retried with backoff (4 ms → ~1.02 s) at three distinct
  points — pre-barrier, unlink, post-barrier — capped at
  `MAX_TRIMS_PER_RING_PASS = 64` per ring per pass, with disk-full warnings
  throttled to once per 30 s.

Omitting hot spares does not fail a test; it just moves an `open`+`allocate`
onto the producer at every rotation. Port it.

### 8.1.0.1 The `.symbol-dict` liveness-floor deadlock — do not reintroduce

`sf_max_total_bytes` must **not** be enforced as a naive sum of everything in the
slot directory. Java guards this with
`livenessFloorBytes = MIN_LIVE_SEGMENTS * segmentSizeBytes`, below which the cap
check never refuses to provision, and the reasoning is worth stating in full
because a straightforward Node port reintroduces the bug exactly:

- **Segment bytes are reclaimable.** ACK-driven trim frees them, so refusing to
  provision on segment bytes is *productive* backpressure — it clears itself.
- **Side-file bytes are not.** `.symbol-dict` is lifetime-monotonic; nothing
  shrinks it.

So once side-file bytes *alone* push a ring under the cap, no ACK can ever free
the shortfall. The producer stalls **permanently, and across restarts**, while
the disk-full warning points at a trim that cannot help. Guaranteeing the minimum
working set is what turns that permanent deadlock into ordinary backpressure.

### 8.1.0.2 Two distinct append failures

`SegmentRing.appendOrFsn` has two sentinels and they need opposite handling:

| Sentinel | Meaning | Handling |
|---|---|---|
| `BACKPRESSURE_NO_SPARE` (-1) | active is full, no spare ready | wait — the manager or an ACK will clear it; this is the `sf_append_deadline_millis` path |
| `PAYLOAD_TOO_LARGE` (-2) | the frame does not fit in a **fresh** segment | never clears; surface a user-facing error immediately |

Treating `PAYLOAD_TOO_LARGE` as backpressure would burn the full append deadline
before failing, and report a timeout instead of the real cause.

### 8.1.1 Segment file format (`MmapSegment`)

```
24-byte header:
  u32 magic 'SF01' (0x31304653) | u8 version=1 | u8 flags | u16 reserved=0
  u64 baseSeq | u64 createdMicros

then frames, each:
  u32 crc32c | u32 payloadLen | payloadLen bytes
```

The CRC32C covers **`payloadLen` and the payload together**, not the payload
alone. `flags` bit 0 is `MANIFEST_REQUIRED_FLAG`. Segment files use the `.sfa`
extension and the mapping is sized at construction and never grows — when an
append does not fit, the caller rotates.

Java exposes both a legacy `msync`-only flush and a checked `syncPublished()`
mapping-plus-fd barrier; only the latter is a portable power-loss barrier, so
the Node port implements the `syncPublished()` semantics (write + `fdatasync`)
and does not reproduce the legacy path.

### 8.1.2 Persisted symbol dictionary — load-bearing, not an optimisation

`<slot>/.symbol-dict` (`PersistedSymbolDict`) is the component most easily
missed, and omitting it makes delta-encoded recovery silently impossible.

Delta-encoded SF frames are **not self-sufficient**: a frame carries only the
symbols it introduces. Recovering a slot after a restart, or adopting an orphan
slot, therefore requires re-registering the *whole* dictionary against the fresh
server before those frames can replay. Unlike `.ack-watermark` — a discardable
optimisation guarded by a monotonic clamp — this file is load-bearing: **a
surviving frame that references an id missing from it is unrecoverable.**

```
offset 0: u32 magic 'SYD1'
offset 4: u8 version = 1
offset 5: 3 bytes reserved (zero)
offset 8: chunks, each
          [entryCount: varint][entryBytes: varint][entries][crc32c: u32]
          entries = [len: varint][utf8] x entryCount, occupying exactly
          entryBytes bytes; the CRC-32C covers BOTH header varints and the
          entry region.
```

Rules that must survive the port:

- **One chunk = one append = exactly the symbols one frame introduces.** The
  producer persists a frame's new symbols in a single call *before* publishing
  that frame.
- **Ids are implicit.** Symbol id `i` is the `i`-th entry across all chunks; ids
  are dense from 0, so no id is stored. A wrong chunk boundary silently
  renumbers every later symbol.
- **CRC is per chunk, deliberately not per entry.** Every `deltaStart` is a chunk
  boundary, so per-entry granularity recovers no additional prefix while adding
  a checksum call per symbol on the producer path.
- **Write-ahead, but not fsynced.** Symbols are appended before the frame is
  published, matching the rest of SF's page-cache (not disk) durability. This is
  sufficient for a process crash — the page cache survives — but is explicitly
  *not* a host-power-loss guarantee.
- **`open` never destroys it.** Only a fresh start truncates, via `openClean`,
  and a failed truncation must refuse the slot outright rather than proceed.

**Recovery replay must not de-duplicate.** Rebuilding the in-memory dictionary
from `.symbol-dict` appends every entry unconditionally at the next sequential
id (Java's `addRecoveredSymbol`, deliberately distinct from `getOrAddSymbol`).
The persisted file, the on-wire delta, and the reconnect catch-up mirror all key
on entry **position**, never on the string. If recovery collapsed two entries
that decode to the same characters, the rebuilt dictionary would be *shorter*
than the persisted entry count, desyncing the producer's delta baseline from the
catch-up mirror and silently misattributing every later symbol. For the same
reason, recovery replay is deliberately **not** capped at
`MAX_SYMBOL_DICTIONARY_SIZE` — those entries were already admitted under the cap
when first written. A reverse lookup may keep the highest id for a colliding
string; both ids encode to the same bytes, so that is harmless.

The colliding case in Java is malformed lone UTF-16 surrogates, which its UTF-8
encoder maps to `'?'`. **This is a live hazard in Node, not a theoretical one:**
JavaScript strings are UTF-16 and a lone surrogate (`"\uD800"`) is trivially
reachable, but Node's `Buffer.from(s, "utf8")` maps it to U+FFFD (`EF BF BD`),
not `'?'`. Node-internal consistency is preserved because everything is
position-keyed, but **Java and Node will emit different bytes for the same input
string**, so lone surrogates must be excluded from byte-equality golden vectors
and covered by a separate Node-only round-trip test.

### 8.2 Durability — two crash-safe boundary records

Both on-disk boundary records use the **same alternating-generation scheme**, and
it must be ported exactly:

- `sf-manifest.bin` (`SfManifest`) — 8 KiB, magic `SFM1` (`0x314d4653`),
  version 1.
- `<slot>/.ack-watermark` (`AckWatermark`) — magic `AKW1`; record layout is
  `u32 magic | u32 version | i64 generation | i64 fsn | zero-fill to 59 |
  u32 CRC32C of bytes [0,60)`.

Each file holds **two independently CRC-protected 64-byte records, at offsets 0
and 4096**. Writes alternate between them; the CRC is stored last. Recovery
selects the valid record with the greatest `generation`. The 4 KiB separation is
deliberate — it prevents a single aligned 512-byte or 4 KiB sector tear from
damaging both records. A torn update falls back to the older valid record; if
neither validates, recovery falls back to the segment-derived seed.

Durable ACKs are cumulative (`STATUS_DURABLE_ACK fsn=N` means "everything
`<= N` is durable"), so one monotonic watermark suffices — no per-frame bitmap.
`update()` applies a monotonic clamp.

**fsync cadence.** Ordinary ACK-only updates stay syscall-free in Java (a store
into the mmap'd inactive record). Each non-empty background disk-trim quantum
does one `msync` plus one fd `fsync`, fsyncs the slot directory **before**
unlinking, and fsyncs it **again** after the batch. Close uses the same covering
order, so the durable watermark always guards any acknowledged segment a host
crash restores.

`sf_durability` selects one of exactly four modes — `memory`, `periodic`,
`flush`, `append` — and any other value is rejected. `sf_sync_interval_millis`
sets the periodic barrier. Both keys are **WebSocket-only**: Java throws
`"sf_durability is only supported for WebSocket transport"` if they appear with
another protocol, and the Node port must reject them the same way for `http::`
and `tcp::`.

**Two consequences of the Node primitives** (expected deviations, but they change
the cost model rather than just the mechanism):

1. Without mmap, ACK-only watermark updates are no longer free — each becomes a
   positional `write()`. The trim-quantum cadence above therefore matters more in
   Node than in Java, and the implementation must not write the watermark per
   ACK.
2. The checksum is **CRC32C (Castagnoli)**, not CRC-32. `zlib.crc32` is
   ISO-HDLC and will not interoperate. A small CRC32C implementation is required
   in `sf/`, and its vectors should be part of the golden-fixture set.

### 8.3 Slot locking — two locks, not one

Java's `SlotLock` provides **two distinct advisory locks**, and the second is not
optional — the orphan-adoption sequence depends on it:

1. **Slot lock** — `acquire()` locks `<slot>/.lock` for the entire lifetime of
   the owning engine.
2. **Logical lock** — `acquireLogical()` locks a sibling file under
   `<sfDir>/.slot-locks/`, used for short-lived pathname transitions and orphan
   adoption. It lives **outside** the slot directory precisely so it stays valid
   if that directory is renamed.

A drainer therefore adopts an orphan by: taking the parent-anchored logical lock
→ revalidating the scanner snapshot → taking the slot's `.lock` → releasing the
logical lock.

Java uses real `flock` / `LockFileEx`, and writes the holder's PID to a separate
`.lock.pid` file so a failed acquisition can name the offending process. The PID
is a separate file because Windows' `LockFileEx` is a *mandatory* range lock —
while `.lock` is held, a second handle cannot read its own bytes.

The contract being protected: two senders on one slot dir would interleave their
FSN sequences on disk and corrupt recovery. Detecting the collision at
acquisition and refusing to start is correct, because no data is on disk yet.

**Node deviation.** Core Node exposes no `flock`, so both locks are emulated with
an `O_EXCL` lockfile containing pid + boot id: a differing boot id is stale by
definition; a matching boot id with a dead pid is stale after a liveness probe;
anything else is live and the slot is skipped. The property genuinely lost is the
kernel's automatic release on hard exit, which the boot-id/liveness probe
reconstructs. Both lock kinds and the four-step adoption order above must still
be implemented — only the primitive changes. The `.lock.pid` split is unnecessary
for us (our lockfile is advisory and readable), but the PID-in-error-message
diagnostic should be kept.

### 8.3.1 `close()` ordering

`close()` is not just teardown; two of its properties are load-bearing.

**Ordering.** The sequence is: flush user-thread state into the engine → send the
commit message if commits are deferred → seal and swap the residual buffer →
drain on close (up to `close_flush_timeout_millis`) → tear down. A pre-flight
rejection of the final batch must **not** be allowed to escape before those
later steps run: doing so skips the commit and the drain, abandoning every row an
*earlier successful* flush already published. Java handles the rejected batch as
discardable-on-close and proceeds.

**Terminal-error surfacing.** `close()` must report a latched terminal error. A
user who only ever calls `close()` — never `flush()` afterwards — would otherwise
never learn that the server rejected their data. Equally it must not double-report
an error instance the user already caught from an earlier call. Java snapshots the
already-surfaced error once, precisely so a terminal latched between two reads
cannot be misattributed as user-owned and silently dropped.

Deferred commits interact here: frames above the last commit-bearing
(non-`DEFER_COMMIT`) FSN belong to a transaction whose commit was never
published, so the server will never ACK them. Close-time drain must target the
last commit boundary, not `publishedFsn`, or it waits out the full timeout on
ACKs that cannot arrive.

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
wait on ACKs that cannot arrive (8.3.1).

## 9. Configuration

Java's `ConfigSchema` is a single static registry in which **every key carries a
`Side`**, and the side determines who applies it. Do not infer a key's owner from
its name — several plausible-looking keys belong to the query client. Port the
registry's classification verbatim.

**`Side.COMMON` + `Side.INGRESS` — implemented by our sender:**

`addr` (host:port list), `username`, `password`, `token`, `tls_verify`,
`tls_roots`, `tls_roots_password`, `auth_timeout_ms`, `connect_timeout`,
`auto_flush`, `auto_flush_bytes`, `auto_flush_interval`, `auto_flush_rows`,
`close_flush_timeout_millis`, `connection_listener_inbox_capacity`,
`drain_orphans`, `durable_ack_keepalive_interval_millis`, `error_inbox_capacity`,
`initial_connect_retry`, `max_background_drainers`, `max_frame_rejections`,
`poison_min_escalation_window_millis`,
`catch_up_cap_gap_min_escalation_window_millis`, `max_name_len`,
`reconnect_initial_backoff_millis`, `reconnect_max_backoff_millis`,
`reconnect_max_duration_millis`, `request_durable_ack`, `sender_id`,
`sf_append_deadline_millis`, `sf_dir`, `sf_durability`, `sf_max_segment_bytes`,
`sf_max_total_bytes`, `sf_sync_interval_millis`, `transaction`.

`user` and `pass` are **aliases** of `username` and `password`, registered via
`alias()`; both spellings must resolve.

Plus two pre-existing Node-client keys with no Java counterpart, carried over so
`ws::` behaves like the other Node protocols: `init_buf_size`, `max_buf_size`.

**`Side.EGRESS` — accept-and-ignore.** These configure the query client, and a
shared connect string must not break the sender: `target`, `failover`,
`failover_max_attempts`, `failover_backoff_initial_ms`, `failover_backoff_max_ms`,
`failover_max_duration_ms`, `max_batch_rows`, `initial_credit`,
`buffer_pool_size`, `compression`, `compression_level`, `client_id`, `zone`.

**`Side.POOL` — accept-and-ignore.** The facade applies these and "the two
clients ignore" them, so we ignore them too rather than reject: `sender_pool_min`,
`sender_pool_max`, `query_pool_min`, `query_pool_max`, `acquire_timeout_ms`,
`query_close_timeout_ms`, `idle_timeout_ms`, `max_lifetime_ms`,
`housekeeper_interval_ms`, `lazy_connect`.

**`Side.RESERVED` — accept-and-ignore:** `on_internal_error`, `on_parse_error`,
`on_schema_error`, `on_security_error`, `on_server_error`, `on_write_error`.

**Reject:** everything else. Unknown-key rejection is required, which is exactly
why the ignore-lists must be explicit rather than a catch-all. Java implements
this the same way and comments that "forward-compat is via the spec, not silent
ignore".

**There is no `zstd` configuration key.** `zstd` is an enum *value* of the
egress-side `compression` key (`zstd` | `raw` | `auto`). Ingest-side zstd is
therefore purely a handshake negotiation (9.2) with no connect-string control —
do not invent a key for it.

### 9.1 Defaults differ from ILP — do not inherit the ILP ones

QWP's defaults come from `QwpWebSocketSender`, not from the existing Node ILP
transports (whose auto-flush row default is far higher):

| Setting | QWP default |
|---|---|
| `auto_flush_rows` | 1,000 |
| `auto_flush_bytes` | 8 MiB |
| `auto_flush_interval` | 100 ms |
| `auth_timeout_ms` | 15,000 |
| background connect timeout | 15,000 ms |
| `max_frame_rejections` | 4 |
| `poison_min_escalation_window_millis` | 5,000 |
| `sf_append_deadline_millis` | 30,000 |
| `reconnect_initial_backoff_millis` | 100 |
| `reconnect_max_backoff_millis` | 5,000 |
| `reconnect_max_duration_millis` | 300,000 |
| `catch_up_cap_gap_min_escalation_window_millis` | 300,000 |
| segment manager poll tick | 1 ms |
| catch-up packing limit when cap unadvertised | 64 KiB |
| max catch-up cap-gap attempts (orphan drainer only) | 16 |

`auto_flush_bytes` must additionally be clamped to the server-advertised
`X-QWP-Max-Batch-Size` (default 16 MiB) once the handshake completes.

### 9.2 zstd and the Node version floor

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

Fourteen stacked PRs, each independently reviewable and green. PRs 1–8 are the
wire; 9–13 are the reliability story; PR 3 is the first point at which a user
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
| 9 | ACK/NACK matrix, `defaultPolicyFor`, reconnect, replay, dict catch-up (7.5), poison detector | mock server |
| 10 | Memory-mode ring — makes publish semantics safe | mock + e2e |
| 11 | Disk segments (`SF01`), manifest, ack watermark, CRC32C, `fdatasync` | crash tests |
| 12 | `.symbol-dict` persistence + delta replay after recovery | crash tests |
| 13 | Slot locks (both kinds), orphan scan, drainers, `DATA_LOSS`/`ABANDONED` | crash tests |
| 14 | Docs, examples, README support matrix, 4.3.0 release | — |

## 12. Risks

- **Silent wire divergence.** Mitigated by golden vectors pinned to a Java SHA.
  Section 2's `schema_id` trap and section 6.3's "scale in schema" javadoc error
  are both live examples: in each case the prose was wrong and only the code was
  right. Golden vectors are generated from the *code*, which is why they are the
  primary defence rather than a nice-to-have.
- **Null compaction (6.2.1) is the single most likely correctness bug.** A
  decoder that assumes `rowCount` values instead of `valueCount` produces frames
  that are self-consistent in length but wrong in content, so the server may
  accept them and land corrupt data rather than NACK. Golden vectors must include
  a column with nulls in the first, middle, and last row, and a fully-null
  column.
- **Publish-semantics `flush()` before PR 10.** Between PR 3 and PR 10 there is
  no retention, so an unacked frame lost to a disconnect is lost. PRs 3–9 must
  document this in-tree and the feature must not be announced as
  production-ready until PR 10 lands.
- **Config-key ownership cannot be guessed.** `ConfigSchema` assigns every key a
  `Side`, and several ingest-sounding keys (`max_batch_rows`, `initial_credit`,
  `compression`, `client_id`) are `Side.EGRESS`. Port the registry as data with
  its sides intact, and add a guard test asserting our classification matches
  Java's key-for-key, rather than re-deriving it from key names.
- **Two-condition escalations.** Both the poison detector and the catch-up cap
  gap require a strike count **and** a wall-clock dwell. Implementing the count
  alone turns brief outages into producer-fatal terminals. The mock-server tests
  must include a "4 strikes inside the dwell window" case that asserts *no*
  escalation.
- **Permanent stalls that look like disk-full.** The `.symbol-dict` liveness
  floor (8.1.0.1) is the clearest example: enforce `sf_max_total_bytes` as a
  naive directory-byte sum and a producer can wedge forever, across restarts,
  while logging a trim warning that can never help. Crash tests must include a
  slot whose side files alone approach the cap.
- **Slot-lock emulation.** `O_EXCL` + pid/boot-id is weaker than `flock`, which
  the kernel releases on hard exit. A wrong liveness probe either strands data
  (too conservative) or races two processes onto one slot (too aggressive). This
  needs its own focused tests.
- **Event-loop stalls on large frames.** Encoding is synchronous. If frame
  encode time becomes a problem, the mitigation is chunking within
  `frameEncoder`, not `worker_threads`.
