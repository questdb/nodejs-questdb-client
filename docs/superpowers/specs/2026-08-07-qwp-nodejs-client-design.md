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
- **zone-aware and role-aware endpoint *ranking*** (`zone=`, `target=primary|replica`)
  — see 1.2, this is an egress-side feature and the ingest sender does not use it;
- the UDP sender;
- **payload compression** — `FLAG_ZSTD`, `X-QWP-Accept-Encoding`,
  `compression` / `compression_level` are all egress-only (9.3); the ingest path
  never compresses.

Multi-host addressing and failover **are** in scope (1.2).

Several Java classes look ingest-relevant and are not — do not port them here:

- `QwpServerInfo` / `QwpServerInfoDecoder` decode a `SERVER_INFO` frame sent by a
  QWP **egress** server as its first frame after the upgrade; the ingest path
  never receives one.
- `QwpBatchBuffer`, `QwpColumnBatch`, `RowView`, `ColumnView`, `RowCallback`,
  `QwpColumnLayout`, `QwpBindValues`, `QwpBindSetter`, `QueryEvent`,
  `QwpEgressIoThread`, `QwpResultBatchDecoder` are all result-batch decode and
  belong to the query spec.
- `QwpSpscQueue`, `NativeBufferWriter`, `SegmentedNativeBufferWriter`,
  `NativeSegmentList`, `OffHeapAppendMemory` are threading and off-heap
  allocation machinery with no Node analogue: the SPSC queue exists to hand
  frames between the producer and I/O threads, which the event loop makes
  unnecessary, and the rest are replaced wholesale by `Buffer`. Neither carries
  protocol semantics.

`QwpHostHealthTracker` **is** ported — see 1.2.

### 1.2 Multi-host addressing and failover

`addr` is a **list**, and the sender walks it. Behaviours that were vestigial
under a single endpoint are now live: the `FAILED_OVER` /
`ALL_ENDPOINTS_UNREACHABLE` events (4.2), the `421` role reject retried
indefinitely until a primary appears (6.5.1), the mid-stream cap change that
forces the snapshot-once rule (5.1), and the catch-up cap gap on a smaller-cap
node (7.5).

**What actually drives rotation is connect-time failure, not a NACK policy.**
The tracker records `TRANSPORT_ERROR` for a failed connect and `TOPOLOGY_REJECT`
for a `421` role reject, and those states demote a host in the next pick. The
`RETRIABLE_OTHER` policy (7.2) is the *mid-stream* rotation path, and its only
category — `NOT_WRITABLE` (0x0C) — is **reserved and not currently emitted by any
server** (7.1). So keep `RETRIABLE_OTHER` mapped and implemented, but do not
expect to reach it: today's servers signal the same condition with a
reconnect-eligible close, which routes through the transport path above.

#### `addr` grammar (`ConfigView.parseEntry`)

Comma-separated, IPv6-aware, and **duplicates are rejected** — the key is
`(host, port)`, so the same host twice on different ports is fine.

| Form | Meaning |
|---|---|
| `host` | default port |
| `host:9000` | explicit port |
| `[::1]:9000` | bracketed IPv6 with port |
| `[::1]` | bracketed IPv6, default port |
| `::1` | **unbracketed multi-colon = bare IPv6, default port** |

A custom port on IPv6 therefore **requires** brackets. Distinct errors exist for
a missing `]`, a non-`:` following `]`, an empty host, and a duplicate entry.
Default port for `ws`/`wss` is 9000 (3.5).

Note Java's `resolveIPv4` throws "IPv6 addresses are not supported" — that is
**UDP-only** (it needs a raw IPv4 int) and does not constrain WebSocket.

#### Endpoint selection — state-ranked, in rounds

Port `QwpHostHealthTracker`. Selection is a **round**: `pickNext()` returns the
highest-priority endpoint not yet attempted this round; the caller advances with
`beginRound()`; a round can be exhausted.

**For the ingest sender, rank by host state alone:**

`HEALTHY` → `UNKNOWN` → `TRANSIENT_REJECT` → `TRANSPORT_ERROR` → `TOPOLOGY_REJECT`

Java's full priority is the lexicographic tuple `(state, zoneTier)` with state
outranking zone — but **the ingest sender is zone-blind**. It constructs the
tracker with the single-argument form, passing `clientZone=null,
targetPrimary=false`, which collapses every host's zone tier to `SAME` and
degenerates the tuple to state alone. Zone tiers (`SAME` → `UNKNOWN` → `OTHER`)
and `target=primary` are used only by the query client.

So **do not implement zone tiers here.** That is also why `zone` and `target`
remain accept-and-ignore in section 9 even though failover is in scope: porting
zone ranking into the sender would build something Java's sender does not have.
Leave the ranking function shaped so a zone tier can be added later without
restructuring it.

#### Concurrency: drainers must not consume the shared round

`pickNext` and `recordX` are individually synchronized but **not atomic as a
pair**, so the foreground connect walk must be serialized single-file.

Background orphan drainers (8.4) must **not** consume or poison the shared
round. They take a **private round cursor** with a walker-local attempted set
(claim-at-pick, so concurrent cursors never race the pick→record pair) and record
**health-only** results — state updates flow into the shared ledger that orders
everyone's picks, but the shared round is untouched. Getting this wrong makes a
drainer silently steal endpoints from the foreground sender's round.

A third reference implementation exists for this component: the tracker mirrors
the **.NET** client's `QwpHostHealthTracker`.

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
| Third reference implementation | the **.NET** client — Java's `QwpHostHealthTracker` javadoc states it mirrors .NET's, so that is the best cross-check for endpoint selection (1.2) |

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
  endpoints.ts  hostTracker.ts
  sendLoop.ts
  transport.ts
  buffer.ts
```

- **`ws/`** — RFC 6455, hand-rolled over `net.Socket` / `tls.TLSSocket`. Ports
  Java's `WebSocketFrameParser`/`WebSocketFrameWriter` and the Rust client's
  HTTP response parser. QWP *data* frames are binary-only, always `FIN=1`, never
  fragmented, and use zstd at the protocol layer rather than
  `permessage-deflate`, so no WebSocket library is used. Control frames are still
  fully implemented (see 3.2.1) — "no fragmentation" applies to data, not to the
  RFC's control obligations.

- **`protocol/`** — pure functions over `Buffer`. No I/O, no `async`. Directly
  testable against golden vectors.
- **`sf/`** — store-and-forward. Ports `CursorSendEngine`, `SegmentRing`,
  `MmapSegment`, `SegmentManager`, `SfManifest`, `AckWatermark`,
  `PersistedSymbolDict`, `SlotLock`, `OrphanScanner`, `BackgroundDrainer`.
- **`endpoints.ts` / `hostTracker.ts`** — `addr` list parsing and the
  state-ranked, round-based endpoint selection of 1.2. Port of
  `QwpHostHealthTracker`.
- **`sendLoop.ts`** — publish → wire → ACK → trim. Port of
  `CursorWebSocketSendLoop`.

#### 3.2.1 Control frames are not optional

- **PING → PONG**, echoing the payload. A server that pings and gets no pong
  will drop the connection.
- **CLOSE → echo a CLOSE back** before closing, per RFC 6455 §5.5.1.
- Outbound PING is supported (Java exposes `sendPing`), used for liveness.
- Every client→server frame must be masked with a **fresh 4-byte key drawn
  per frame from the OS CSPRNG** (`crypto.randomFillSync`), per RFC 6455 §10.3.
  Do not seed a userspace PRNG once and reuse it.

**Control frames need their own send buffer.** Java keeps a `controlFrameBuffer`
distinct from the data send buffer precisely so emitting a pong cannot clobber an
in-progress data frame. The Node analogue: a large data frame written in chunks
under backpressure must never have a control frame interleaved into the middle of
its byte stream. Either write data frames as a single `socket.write()` call, or
queue control frames behind the in-flight frame — never both writers into one
partially-written frame.

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
| background drainer threads | async tasks, each owning its own WebSocket **and its own round cursor** (1.2) |
| lock-serialized foreground connect walk | a single in-flight connect promise; `pickNext`→`record` must not interleave (1.2) |

No `worker_threads`, no native dependencies. Two Java primitives have no core
Node equivalent and are replaced:

- **`mmap` segments** → plain files, positional writes via `fs.promises` +
  `fdatasync`. Node must copy into `Buffer`s regardless, so mmap's zero-copy
  reads buy much less here than in Java.
- **`flock` slot locks** → `O_EXCL` lockfile carrying pid + boot id, with a
  liveness probe (see 8.3).

### 3.5 Integration points in existing code

Backwards-compatible, but **not** merely "add a case" — verified against the
current `main`, the existing code branches on protocol in four places and on
`protocol_version` in a fifth.

`src/options.ts` — four edit sites:

1. The protocol token switch (`case HTTP: case HTTPS: case TCP: case TCPS:`) and
   its error string enumerating `'http', 'https', 'tcp', 'tcps'`.
2. `parseProtocolVersion` — see the hazard below.
3. `parseAddress`'s port-defaulting switch and *its own* copy of that same error
   string. `ws`/`wss` default to **9000**, the HTTP port, not 9009.
4. The `SenderOptions` doc comment listing accepted protocols.

Both error strings are very likely asserted verbatim in `sender.config.test.ts`,
so PR 3 touches those tests.

**Hazard — `createBuffer` must branch on protocol before `protocol_version`.**
(Java's stronger rule — reject an explicitly supplied `protocol_version` under
`ws::` — is in 9.2 and should be adopted alongside this.)
`parseProtocolVersion` has a `default:` arm assigning `PROTOCOL_VERSION_V1` to
any protocol that is not HTTP/HTTPS. A `ws::` sender therefore reaches
`createBuffer` carrying `protocol_version = 1`, and `createBuffer` switches on
`protocol_version` alone — so it returns `SenderBufferV1`, the **ILP text
buffer**, for a QWP sender. Silently: no error, wrong bytes on the wire. No
`protocol_version` value means QWP, so adding a case to that switch is not an
option. `createBuffer` must consult `options.protocol` first and return
`QwpBuffer` before reaching the version switch, and `parseProtocolVersion` must
leave `ws`/`wss` unset rather than stamping V1.

`SenderOptions.resolveAuto` happens to need no guard: it calls
`parseProtocolVersion`, sees a non-`auto` value and returns early, so it never
builds a `ws://host:port/settings` URL. That is accidental rather than designed,
so it warrants a regression test.

`src/transport/index.ts` — `case WS: case WSS: return new QwpTransport(options)`.

`src/sender.ts` — the public builder chain is unchanged, but two auto-flush gaps
must close (see 9.1): the client has **no `auto_flush_bytes` option at all**, and
`DEFAULT_AUTO_FLUSH_INTERVAL` is a hardcoded 1 s module constant with no
per-transport hook — unlike rows, which already delegate to
`transport.getDefaultAutoFlushRows()`.

`src/index.ts` — export the new types.

Version bump is a **minor** (4.3.0): no existing behaviour changes.

## 4. Public API

Unchanged from the user's point of view — the protocol is a connect-string
change:

```ts
// addr is a list; the sender walks it and fails over (1.2)
const sender = Sender.fromConfig("ws::addr=node1:9000,node2:9000,[::1]:9000;");
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
sender.reset();                          // discard buffered rows (see 4.1)

// three separate callback surfaces (4.2)
sender.onError((e) => { /* e.category, e.policy, e.fromFsn, e.toFsn */ });
sender.onConnectionEvent((e) => { /* e.kind, e.host, e.attempt, e.round */ });
sender.onProgress((ackedFsn) => { /* watermark advanced */ });
```

Construction may or may not connect, depending on a **derived** default — see
4.3 before assuming either.

### 4.1 `reset()` must also roll back the symbol watermark

`reset()` discards every buffered row across **all** table buffers — but
discarding rows alone is a trap. The delta section of a later flush is encoded as
`[sentMaxSymbolId + 1 .. currentBatchMaxSymbolId]`. If the discarded batch's
watermark survives, even a single-row batch after `reset()` still carries the
whole abandoned symbol range — hitting the very cap rejection `reset()` exists to
clear, and leaving the sender **unable to flush anything at all**.

So `reset()` must additionally set the batch symbol watermark back to `-1` (the
same value a successful flush leaves behind, and read as an empty delta) and
**reclaim the symbol ids that were allocated but never shipped**. This is what
1.3.7's "Return never-shipped symbol ids on reset()" does, and omitting it
produces a permanently wedged sender rather than a visible error.

`reset()` is also the documented recovery from a batch that fits no split (5.1):
it discards the retained oversized batch and leaves the sender usable.

### 4.1.1 A throwing column setter must roll back the row

This is a columnar-specific invariant with no ILP analogue, and it is easy to
miss because the row-oriented client never needed it.

In ILP a half-written row is just trailing bytes in one buffer — truncate and
continue. In QWP each column has its own value array, so a setter that throws
midway through a row leaves the table buffer **desynchronised**: some columns
hold `N` values, the ones already set hold `N+1`. Every later frame from that
buffer is then malformed, and the null-bitmap/`valueCount` accounting (6.2.1)
silently attributes values to the wrong rows.

Java wraps every column setter in `catch (RuntimeException | Error e) {
rollbackRow(); throw e; }`. The Node port must do the same: any throw from a
column setter — validation failure, cap rejection, type error — rolls the
in-progress row back to the last committed row boundary across **all** columns
before propagating.

Java also exposes `cancelRow()` for explicit abandonment. The Node `Sender` has
no such method today; adding it is optional for this stack, but the internal
rollback it shares is **not** optional. Note the interaction in 5.1.1: a
cancelled or rolled-back row can leave a symbol registered in the dictionary,
which is harmless provided the commit frame pins both delta bounds to the
baseline.

### 4.2 Three async callbacks, not one

Java exposes three separate surfaces; the Node port mirrors all three:

| Java | Fires on |
|---|---|
| `SenderErrorHandler` | rejections — carries category, policy, `fromFsn`/`toFsn`, `quarantinedPath` |
| `SenderConnectionListener` | seven kinds: `CONNECTED`, `DISCONNECTED`, `RECONNECTED`, `FAILED_OVER`, `ENDPOINT_ATTEMPT_FAILED`, `ALL_ENDPOINTS_UNREACHABLE`, `AUTH_FAILED` — all live, given multi-host (1.2) |
| `SenderProgressHandler` | the ACK watermark advancing |

They share one delivery contract that must survive the port:

- **Never invoked on the I/O or producer path.** Java uses a dedicated daemon
  dispatcher thread so a slow handler cannot stall publishing or reconnect. Node
  has no such thread, so callbacks must be dispatched via a queue drained on a
  `setImmediate`-style tick — never called inline from the socket handler.
- **Bounded inbox that drops the OLDEST.** Capacities differ per dispatcher and
  are not interchangeable: errors **256**, progress **256**, connection events
  **64** — connection events are sparse compared with per-batch server errors.
  The connect-string minimum is 16, chosen so a bursty error stream cannot let
  drop-oldest erase the trailing distribution of *categories* — 16 comfortably
  exceeds the ten categories in 7.1. When
  full, the producer drops the **head** to admit the new entry — it never
  blocks, spins, or rejects the newcomer. Drop-newest is the intuitive
  implementation and is **wrong**: watermarks are monotonic, so the newest entry
  is always the most informative, and dropping the oldest *compresses*
  information instead of losing it. This needs a deque, not a plain queue.
  Drops are counted and readable so a non-zero count tells an operator the
  handler is too slow.
- **Started lazily**, on first delivery, so a workload that never errors pays
  nothing. In Node that means not creating the dispatch machinery until the
  first notification.
- **Handlers are swappable after connect**, deliberately — installing one is not
  a pre-connect-only concern.
- **Handler exceptions are caught and logged**; the sender keeps running.
- **Close drains** remaining entries under a short deadline (100 ms in Java)
  rather than discarding them.
- **Success connection events fire on every transition; failure events may be
  coalesced** under inbox pressure. `AUTH_FAILED` fires *before* the
  corresponding error is observable on the producer side.

A connection event is not just a kind. It carries the host and port, the
**previous** host and port, an attempt number, a round number, a cause, and a
timestamp — the attempt/round pair is what makes reconnect storms diagnosable, so
carry it — with multi-host (1.2) the round number is what distinguishes one
sweep of the endpoint list from the next. `AUTH_FAILED`'s cause
is the auth failure from the upgrade (6.5.1), which is how the terminal
credential case reaches the listener before the producer-side throw.

Progress-handler semantics are narrower than they look: the watermark advances
**only on server OK frames** — a rejection never advances it — values are
strictly increasing, and one call may skip several FSNs when the server batches
frames into a single OK. Callers should compare `ackedFsn` against a target
rather than assume one call per flush.

**A plain OK is not durability.** In non-durable-ack mode an OK acknowledges
server-side *commit*, not object-store durability. Anything gating downstream
side effects on durability must opt into `request_durable_ack`. This distinction
belongs in the README, not just here.

### 4.3 Connect timing — and a default that changes it silently

The spec has said nothing about *when* the initial connection happens. Java has
three modes — `OFF`, `SYNC`, `ASYNC` — and, crucially, **the default is derived
from other keys**:

- if any `reconnect_*` key is set (`reconnect_max_duration_millis`,
  `reconnect_initial_backoff_millis`, `reconnect_max_backoff_millis`) → **SYNC**:
  construction connects, retrying under that budget;
- otherwise → **OFF**: construction does not connect.

The reasoning is worth keeping. The `reconnect_*` knobs read as a generic retry
budget, but the underlying path governs only reconnects *from an already
established connection*. A user who sets a retry budget and then gets no retry on
the very first connect has hit what Java calls "the canonical footgun"; the
implicit upgrade to `SYNC` removes it.

So setting a `reconnect_*` key changes construction from non-connecting to
connecting. Port the derivation, not just the modes — implementing the three
modes with a fixed default reintroduces exactly the footgun the derivation
exists to remove. `initial_connect_mode` itself is builder-only and is **not** a
connect-string key; `initial_connect_retry` is the connect-string key in this
area.

### 4.4 Flush semantics

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
   -> auto_flush_rows | auto_flush_interval, or flush()
      (auto_flush_bytes is a fourth trigger but is OFF by default -- see 9.1)
   -> frameEncoder.seal(): all dirty tables -> ONE frame, assigned an FSN
      (no compression on the ingest path -- see 9.3)
      ...unless the encoded frame exceeds the server's cap, in which case
      it is split -- see 5.1
   -> sf.append(frame)              <-- flush() resolves here
   -> sendLoop: frames after sentFsn -> WS binary frames, honouring
      socket.write() backpressure and the server's X-QWP-Max-Batch-Size
   -> ACK -> ackedFsn advances -> ring trims -> space frees
```

### 5.1 Splitting a flush that exceeds the server cap

When the combined encoded frame exceeds `serverMaxBatchSize` (from
`X-QWP-Max-Batch-Size`), the flush is split so that **each non-empty table gets
its own message**. All messages except the last carry `FLAG_DEFER_COMMIT` — the
server appends without committing — and the final message omits it, triggering
the commit for the whole set. If the user already enabled deferred commit, *all*
messages carry the flag.

Two rules make this safe, and both are easy to omit:

**Pre-flight every split frame before publishing any of them.** If a later
table's frame is only discovered oversized mid-publish, the already-published
prefix strands on the ring and a subsequent commit delivers it as a *partial
batch*.

**Snapshot the cap exactly once per flush.** `serverMaxBatchSize` is mutable: the
I/O side lowers it on a mid-stream failover to a smaller-cap node. Dictionary
pre-registration, the split pre-flight and the publish loop must all use one
snapshot taken at the top of the flush; if they re-read it independently, a
failover *between* the reads sizes frames against different caps and breaks the
all-or-nothing guarantee. In Node every `await` inside the flush is exactly that
failover window, so this must be a local variable, not a field read.

**A batch that fits no split needs its own error type.** When a batch cannot fit
the cap *however* it is divided, Java raises a distinct
`BatchTooLargeForCapException` rather than a generic error, and the distinction
is load-bearing rather than cosmetic:

- the batch is **retained**, so it can still go out later against a larger-cap
  node;
- `close()` must **recognise the type and discard the batch**, because letting it
  escape would skip commit and drain and abandon every row an earlier successful
  flush already published (8.3.1);
- `reset()` discards the retained batch and leaves the sender usable — the
  non-destructive recovery;
- Java notes explicitly that matching on the message text instead would silently
  swallow unrelated failures.

So this must be a real error class in the Node port, not a string check.

**The split is deliberately not atomic across frames.** A publish failure at
frame `k > 1` — in Node, the `sf_append_deadline_millis` backpressure deadline
(5.3 removes Java's other cause, the buffer-recycle timeout) — leaves frames `1..k-1` on
the ring as deferred-but-uncommitted. The error propagates past the
reset-table-buffers step, so the source rows survive and the *next* flush re-emits
the whole batch; the eventual commit then commits the already-published prefix
alongside the re-sent copies. Those rows are therefore delivered
**at-least-once (duplicated), not exactly-once**. This is within
store-and-forward's at-least-once contract — a DEDUP table or a durable-ack await
absorbs the duplicate — and the symbol-dict state stays consistent on retry,
because the re-sent frames carry empty deltas. Document it; do not quietly
promise exactly-once.

### 5.1.1 The commit frame

Deferred commits need a message that commits without carrying data. It is a
normal QWP frame with `tableCount = 0`, no rows, `FLAG_DEFER_COMMIT` **cleared**
— and, critically, **no symbols**.

The empty delta must be produced *by construction*, by passing the current
baseline as **both** bounds so the range is `[baseline+1 .. baseline]`. This is
the only shape that is unconditionally correct in both dictionary modes (5.2):

- **Delta mode** — the commit path does *not* write-ahead-persist the dictionary
  (8.1.5). Shipping a symbol here would put an id on the wire that a recovered
  slot cannot rebuild from `.symbol-dict`, diverging the producer's dictionary
  from the surviving frames and **silently misattributing reused ids after a
  crash**.
- **Full-dict mode** — the baseline is `-1`, so the frame carries `deltaStart 0`
  with a zero count. Nothing needs registering; the group's data frames already
  did it.

Deriving the upper bound from the current batch's max symbol id instead is a
**bug Java already fixed**, and the failure mode is worth knowing because it is
invisible in the common case. That value is not reliably reset: `flushPendingRows`
returns early without clearing it when there are no pending rows or every table
is empty, and `cancelRow` leaves a registered symbol's id behind. A commit
reaching that window re-shipped the **entire dictionary from id 0**, in a frame
that no cap check and no chunker covers — reintroducing the oversized-frame wall
on the single path that bypasses the splitter (5.1).

Any symbol leaked by a cancelled row is picked up by the next real flush, whose
write-ahead persist resumes from the persisted dictionary's size. The commit
frame also sets the last-commit-boundary FSN, which close-time drain depends on
(8.3.1).

### 5.2 Two symbol-dictionary modes, not one

The delta dictionary is not simply on or off:

- **Full-dict mode** — every frame is self-sufficient, carrying the whole
  dictionary from id 0. Recovery or orphan-drain replay to a fresh server can
  therefore never dangle a symbol id.
- **Delta mode** — each frame carries only ids above the last shipped id. Used in
  memory mode, and in disk mode *once the persisted `.symbol-dict` has opened*.
  Safe only because a reconnect re-registers via the catch-up frame (7.5) and
  recovery reseeds from the persisted file (8.1.5).

The mode is therefore a consequence of what durable state exists, not a user
toggle. A build that has delta encoding but no `.symbol-dict` must use full-dict
mode — which is what makes PR 6 shippable before PR 14.

### 5.3 The staging buffer and its swap

Sections 5.1 and 8.3.1 refer to "seal and swap the buffer" without saying what
is swapped. Java stages encoded messages in a `MicrobatchBuffer` between the
encoder and the SF ring, with a four-state lifecycle —
`FILLING → SEALED → SENDING → RECYCLED` — and keeps **two** of them.

`sealAndSwapBuffer` does, in order:

1. return immediately if the active buffer holds no data (this is why an empty
   flush publishes nothing, and part of why the commit frame cannot rely on
   batch state being reset — 5.1.1);
2. seal the active buffer;
3. swap the *other* buffer in as active;
4. **if that buffer is still in use, wait for it to be recycled**, bounded at
   30 s, throwing "Timeout waiting for buffer to be recycled" on expiry — this is
   the buffer-recycle timeout — which the Node port does **not** inherit, per the
   decision below;
5. reset the newly active buffer;
6. mark the sealed buffer `SENDING` and hand it to the engine, which appends and
   returns once published.

The buffer stays pinned until the wire send completes, which is what the second
buffer is for: the producer keeps filling while the previous batch is in flight.

**Node decision: copy on append.** The pin exists because the buffer is read
asynchronously after handoff, and in Node that hazard recurs at every `await`
inside append. The segment write takes ownership of its own bytes, so **one**
staging buffer suffices and the swap machinery disappears entirely.

This is the decision, not a recommendation: Node must copy into a `Buffer` for
the write regardless, so the copy Java's double-buffering avoids is not actually
avoidable here — we would pay it *and* carry a timeout error path. Consequently
the 30 s recycle wait has **no Node analogue** and must not appear as a failure
cause anywhere in this spec (5.1 has been corrected accordingly).

*Rejected alternative:* port the two-buffer swap with an equivalent bounded wait.
It reproduces a timeout that cannot fire for any reason a Node implementation
would recognise, and buys nothing, since the copy it exists to avoid is
unavoidable.

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

`payloadLen` counts the payload **only**; total message length is
`HEADER_SIZE + payloadLen`. One QWP message is carried as exactly one WebSocket
binary frame — the QWP header is the first byte of the WS payload, never split
across frames.

Flags: `DEFER_COMMIT 0x01`, `GORILLA 0x04`, `DELTA_SYMBOL_DICT 0x08`,
`ZSTD 0x10`.

An ingest client sets at most the first three. **`ZSTD` is egress-only** — it
appears on `RESULT_BATCH` frames and is never set by a sender (9.3).

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

### 6.3.2 Gorilla bitstream

The delta-of-delta stream, in full — this is the one codec where reading the
Java beats guessing and re-running golden vectors.

```
DoD = (t[n] - t[n-1]) - (t[n-1] - t[n-2])

DoD == 0                 -> '0'               1 bit
DoD in [-64, 63]         -> '10'   + 7 bits   9 bits
DoD in [-256, 255]       -> '110'  + 9 bits   12 bits
DoD in [-2048, 2047]     -> '1110' + 12 bits  16 bits
otherwise (fits int32)   -> '1111' + 32 bits  36 bits
```

- **The first two timestamps ship uncompressed**, 8 bytes each; only `t[2]`
  onward enter the bitstream. Encoded size is
  `8 + 8 + ceil(totalBits / 8)` for `count > 2`, `8` for `count == 1`, `16` for
  `count == 2`, `0` for `count == 0`.
- Bucket ranges are ordinary two's-complement signed ranges, so a value is
  emitted as its low *n* bits.
- Bits are packed **LSB-first within each byte**, the same order as the null
  bitmap (6.2.1). Trailing partial bits are zero-padded to a byte boundary.
- Pre-validate before encoding: if any DoD falls outside signed int32, Gorilla
  is unusable for that column — emit `ENCODING_UNCOMPRESSED` (`0x00`) and raw
  int64s instead (6.3.1). Java computes feasibility and encoded size in a single
  pass and returns `-1` for "cannot encode".

**The prefix constants are bit-reversed relative to how they read.** Because
packing is LSB-first, `writeBits(value, n)` emits bit 0 of `value` first, so the
logical prefix string must be reversed when expressed as a number:

| Logical prefix | Value passed | Width |
|---|---|---|
| `'0'` | `0b0` | 1 |
| `'10'` | `0b01` | 2 |
| `'110'` | `0b011` | 3 |
| `'1110'` | `0b0111` | 4 |
| `'1111'` | `0b1111` | 4 |

Writing `0b10` for `'10'` is the obvious mistake and produces a stream that
decodes into plausible-but-wrong timestamps rather than failing loudly. Java's
encoder carries a javadoc table saying exactly this, which is a good sign it has
caught people before.

Client and server bucket constants were confirmed identical, and the server's
encoder javadoc states the two share a wire format with the decoder.

### 6.4 Limits (mirror server constants; enforce client-side before sending)

`MAX_COLUMNS_PER_TABLE` 2048 · `MAX_COLUMN_NAME_LENGTH` 127 ·
`MAX_TABLE_NAME_LENGTH` 127 · `MAX_SYMBOL_DICTIONARY_SIZE` 1,000,000 ·
`DEFAULT_MAX_ROWS_PER_TABLE` 1,000,000 ·
`DEFAULT_MAX_TABLES_PER_CONNECTION` 10,000 ·
`DEFAULT_MAX_BATCH_SIZE` 16 MiB (the server advertises the real value via
`X-QWP-Max-Batch-Size`).

`tableCount` is a `u16`, so 65,535 is a hard structural ceiling independent of
`DEFAULT_MAX_TABLES_PER_CONNECTION`.

The symbol cap must be enforced at registration time, before the row is
buffered, so that everything already buffered references ids the server will
accept.

### 6.5 Handshake

Request: `GET /write/v4` with `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`,
`X-QWP-Client-Id`, `X-QWP-Max-Version: 1`, and `Authorization: Basic|Bearer`
derived from `username`/`password`/`token`.

Auth selection is validated, not inferred:

- `username` and `password` must be supplied **together** — either half alone
  throws "username and password must be provided together";
- `token` is **mutually exclusive** with `username`/`password` — "cannot use both
  token and username/password authentication";
- the setters are one-shot: configuring either mechanism twice throws "already
  configured" rather than last-write-wins.

Java notes it deliberately emits *the same message text* as the egress query
client for the first rule, so a connect string shared between a sender and a
query client fails identically on both sides. The Node port should match those
strings for the same reason — someone debugging a shared `ws::` string should
not get two different diagnoses from two clients.

`X-QWP-Client-Id` follows Java's convention of `<lang>/<protocol-client-version>`
— Java 1.3.7 sends the constant `"java/1.0.2"`, which is deliberately **not** the
artifact version. Node therefore sends `nodejs/<qwp-client-version>` from a
dedicated constant, not `package.json`'s version.

From the `101` response read: `X-QWP-Version`, `X-QWP-Max-Batch-Size`,
`X-QWP-Content-Encoding`, `X-QWP-Durable-Ack`, `X-QuestDB-Role`,
`X-QuestDB-Zone`.

### 6.5.1 Upgrade failure classification

A non-101 response is not one error. Java classifies three ways, and getting
this wrong inverts the retry behaviour — a credential failure retried forever, a
transient role reject treated as fatal:

| Response | Meaning | Handling |
|---|---|---|
| `421` **with** an `X-QuestDB-Role` header | Role reject: this node cannot accept writes (read-only replica, demoting primary) | **Retried indefinitely** — never terminal. This is the connect-time half of the read-only case whose mid-stream half arrives as a reconnect-eligible close (7.4). |
| `401` / `403` | Credential failure | Terminal. Emits `AUTH_FAILED` on the connection listener *before* the producer-side error becomes observable (4.2). |
| anything else, **including `404`** | Generic upgrade failure — `404` specifically means a per-endpoint path mismatch | Surfaced as-is; not specially classified. |

The `421` rule is why §8.4 can say a transient all-replica window is never
quarantined on a wall-clock budget: connect-time role rejects retry forever by
design.

**A successful 101 can still fail**, in two ways the above table does not cover:

- **Unsupported `X-QWP-Version`.** The upgrade completed but the server
  advertised a version outside our range. This is **transient at every layer**
  and must never be classified as a security error: a rolling upgrade can leave
  one node ahead of its peers. The background reconnect loop retries
  indefinitely; a blocking initial connect consumes its retry budget and only
  then surfaces an error. Implementing "unsupported version" as fatal — the
  obvious reading — is backwards.
- **Durable-ack capability gap.** `request_durable_ack=on` but the server did not
  echo `X-QWP-Durable-Ack: enabled` (or every endpoint role-rejected, so no
  primary was reached). This one **is terminal and fails fast**: retrying the
  same endpoints will not turn a non-primary into a durable-ack-capable primary,
  so it must not burn the reconnect budget.

Note the asymmetry — version mismatch retries forever, durable-ack mismatch
fails immediately — and that both arrive *after* a successful handshake.

### 6.5.2 TLS — `tls_roots` does not port directly

**All three TLS keys require the `wss::` schema.** Supplying `tls_verify`,
`tls_roots` or `tls_roots_password` with plain `ws::` throws
"tls_verify/tls_roots/tls_roots_password require the wss:: schema" — they are not
silently ignored. `tls_roots_password` additionally requires `tls_roots`.

`tls_verify` maps cleanly: `on` → default verification, `unsafe_off` →
`rejectUnauthorized: false`. Java additionally enforces that **a custom trust
store may not be combined with disabled validation** (its constructor throws);
reproduce that validation rather than silently ignoring one of the two.

`tls_roots` / `tls_roots_password` do **not** port cleanly. Java takes a
`trustStorePath` plus a `char[]` password — a JVM keystore. Node's `tls.connect`
accepts `ca` as PEM, or `pfx` + `passphrase` for PKCS#12. **JKS is not readable
by Node at all**, and no amount of option-mapping changes that.

Decision for this stack: accept **PEM** for `tls_roots` (mapped to `ca`, password
ignored, and warn if one is supplied since PEM roots are not encrypted), and
accept **PKCS#12** (`.p12`/`.pfx`, mapped to `pfx` + `passphrase`). Detect a JKS
file by its magic bytes (`0xFEEDFEED`) and fail with an explicit "JKS keystores
are not supported by the Node client; convert to PKCS#12 or PEM" — not a parse
error. A connect string that works against Java may therefore fail here, so this
belongs in the README's compatibility notes, not only in this spec.

### 6.5.3 Per-column accumulation rules (PR 4 / PR 5)

These live in `QwpTableBuffer.ColumnBuffer` and are the substance of PRs 4 and 5.
None are inferable from the wire format alone.

**Row and column lifecycle**

- **Columns are created on first sight and their type is locked.** A later value
  of a different type for the same name throws a type-mismatch error naming both
  types. Column count is capped at `MAX_COLUMNS_PER_TABLE` (2048) at creation.
- **Column names** must be non-empty, pass QuestDB's valid-name check, and be
  ≤ 127 bytes. "Too long" and "illegal characters" are *distinct* errors.
- **Duplicate column within one row: first value wins, silently.** If a column
  already holds a value for the in-progress row, the second write is ignored with
  no error — matching ILP server behaviour. Detected as
  `column.size > rowCount`.
- **Row completion back-fills nulls.** At end-of-row every column that did not
  receive a value this row has a null appended, so all columns stay at equal
  length. This is the mechanism behind the null bitmap (6.2.1), and it is the
  same invariant that a throwing setter must not break (4.1.1).
- **Per-row size guard.** After back-filling, a row whose encoded size exceeds
  the server batch cap throws "row too large for server batch cap". This is a
  *per-row* check, separate from the per-frame split in 5.1 — a single row larger
  than the cap can never be sent by any split, so it fails early rather than
  wedging the splitter.

**Type-specific rules**

| Type | Rule |
|---|---|
| GEOHASH | Precision is 1–60 and **locked on the column's first value**; a differing precision throws. This is why the wire carries one precision varint per column (6.3). |
| DECIMAL64/128/256 | Scale is **locked on the first value**, and a later value with a different scale is **automatically rescaled** to the column's scale — not rejected. Rescaling throws if it would lose precision, or if the result exceeds the type's capacity (e.g. "Decimal128 overflow"). |
| BINARY | A null must be expressed via the null bitmap, never as a null value or negative length — both throw. A non-empty value with a zero pointer throws. |
| DOUBLE_ARRAY / LONG_ARRAY | Shapes must be regular; jagged input throws "irregular array shape". Supplying more values than the declared shape throws. Total element count must fit in an int. |
| VARCHAR / BINARY | Aggregate string data is capped at **2 GiB per batch**; the error tells the caller to flush more frequently. |
| SYMBOL | A column may not mix global symbol ids with local dictionary values; doing so throws. This falls out of the two dictionary modes (5.2) — the mode is per-connection, so a column must not straddle it. |

The decimal auto-rescale is the one most likely to be mis-ported as a simple
lock-and-reject. It changes user-visible behaviour: writing `1.5` then `1.25` to
a scale-1 column is an error, while `1.25` then `1.5` is not.

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
| `RETRIABLE_OTHER` | same replay, but rotate to the next endpoint rather than back off against the same node. **Unreachable today** — its only category `NOT_WRITABLE` is reserved (7.1); real rotation comes from connect-time failures (1.2) |
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

Memory mode (PR 12) and disk mode (PR 13) share the ring **and the segment
abstraction**: Java's `MmapSegment` has a `memoryBacked` flag selecting a
malloc'd buffer instead of a file mapping, with the same cursor architecture.
Port that flag rather than writing two segment types.

**Publish barrier.** Each segment carries an `appendCursor` (producer-only) and a
`publishedCursor`. The consumer **must not read any byte at offset
`>= publishedOffset()`**. That single rule is what makes the whole thing
lock-free, and it is easy to lose in a port where `await` interleaves differently
than Java's threads.

### 8.1.1 Hot-spare provisioning — the producer never creates a segment

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

### 8.1.2 The `.symbol-dict` liveness-floor deadlock — do not reintroduce

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

### 8.1.3 Two distinct append failures

`SegmentRing.appendOrFsn` has two sentinels and they need opposite handling:

| Sentinel | Meaning | Handling |
|---|---|---|
| `BACKPRESSURE_NO_SPARE` (-1) | active is full, no spare ready | wait — the manager or an ACK will clear it; this is the `sf_append_deadline_millis` path |
| `PAYLOAD_TOO_LARGE` (-2) | the frame does not fit in a **fresh** segment | never clears; surface a user-facing error immediately |

Treating `PAYLOAD_TOO_LARGE` as backpressure would burn the full append deadline
before failing, and report a timeout instead of the real cause.

### 8.1.4 Segment file format (`MmapSegment`)

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

### 8.1.5 Persisted symbol dictionary — load-bearing, not an optimisation

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

`sf_durability` **parses** four values but only **two are usable**:

| Value | Meaning |
|---|---|
| `memory` | **Default.** Never fsync explicitly — bytes live in the OS page cache. Survives a **process** crash, **not** an OS or power crash. Lowest latency. |
| `periodic` | Background checkpoint of published frames every `sf_sync_interval_millis`. The interval is a *target cadence*: scheduler and storage latency add to the real power-loss window, so it is not a bound. |
| `flush` | Reserved for a future synchronous `flush()` barrier — rejected by `build()`. |
| `append` | Reserved for a future per-append barrier — rejected by `build()`. |

Implement all four in the parser so a user of the reserved pair gets "not yet
supported (use sf_durability=memory or periodic)" rather than "unknown value",
and reject them at construction.

**Disk mode alone is not power-loss durability.** `sf_dir` selects disk mode
(9.2), but durability still defaults to `memory` — files are written and never
explicitly synced. Power-loss survival requires `sf_durability=periodic`, which
in turn requires `sf_dir`. Section 8.1.5's note that `.symbol-dict` is
"page-cache durable, not host-crash durable" is the same property, and it applies
to the segments too under the default.

See 9.2 for the cross-key rules binding these together.

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

A slot is `<sf_dir>/<sender_id>/`, and `sender_id` defaults to `"default"`. That
default is fine for a single sender and is a **footgun for two**: a second sender
sharing `sf_dir` without its own `sender_id` fails at startup with "sf slot
already in use". That is the intended behaviour (8.1's single-producer rule), so
the error must name `sender_id` as the fix rather than reading as a mystery
lock conflict.

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

The suppression test is narrower than it looks, and getting it wrong disables the
safety net. Java tracks **two** facts: whether a custom handler ever received
*any* error, and whether it received **the** terminal error — the exact one the
I/O loop latched. `close()` consults only the second. Using the first would let a
routine `RETRIABLE` rejection delivered minutes earlier suppress the close-time
report of a later, genuinely unsurfaced `TERMINAL` error. "Any error ever" is too
coarse a signal to gate this on.

**Close bounds the wait, not the connect.** The close-time shutdown await
(30 s by default) caps how long `close()` waits for the I/O side to finish its
current send/receive and unwind — it is *not* a connect timeout. A `close()`
racing an in-flight connect **cancels** that connect rather than waiting it out,
so a legitimately slow successful connect is never truncated by this bound.

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

**Quarantine is a rename plus a sentinel, and it is capped.** Setting a torn slot
aside is two steps, not one:

1. **Rename** the slot to carry a quarantine infix — deliberately *not* the
   sender's own slot name, so a restarting sender does not re-adopt it as its
   own working slot;
2. **mark it `.failed`**, so the orphan drainer skips it too.

Both are needed: the rename stops the owner reclaiming it, the sentinel stops the
drainer replaying it, and between them the bytes stay put for a human to inspect
and resend.

At most **64** quarantined copies of one slot may accumulate under `sf_dir`
before construction refuses to set aside another. Each is an unreplayable slot
someone must look at, and letting them pile up without bound turns a disk-space
problem into a second incident.

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

`addr` (comma-separated host:port list — grammar in 1.2), `username`, `password`,
`token`, `tls_verify`,
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

Two of those names do not say what they do: **`transaction`** is the
defer-commit switch (5.1.1, `FLAG_DEFER_COMMIT`), and **`sf_dir`** is what
selects disk mode — there is no `store_and_forward` key (9.2).

`user` and `pass` are **aliases** of `username` and `password`, registered via
`alias()`; both spellings must resolve.

Plus two pre-existing Node-client keys with no Java counterpart, carried over so
`ws::` behaves like the other Node protocols: `init_buf_size`, `max_buf_size`.

**`Side.EGRESS` — accept-and-ignore.** These configure the query client, and a
shared connect string must not break the sender. This still holds with failover
in scope (1.2): the ingest sender always walks the `addr` list, ranked by host
state, with no on/off switch and no zone/role input — its retry budget comes from
the `reconnect_*` keys, which are `Side.INGRESS`. The `failover_*`, `target` and
`zone` keys tune the *query* client's selection, so the sender accepts and
ignores them: `target`, `failover`,
`failover_max_attempts`, `failover_backoff_initial_ms`, `failover_backoff_max_ms`,
`failover_max_duration_ms`, `max_batch_rows`, `initial_credit`,
`buffer_pool_size`, `compression`, `compression_level`, `client_id`, `zone`.

`client_id` being egress-side does **not** mean the sender omits
`X-QWP-Client-Id`. The sender always sends its own constant (6.5); the
connect-string key only lets a *query* client override its identifier, so we
accept and ignore it while still emitting the header.

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

**There is no `zstd` configuration key, and no ingest-side compression at all
(9.3).** `zstd` is an enum *value* of the egress-side `compression` key
(`zstd` | `raw` | `auto`), which configures how the server compresses **result
batches**. Do not invent an ingest compression key, and do not implement ingest
compression.

### 9.1 Defaults differ from ILP — do not inherit the ILP ones

QWP's defaults come from `QwpWebSocketSender`, not from the existing Node ILP
transports (whose auto-flush row default is far higher). Two rows below are
**not** merely different defaults — they are functionality the Node client does
not have yet:

- **`auto_flush_bytes` does not exist** in the Node client at all. Byte-based
  auto-flush must be added to `Sender`, not just defaulted.
- **`auto_flush_interval` has no per-transport hook.** It is a hardcoded 1 s
  module constant in `sender.ts`; rows already delegate to
  `transport.getDefaultAutoFlushRows()`, and the interval needs the same
  treatment to reach QWP's 100 ms.

| Setting | QWP default |
|---|---|
| `auto_flush_rows` | 1,000 |
| `auto_flush_bytes` | **off (0)** — see below |
| `auto_flush_interval` | 100 ms |
| `sf_max_segment_bytes` | 4 MiB |
| `sf_max_total_bytes` | **mode-dependent**: 128 MiB memory, 10 GiB disk |
| `sf_sync_interval_millis` | 5,000 |
| `max_background_drainers` | 4 |
| `max_name_len` | 127 |
| `sender_id` | `"default"` |
| `sf_durability` | `memory` (8.2 — **not** power-loss durable) |
| `sf_dir` | unset ⇒ **memory mode** (9.2) |
| `drain_orphans` | **off** — see below |
| `request_durable_ack` | off |
| `transaction` (defer commit) | off |
| `durable_ack_keepalive_interval_millis` | 200 (≤ 0 disables) |
| close shutdown await | 30,000 |
| max quarantined copies per slot | 64 |
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
| `error_inbox_capacity` | 256 (config minimum 16) |
| `connection_listener_inbox_capacity` | **64** (config minimum 16) |
| progress inbox capacity | 256 |
| catch-up packing limit when cap unadvertised | 64 KiB |
| max catch-up cap-gap attempts (orphan drainer only) | 16 |

**Orphan draining is off by default**, and that combination deserves stating
plainly: with `sf_dir` set but `drain_orphans` unset, a crashed process's slot is
written to disk, survives, and is **never drained automatically**. Nothing
replays it until an operator enables the flag or another sender adopts the slot.
The default is defensible — draining opens background connections at startup —
but a user who configures `sf_dir` expecting crash recovery gets durability
without recovery unless they also opt in. This belongs in the README next to
`sf_dir`, not only here.

**Byte-based auto-flush is off by default on WebSocket.** The builder's WS
default is `0`, which is exactly what `auto_flush_bytes=off` sets — so the
trigger is rows and interval only. `QwpWebSocketSender.DEFAULT_AUTO_FLUSH_BYTES`
(8 MiB) is *not* the effective default; defaulting to it would make the Node
client flush on a trigger Java does not use.

When a byte trigger *is* set, it is clamped to the server-advertised
`X-QWP-Max-Batch-Size` (default 16 MiB) after the handshake. But an explicit
`off` is **preserved** even when the server advertises a cap — an application
that opted out keeps the contract it asked for. Oversize rows are still caught
by the per-row guard against `serverMaxBatchSize` (6.5.3), which is what makes
opting out safe.

### 9.1.1 Value grammars — `ConfigSchema` does not define these

`ConfigSchema` registers most ingest keys as plain strings and leaves the value
grammar to the sender's own parsers. Mirroring the key *names* without the
grammars produces silent misconfiguration.

**Byte-count values** (`auto_flush_bytes`, `sf_max_total_bytes`,
`sf_max_segment_bytes`, buffer sizes) accept a plain decimal or a unit suffix:

- `64k` / `64kb`, `64m` / `64mb`, `4g` / `4gb`, and `2t` / `2tb`
  — note the code handles `t`, though its own javadoc lists only k/m/g;
- suffixes are **case-insensitive**, and a trailing `b`/`B` is stripped first;
- multipliers are **powers of 2** (1024-based), not 1000;
- blank is rejected with "<name> cannot be empty"; a bare suffix is rejected.

A Node port that reaches for `parseInt` reads `auto_flush_bytes=64m` as **64
bytes** — a flush per row, with no error. That is the single most likely silent
misconfiguration in the whole config surface.

**Enum values** are case-insensitive: `sf_durability` ∈ {`memory`, `periodic`,
`flush`, `append`}, rejected with the allowed set named. `auto_flush` and the
other on/off keys take `on`/`off`.

### 9.1.2 "Unset" and "set to the default" must stay distinguishable

Java threads a `PARAMETER_NOT_SET_EXPLICITLY` sentinel through every numeric
option rather than pre-seeding defaults, and the comment states why: it wants to
**fail fast even when an explicitly configured value happens to equal the
default**, because the combination is still a user error and silently accepting
it produces hard-to-debug behaviour.

This is a real constraint on the Node port, not a Java idiom. The natural JS
shape — `const x = options.x ?? DEFAULT` — collapses "unset" and "set to the
default value" into one state, and several rules in 9.2 depend on telling them
apart: rejecting `protocol_version` under `ws::` must fire even if the user
supplied the value the ILP path would have chosen, and the connect-mode
derivation in 4.3 keys on whether a `reconnect_*` key was *supplied*, not on its
value. Keep options as `undefined`-until-set and resolve defaults at the point of
use.

### 9.2 Cross-key validation

Java validates combinations at construction, not just individual values. The spec
previously had none of this, and several rules are load-bearing.

**Every ingest QWP key is WebSocket-only.** Not just `sf_durability` and
`sf_sync_interval_millis` as 8.2 implied — the whole `Side.INGRESS` set throws
"<key> is only supported for WebSocket transport" when combined with `http::` or
`tcp::`. Reproduce this per key so a misplaced key names itself.

**Keys rejected *for* WebSocket** — these are ILP-only and must error, not be
silently ignored:

| Rejected with `ws::` | Message |
|---|---|
| `protocol_version` | "protocol version is not supported for WebSocket protocol" |
| `auto_flush=off` (interval disabled) | "disabling auto-flush is not supported for WebSocket protocol" |
| ILP `max_backoff` | "max backoff is not supported for WebSocket protocol" |

The `protocol_version` rule is stronger than 3.5 assumed. 3.5 says
`parseProtocolVersion` must leave `ws`/`wss` unset; Java additionally makes an
*explicitly supplied* `protocol_version` an error under `ws::`. Adopt that — it
converts the silent-ILP-fallback hazard into a loud failure.

Note also that auto-flush cannot be fully disabled on WebSocket, which follows
from 9.1: with `auto_flush_bytes` off by default, the interval and row triggers
are the only ones left.

**Dependency rules:**

- `sf_durability=periodic` **requires** `sf_dir`.
- `sf_sync_interval_millis` **requires** `sf_durability=periodic`.
- `drain_orphans` **requires** `sf_dir`.
- `tls_roots` **cannot** be combined with `tls_verify=unsafe_off`. Java's message
  names both escapes — "remove tls_verify to use custom roots, or remove
  tls_roots to disable certificate validation" — and is worth copying verbatim.
- `tls_roots_password` **requires** `tls_roots`.
- All three TLS keys **require `wss::`** — rejected under plain `ws::` (6.5.2).
- `username` **requires** `password` and vice versa; `token` **excludes** both
  (6.5).
- WebSocket requires at least one `host:port` pair in `addr` (1.2); an empty
  `addr` fails with "addr is missing".

**Mode selection is implicit.** There is no `store_and_forward=on` key: **`sf_dir`
present means disk mode, absent means memory mode.** That single fact drives
memory-vs-disk throughout section 8, including the mode-dependent
`sf_max_total_bytes` default (9.1), and the spec never stated it.

### 9.3 There is no ingest-side compression

**Correction to an earlier decision.** This spec previously required zstd on the
ingest path, feature-detected against Node's `zstdCompress` (which landed in
22.15.0) so the Node 20 floor could be kept. That was built on a false premise.

`FLAG_ZSTD` is **egress-only**. The server-side constant is explicit: *"Set only
on `RESULT_BATCH` frames and only after the handshake negotiated zstd."* Every
reference to it in the Java client is on the decode side —
`QwpResultBatchDecoder`, `QwpQueryClient`, and a comment in `WebSocketClient`.
The ingest encoder sets `FLAG_GORILLA` and ORs in `FLAG_DELTA_SYMBOL_DICT`, and
**never sets `FLAG_ZSTD`**.

The negotiation is likewise about the *response* direction. The client sends
`X-QWP-Accept-Encoding` (e.g. `zstd;level=1,raw`) to tell the server how to
compress **result batches**; when the header is omitted the server ships them
uncompressed. The echoed `X-QWP-Content-Encoding` is parsed only so callers can
observe the level the server actually applied.

Consequences:

- the ingest sender performs **no compression at all**, and PR 8 carries only
  defer-commit and the commit frame;
- the Node version floor question **evaporates** — nothing on this path needs
  `zstdCompress`, so Node 20 is fine for reasons that have nothing to do with
  feature detection;
- `compression` / `compression_level` are `Side.EGRESS` (section 9) precisely
  because they configure this, which is corroborating evidence rather than a
  coincidence;
- compression belongs to the query spec, alongside `X-QWP-Accept-Encoding` and
  `X-QWP-Max-Batch-Rows`.

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
   poison-detector escalation. A real QuestDB will not produce `INTERNAL_ERROR`
   or a torn frame to order. It must also be startable as **several endpoints at
   once**, to exercise 1.2: rotation on a transport failure, a `421` role reject
   that resolves when a primary appears, `FAILED_OVER` and
   `ALL_ENDPOINTS_UNREACHABLE`, state ranking preferring a known-good host over
   an untried one, and a drainer's private cursor not consuming the foreground
   round. Escalation needs **both** its conditions exercised
   (7.4): a case that accrues 4 strikes *inside* the dwell window and asserts
   that escalation does **not** fire, alongside one that crosses both.
3. **Testcontainers integration.** Extends the existing
   `sender.integration.test.ts` pattern: ingest over `ws://`, then verify via SQL
   that rows, types, nulls and symbols landed exactly. Requires an image with
   QWP ingress enabled.
4. **Crash-recovery tests.** Spawn a child process, ingest, `SIGKILL` mid-flight,
   then assert a fresh Sender recovers the orphan slot and replays from
   `ackedFsn + 1` with **no row lost**. Assert *at-least-once*, not
   exactly-once — replay and cap-split retry both legitimately duplicate (5.1),
   so the assertion is "every row present", not "every row once", and a
   duplicate must not fail the test. Plus the abandonment path: corrupt a slot,
   assert it is quarantined with `quarantinedPath` set, `DATA_LOSS` /
   `ABANDONED` is delivered, and the sender keeps running. Plus the liveness
   floor (8.1.2): a slot whose side files alone approach `sf_max_total_bytes`
   must still accept writes.

## 11. PR stack

Sixteen stacked PRs, each independently reviewable and green. PRs 1–8 are the
wire; 9–11 are error handling and failover; 12–15 are durability; 16 ships it.
PR 3 is the first point at which a user
could actually use the feature.

| # | PR | Gate |
|---|---|---|
| 1 | `ws/`: framing, masking, handshake, upgrade-failure classification (6.5.1), TLS mapping (6.5.2), net/tls socket | unit + mock server |
| 2 | `protocol/`: header, varint/zigzag, LONG/DOUBLE/TIMESTAMP/SYMBOL inline | golden vectors |
| 3 | Sender wiring: `ws://` config (4 sites, 3.5), `QwpBuffer`/`QwpTransport`, byte + interval auto-flush, cap-split (5.1) | **testcontainers e2e green** |
| 4 | Remaining scalar types, null bitmap, row lifecycle rules (6.5.3) | golden + e2e |
| 5 | VARCHAR/BINARY/arrays/decimals/geohash/uuid/long256/char/ipv4 + their per-type rules (6.5.3) | golden + e2e |
| 6 | Symbol dictionary: full-dict mode, then delta mode + `DICTIONARY_GAP` (5.2) | golden + e2e |
| 7 | Gorilla timestamps (6.3.2) + int32-overflow raw fallback | golden + e2e |
| 8 | defer-commit + commit frame (5.1.1) | e2e both on and off |
| 9 | ACK/NACK matrix, `defaultPolicyFor`, reconnect, replay, dict catch-up (7.5), poison detector | mock server |
| 10 | Multi-host `addr` grammar incl. IPv6 + duplicate rejection (1.2) | unit |
| 11 | Host health tracker: state ranking, rounds, rotation on transport error / `421`, `FAILED_OVER` / `ALL_ENDPOINTS_UNREACHABLE` | mock server, multi-endpoint |
| 12 | Memory-mode ring — makes publish semantics safe | mock + e2e |
| 13 | Disk segments (`SF01`), manifest, ack watermark, CRC32C, `fdatasync` | crash tests |
| 14 | `.symbol-dict` persistence + delta replay after recovery | crash tests |
| 15 | Slot locks (both kinds), orphan scan, drainers with private round cursors (1.2), `DATA_LOSS`/`ABANDONED` | crash tests |
| 16 | Docs, examples, README support matrix, 4.3.0 release | — |

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
- **Gorilla's prefix constants are bit-reversed** (6.3.2), and getting them wrong
  yields plausible-but-wrong timestamps rather than a decode failure. Vectors
  must cover every DoD bucket boundary (0, ±64, ±256, ±2048, int32 edges), a
  stream that trips the raw fallback, and columns of exactly 0, 1, 2 and 3
  values — the sub-3 cases take a different path (6.3.1) and are where an
  off-by-one hides.
- **Publish-semantics `flush()` before PR 12.** Between PR 3 and PR 12 there is
  no retention, so an unacked frame lost to a disconnect is lost. PRs 3–11 must
  document this in-tree and the feature must not be announced as
  production-ready until PR 12 lands.
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
- **Size suffixes parsed as plain integers.** `auto_flush_bytes=64m` read by
  `parseInt` is 64 bytes, not 64 MiB (9.1.1) — a flush per row, silently. Config
  tests must cover every suffix form, including the undocumented `t`.
- **Notification inbox dropping the wrong end.** Drop-newest is the intuitive
  bounded-queue policy and inverts the intent (4.2): under load the handler would
  keep stale entries and discard the current state. Tests must fill the inbox and
  assert the *newest* notification survives.
- **Decimal scale mis-ported as lock-and-reject.** Java *rescales* to the
  column's scale and only throws on precision loss or capacity overflow (6.5.3).
  A lock-and-reject port rejects data Java accepts, and the asymmetry is
  order-dependent — `1.25` after `1.5` differs from `1.5` after `1.25`.
- **A throwing setter desynchronising the columns.** Unequal per-column lengths
  (4.1.1) corrupt every subsequent frame from that table buffer while each frame
  still looks structurally valid. Tests must throw from a setter mid-row — first
  column, middle, last — and assert the next flush is byte-identical to one where
  the row was never started.
- **The commit frame re-shipping the whole dictionary.** Deriving its symbol
  bound from batch state rather than pinning both bounds to the baseline (5.1.1)
  produces a correct-looking frame in the common case and an unsplittable
  oversized one after a cancelled row or an empty flush. Java hit this; the
  golden vectors must include a commit frame emitted after `cancelRow` and after
  an empty flush.
- **A drainer consuming the foreground round.** Background drainers must use a
  private round cursor and health-only recording (1.2). Sharing the round lets a
  drainer silently steal endpoints from the foreground sender's sweep, which
  presents as unexplained `ALL_ENDPOINTS_UNREACHABLE` under load rather than as
  an obvious bug.
- **Inverted upgrade-failure retry.** Treating `401`/`403` as retriable spins
  forever against a server that will never accept the credentials; treating
  `421` as terminal kills a sender during an ordinary failover window (6.5.1).
  The two are easy to conflate because both are "the server refused the
  upgrade". Mock-server tests must cover `421`-with-role, `401`, `403`, `404`.
- **A connect string that works on Java failing on Node.** `tls_roots` with a
  JKS keystore is unsupportable in Node (6.5.2). Fail with an explicit message
  naming the conversion, and document it — a silent parse failure here looks
  like a client bug.
- **A `ws::` sender silently falling back to ILP v1.** `parseProtocolVersion`
  stamps `PROTOCOL_VERSION_V1` on any non-HTTP protocol and `createBuffer`
  switches on that value alone (3.5). Get the ordering wrong and QWP emits ILP
  text with no error at all. PR 3 needs an explicit test that a `ws::` sender
  produces a `QwpBuffer`.
- **Delivery is at-least-once, not exactly-once.** A cap-split flush that fails
  partway re-emits the whole batch on the next flush, duplicating the published
  prefix (5.1). This is contractual, not a defect — but it must reach the README,
  because users will otherwise assume the opposite from a durable client.
- **Mutable state re-read across an `await`.** The `serverMaxBatchSize` snapshot
  rule (5.1) is the known instance; the same hazard applies anywhere the port
  turns one of Java's synchronous sections into an async one. Prefer locals
  captured at entry over field reads.
- **Durability without recovery.** `sf_dir` set and `drain_orphans` left at its
  default of off means a crashed process's slot persists and is never replayed
  (9.1). Users will read `sf_dir` as "crash recovery" and get only half of it.
- **Permanent stalls that look like disk-full.** The `.symbol-dict` liveness
  floor (8.1.2) is the clearest example: enforce `sf_max_total_bytes` as a
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
