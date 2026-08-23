# QuestDB Wire Protocol (QWP)

This guide covers QWP ingress and egress from Node.js and browser applications.
It describes the supported public entry points, delivery semantics, authentication,
failure handling, and migration from the existing Node.js sender and the low-level
QWP API.

QWP support is currently a preview. The documented exports are the compatibility
baseline for the first QWP release, but may still change before that release. Once
released, changes to this documented surface follow the package's semantic-versioning
policy. Imports from internal source paths are never supported.

## Choose an entry point

| Entry point                          | Runtime            | Use it for                                                                                |
| ------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------- |
| `@questdb/nodejs-client`             | Node.js            | Existing `Sender`, including QWP ingress selected with `ws::`, `wss::`, or `udp::`        |
| `@questdb/nodejs-client/qwp/browser` | Browser            | Browser-safe QWP ingress, egress, authentication bootstrap, sessions, and codecs          |
| `@questdb/nodejs-client/qwp/node`    | Node.js            | QWP ingress and egress with upgrade headers, TLS agents, and persistent store-and-forward |
| `@questdb/nodejs-client/qwp`         | Browser or Node.js | Shared protocol codecs and low-level session abstractions for advanced integrations       |

The three QWP subpaths are declared both in `exports` and in `typesVersions`, so
they resolve under every TypeScript `moduleResolution` setting, including the
legacy `node10` that `module: "commonjs"` still implies by default. Keep the two
declarations in step: `exports` alone leaves a `node10` consumer with
`TS2307: Cannot find module '@questdb/nodejs-client/qwp/node'` at compile time
while the same import works perfectly at runtime.

Do not import the package root from browser code. It retains the existing Node.js
transports and dependencies for backward compatibility. The browser entry point has
no Node.js imports. Node-only features remain in `qwp/node`, so supporting browsers
does not require redesigning or breaking the existing client.

QWP uses `/write/v4` for ingress and `/read/v1` for egress. A server must expose
these WebSocket routes; optional features are enabled only when negotiation confirms
that the server supports them.

## Ingress

### Node.js through the existing `Sender`

Changing `http::` or `tcp::` to `ws::` selects QWP while preserving the familiar
fluent row API:

```typescript
import { Sender } from "@questdb/nodejs-client";

const sender = await Sender.fromConfig(
  "wss::addr=questdb.example:9000;token=REST_OR_OIDC_TOKEN;auto_flush=off",
);
await sender.connect();

try {
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .floatColumn("price", 2_615.54)
    .timestampColumn("received_at", Date.now(), "ms")
    .at(Date.now(), "ms");
  await sender.flush();
} finally {
  await sender.close();
}
```

`username` plus `password` selects HTTP Basic authentication for the WebSocket
upgrade. `token` selects Bearer authentication. Use `wss::` in production.

`Sender.fromConfig()` uses the same Java-compatible `ws::`/`wss::` vocabulary
as `connectQwpNodeClient()`. Comma-separated or repeated `addr` values configure
ordered failover endpoints, and ingress, egress, pool, and reserved policy keys
are validated from one schema. The standalone sender applies ingress-owned keys;
keys owned only by egress or the pooled facade are accepted as intentional no-ops.

## Configuration-string keys

Every `ws::`/`wss::` connect string is parsed by one schema, shared with the
other QuestDB clients, whichever entry point builds the client —
`Sender.fromConfig()`, `SenderOptions.fromConfig()`, `connectQwpNodeClient()`,
or `connectQwpNodeQuery()`. An unrecognised key is rejected with
`unknown configuration key: <key>`; a legacy ILP key adds a hint pointing at
where it applies instead.

Keys are grouped by the component that applies them. A client applies the keys
its own side owns and accepts the rest as intentional no-ops, so one connect
string can configure a sender, a query client, or the pooled facade. Every key
also has a programmatic equivalent on the corresponding options object; the
connect string is the portable spelling.

### Connection

| Key                  | Value              | Default   | Meaning                                                                                  |
| -------------------- | ------------------ | --------- | ---------------------------------------------------------------------------------------- |
| `addr`               | `host[:port]`      | port 9000 | Endpoint. Repeat the key, or comma-separate, for ordered failover.                       |
| `username`, `user`   | string             | —         | HTTP Basic user for the WebSocket upgrade.                                               |
| `password`, `pass`   | string             | —         | HTTP Basic password.                                                                     |
| `token`              | string             | —         | Bearer token; alternative to Basic.                                                      |
| `tls_verify`         | `on`, `unsafe_off` | on        | Certificate verification. `unsafe_off` disables it.                                      |
| `tls_roots`          | path               | —         | PEM or PKCS#12 trust store for a private CA.                                             |
| `tls_roots_password` | string             | —         | Password for `tls_roots`.                                                                |
| `auth_timeout_ms`    | integer ms         | `15000`   | Deadline for the upgrade and authentication exchange.                                    |
| `connect_timeout`    | integer ms         | `15000`   | Deadline for the TCP/TLS transport, and for the upgrade unless `auth_timeout_ms` is set. |

### Ingress

| Key                                             | Value            | Default   | Meaning                                                                  |
| ----------------------------------------------- | ---------------- | --------- | ------------------------------------------------------------------------ |
| `auto_flush`                                    | `on`, `off`      | on        | Master switch for all auto-flush triggers.                               |
| `auto_flush_rows`                               | integer          | `1000`    | Flush after this many staged rows.                                       |
| `auto_flush_bytes`                              | integer or `off` | off       | Flush once staged rows reach this estimated size.                        |
| `auto_flush_interval`                           | integer ms       | `100`     | Flush when this long has passed. Checked as rows are added.              |
| `close_flush_timeout_millis`                    | integer ms       | `5000`    | Bound on `close()`'s ACK drain. `0` or negative is a fast close.         |
| `transaction`                                   | `on`, `off`      | off       | Group each flush into a per-table transaction.                           |
| `request_durable_ack`                           | `on`, `off`      | off       | Require durable ACKs; fails if the server cannot confirm them.           |
| `durable_ack_keepalive_interval_millis`         | integer ms       | —         | Poll interval for durable-ACK progress.                                  |
| `max_name_len`                                  | integer          | `127`     | Maximum table and column name length, in UTF-16 code units.              |
| `sender_id`                                     | string           | `default` | Identifies this producer to the server and in the journal.               |
| `max_frame_rejections`                          | integer          | —         | Rejections of one frame before the poison-frame detector escalates.      |
| `poison_min_escalation_window_millis`           | integer ms       | —         | Minimum dwell before a poison frame may escalate.                        |
| `catch_up_cap_gap_min_escalation_window_millis` | integer ms       | `300000`  | Minimum dwell before an orphan symbol-dictionary cap gap is quarantined. |
| `connection_listener_inbox_capacity`            | integer          | —         | Bound on the connection-event inbox before events are dropped.           |
| `error_inbox_capacity`                          | integer          | —         | Bound on the `onSenderError` inbox before events are dropped.            |

### Reconnect and failover

| Key                                | Value                       | Default | Meaning                                                                                |
| ---------------------------------- | --------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `reconnect_initial_backoff_millis` | integer ms                  | —       | First reconnect delay; grows exponentially with jitter.                                |
| `reconnect_max_backoff_millis`     | integer ms                  | —       | Ceiling for one reconnect delay.                                                       |
| `reconnect_max_duration_millis`    | integer ms                  | —       | Budget for a reconnect episode. This is the QWP replacement for ILP's `retry_timeout`. |
| `failover`                         | `on`, `off`                 | —       | Enables endpoint failover for egress.                                                  |
| `failover_max_attempts`            | integer ≥ 1                 | —       | Failover attempts before giving up.                                                    |
| `failover_backoff_initial_ms`      | integer ms                  | —       | First failover delay.                                                                  |
| `failover_backoff_max_ms`          | integer ms                  | —       | Ceiling for one failover delay.                                                        |
| `failover_max_duration_ms`         | integer ms                  | —       | Budget for a failover episode.                                                         |
| `target`                           | `any`, `primary`, `replica` | —       | Server role this client will accept.                                                   |
| `zone`                             | string                      | —       | Preferred topology zone when ranking endpoints.                                        |

### Store-and-forward (Node only)

Setting `sf_dir` turns on the persistent journal; the rest tune it. A default
shown as a dash is applied downstream of the connect string, by the sender or
session that consumes it.

| Key                         | Value                          | Default       | Meaning                                                           |
| --------------------------- | ------------------------------ | ------------- | ----------------------------------------------------------------- |
| `sf_dir`                    | path                           | —             | Journal directory. Enables store-and-forward.                     |
| `sf_durability`             | `memory`, `periodic`, `append` | `memory`      | Local durability barrier after each vectored append.              |
| `sf_max_total_bytes`        | integer bytes                  | `10737418240` | Journal ceiling. Reaching it is the one error a producer sees.    |
| `sf_max_segment_bytes`      | integer bytes                  | `4194304`     | Size of one segment file.                                         |
| `sf_sync_interval_millis`   | integer ms                     | —             | Checkpoint interval when `sf_durability=periodic`.                |
| `sf_append_deadline_millis` | integer ms                     | `30000`       | How long an append waits for space before failing.                |
| `initial_connect_retry`     | `off`, `sync`, `async`         | `off`         | Startup policy when the server is unreachable. Requires `sf_dir`. |
| `drain_orphans`             | `on`, `off`                    | off           | Adopt and drain journals left by crashed producers.               |
| `max_background_drainers`   | integer                        | —             | Concurrent orphan drainers.                                       |

### Egress

| Key                 | Value                 | Default    | Meaning                                            |
| ------------------- | --------------------- | ---------- | -------------------------------------------------- |
| `max_batch_rows`    | integer, 1..1048576   | —          | Rows the server puts in one result batch.          |
| `initial_credit`    | integer ≥ 0           | —          | Starting flow-control credit for a query.          |
| `buffer_pool_size`  | integer ≥ 1           | —          | Reusable result buffers held per session.          |
| `compression`       | `raw`, `zstd`, `auto` | negotiated | Result compression to negotiate.                   |
| `compression_level` | integer, 1..22        | —          | zstd level requested from the server.              |
| `client_id`         | string                | —          | Identifies this client in server-side diagnostics. |

### Pool

Applied by the pooled facade; a standalone sender or query client ignores them.

| Key                       | Value       | Default | Meaning                                       |
| ------------------------- | ----------- | ------- | --------------------------------------------- |
| `sender_pool_min`         | integer     | —       | Senders kept warm.                            |
| `sender_pool_max`         | integer     | —       | Sender ceiling.                               |
| `query_pool_min`          | integer     | —       | Query sessions kept warm.                     |
| `query_pool_max`          | integer     | —       | Query-session ceiling.                        |
| `acquire_timeout_ms`      | integer ms  | —       | How long `acquire()` waits for a free entry.  |
| `query_close_timeout_ms`  | integer ms  | —       | Bound on closing a borrowed query session.    |
| `idle_timeout_ms`         | integer ms  | —       | Idle time before a pooled entry is reaped.    |
| `max_lifetime_ms`         | integer ms  | —       | Absolute lifetime of a pooled entry.          |
| `housekeeper_interval_ms` | integer ms  | —       | How often the pool reaps aged entries.        |
| `lazy_connect`            | `on`, `off` | off     | Start without blocking on a first connection. |

### Reserved

`on_write_error`, `on_server_error`, `on_internal_error`, `on_parse_error`,
`on_schema_error` and `on_security_error` are part of the shared vocabulary and
are accepted, but this client does not yet apply them: server-error policy comes
from `qwpDefaultSenderErrorPolicy` and the `onSenderError` stream. They are
listed so a connect string written for another QuestDB client is not rejected.

### Node.js fire-and-forget UDP

`udp::` selects Node-only QWP v1 over IPv4 UDP while retaining the fluent row API:

```typescript
import { Sender } from "@questdb/nodejs-client";

const sender = await Sender.fromConfig(
  "udp::addr=239.1.2.3:9007;max_datagram_size=1400;multicast_ttl=1",
);
await sender.connect();
await sender
  .table("trades")
  .symbol("symbol", "ETH-USD")
  .floatColumn("price", 2615.54)
  .atNow();
await sender.close();
```

The default port is 9007, maximum datagram size is 1400 bytes, and multicast TTL
is zero. Each datagram is self-contained, contains exactly one table, and uses an
inline schema plus table-local symbol dictionaries. Batches are split at row
boundaries; `QwpUdpDatagramTooLargeError` is raised before transmission when one
row cannot fit. `connectQwpNodeUdpSender()` and `connectQwpNodeUdp()` expose the
same transport from `qwp/node`.

UDP provides no authentication, TLS, server or durable ACK, transactions,
reconnection, compression, or store-and-forward. Local socket errors are delivered
to `QwpNodeUdpOptions.onError`; like the Java sender, they are observational and do
not retry rows that may already have been handed to the network. UDP is unavailable
from the browser entry point.

Advanced QWP options are accepted in the second argument:

```typescript
const sender = await Sender.fromConfig(
  "wss::addr=questdb.example:9000;token=REST_OR_OIDC_TOKEN;initial_connect_retry=async",
  {
    qwp: {
      webSocket: {
        requestDurableAck: true,
        connectTimeoutMs: 5_000,
        authTimeoutMs: 15_000,
        failoverUrls: ["wss://questdb-dr.example:9000/write/v4"],
        storeAndForward: {
          directory: "/var/lib/my-service/qwp-replay/producer-a",
          maxBytes: 512 * 1024 * 1024,
          durability: "periodic",
          checkpointIntervalMs: 5_000,
          backpressurePolicy: "wait",
          appendDeadlineMs: 30_000,
          catchUpCapGapMinEscalationWindowMs: 300_000,
          drainOrphans: true,
          maxBackgroundDrainers: 4,
        },
      },
      sender: {
        awaitDurableAck: true,
        autoFlushRows: 10_000,
        autoFlushBytes: 4 * 1024 * 1024,
      },
      session: {
        reconnect: {
          maxAttempts: 0,
          maxDurationMs: 0,
        },
      },
    },
  },
);
```

Node bounds connection establishment in two phases. `connectTimeoutMs` covers
DNS plus the TCP/TLS connection; after that succeeds, `authTimeoutMs` independently
covers the authenticated HTTP request and WebSocket upgrade. Both default to 15
seconds, so one endpoint attempt can take up to their sum. A timeout is reported as
`QwpUpgradeError` with `timeoutPhase` set to `"connect"` or `"authentication"`.
Browsers cannot observe the transport boundary, so their `connectTimeoutMs` continues
to cover the complete WebSocket opening lifecycle and they do not expose
`authTimeoutMs`.

Give each active sender its own store-and-forward directory. The Node.js journal
persists frames and their symbol dictionary before sending. Set
`initialConnectMode: "async"` when a persistent sender must start while every
endpoint is offline. Unless
`awaitServerAck: true` or `awaitDurableAck: true` is selected, `flush()` resolves once
the complete logical flush reaches the configured local journal boundary; a background
drainer then sends it in order. The default `"append"` boundary is locally durable,
while `"periodic"` and `"memory"` trade that immediate guarantee for throughput.
Applications can therefore keep publishing during an outage until the configured
`maxBytes` applies backpressure. A failed journal publication leaves the high-level
rows staged so the caller can retry.

`initialConnectMode` selects persistent startup behavior: `"off"` (the default)
makes one
fail-fast attempt, `"sync"` retries on the caller within the configured reconnect
budget, and `"async"` returns immediately while
the background replay loop connects. `Sender.fromConfig()` also accepts
`initial_connect_retry=off|sync|async` when `qwp.webSocket.storeAndForward` is
supplied. Initial authentication, upgrade, and capability failures remain terminal.
When no mode is explicit, configuring any reconnect duration/backoff key promotes
the initial connection to `"sync"`, so that budget also governs startup.
After a foreground persistent sender has connected successfully at least once, the
same failures are retried indefinitely so credential rotation and rolling capability
changes cannot strand its journal. The configured reconnect attempt/duration budget
therefore bounds `"sync"` startup and non-persistent reconnects, not steady-state
foreground store-and-forward recovery.

The connect-string key
`catch_up_cap_gap_min_escalation_window_millis` is the equivalent of
`catchUpCapGapMinEscalationWindowMs`.

`durability` controls the local persistence barrier:

- `"append"` (the default) issues a data-only durability barrier after every vectored
  positional frame write; manifest and directory metadata retain full barriers;
  hot-spare creation and activation are durable before publication resolves.
- `"periodic"` checkpoints segment files, symbol metadata, and directory changes in the
  background. The default interval is 5 seconds, and `close()` performs a final
  checkpoint. A power failure can lose the most recent checkpoint window.
- `"memory"` relies on operating-system writeback. It survives an orderly close and
  normally a process failure, but it makes no power-loss durability promise.

`backpressurePolicy: "error"` preserves the existing immediate
`QwpReplayStoreFullError` behavior. Set it to `"wait"` to pause publication until an
ACK advances the checksummed cursor, then a bounded background trimmer deletes fully
drained segments.
`appendDeadlineMs` bounds each such pause (30 seconds by
default) and expiry raises `QwpReplayStoreAppendTimeoutError`. Waiting appenders do
not hold the journal mutation queue, so ACK cleanup can continue. Direct users of
`QwpNodeFileReplayStore` can inspect `metrics` for pending records and segments,
checkpoint work, checkpoint failures, active waiters, stalls, and timeouts.

The persisted symbol dictionary is monotonic for one open journal generation and
cannot be reclaimed by an ACK alone. It counts toward the `maxBytes` target together
with each complete fixed-segment reservation, including the hot spare. The journal
preserves up to 32 MiB (or the configured target when smaller) for live frame segments
if dictionary growth uses all remaining headroom. Dictionary persistence itself is
never rejected by the target, so actual disk usage can exceed it by the current
dictionary overshoot and at most one liveness segment. Frame growth beyond that
allowance remains backpressured until background ACK trimming frees complete segments.
A partly acknowledged segment remains charged to the disk budget until its last live
record is acknowledged.
Once every frame is acknowledged,
`close()` removes the dictionary under the journal lock; the next clean start uses a
fresh symbol-ID space. A partially drained close retains the dictionary required by
the surviving frames.

The journal takes an exclusive lock when it is loaded and holds it until the sender
or session closes. A second live Node.js process using the same directory fails with
`QwpReplayStoreLockedError` before recovery or cleanup can mutate journal contents,
unless the first has stopped heartbeating long enough to be reclaimed — in which case
it is the first that stops writing, as described under the heartbeat below.
Ownership is held by a `.lock.owner` directory created next to the slot: `mkdir` is
the only exclusive-by-construction filesystem operation available on every supported
platform without a native addon, so exactly one process can create it. The holder PID
is recorded in `.lock.pid` for diagnostics, and the stable `.lock` file is created and
left in place so a slot keeps the on-disk shape a Java client expects. Short-lived
locks under the shared parent directory's `.slot-locks` child serialize orphan
adoption with close/rename/recreate quarantine transitions.

**A Node.js client and a Java client must not use one persistence directory at the
same time.** The Java client locks `.lock` with `flock` on Unix and `LockFileEx` on
Windows. The Node.js client does not participate in those kernel locks, so the two
runtimes will not see each other's lock and can both open the same slot, corrupting
the journal. The persistence format itself remains cross-client: a directory written
by one runtime can be handed to the other once the first has closed it. Only
concurrent access is unsupported, and only between runtimes — two Node.js processes
still exclude each other correctly.

A kernel lock disappears the instant its holder dies; a directory does not. The holder
therefore refreshes the owner directory's mtime every 5 seconds, and a contender
reclaims a slot whose mtime has not advanced for 15 seconds. A contender also reclaims
immediately when the owner record names a process that no longer exists on the same
host, which is the common case after a crash. A stale owner directory is renamed aside
before removal, so two contenders racing to reclaim one slot cannot both win it. Each
acquisition also writes a token into the owner record and checks it before removing
anything, so a release can never take away a directory that has since been handed to
somebody else.

If a holder is paused long enough for its heartbeat to lapse — `SIGSTOP`, a suspended
VM, a stalled filesystem, or any synchronous section that blocks the event loop for
more than 15 seconds — its lock can be reclaimed while it still believes it holds it.
Such a holder stops writing: once it can no longer vouch for its own lock, every
append, checkpoint and acknowledgement on that journal fails with
`QwpReplayStoreLockLostError`, and the sender falls back to whatever its durability
policy does when the journal is unavailable. This is deliberately conservative — the
holder fails as soon as a contender _could_ have taken the slot, not only once one
demonstrably has — because the alternative is writing at offsets the new owner now
owns. A frame's sequence is derived from its position in the segment, so a same-width
overwrite would otherwise reopen as a complete journal with the new owner's
acknowledged frames missing and nothing reported.

New journals use the cross-client SFA persistence layout. Fixed-size
`sf-<generation>.sfa` files have the Java/Rust 24-byte `SF01` header and
`[crc32c, payloadLength, payload]` frame envelope. `sf-manifest.bin` and
`.ack-watermark` use the shared dual-slot checksummed metadata layout, while
`.symbol-dict` uses the shared chunked `SYD1` representation. TypeScript tests load
Java-produced segment and dictionary fixtures and compare TypeScript output with the
same normalized bytes.

Each segment reserves `maxSegmentBytes` of target payload data (4 MiB by default)
plus one frame header so a maximum-sized frame fits. The active segment and one
pre-sized temporary hot spare keep open file handles; rotation activates the spare.
A process-wide, unreferenced worker provisions replacements, checkpoints dirty paths,
and performs ACK-driven unlink and directory barriers. ACK trimming advances the
durable manifest head before handing removal to that worker and runs in bounded
background batches. Frame append uses a vectored header-plus-payload write, avoiding
an additional payload-sized journal buffer.

A background provisioning, checkpoint or trim failure is parked on the store and
raised from the next journal call, then cleared by the next successful batch. Because
such a fault is transient — a briefly full, read-only or descriptor-starved volume —
reaching one while applying a server acknowledgement reconnects and replays rather
than ending the sender: a filesystem hiccup must not cost a running producer. Failures
that are verdicts on the journal itself carry `retryable: false` and stay terminal;
today those are `QwpReplayStoreCorruptionError` and `QwpReplayStoreLockLostError`. The
store persists its acknowledgement cursor before it mutates anything, so a fault at
that moment leaves exactly the state a crash at that moment would leave, and replay
resumes from the persisted watermark.

Recovery validates segment CRCs with a reusable 64 KiB scanner and indexes only frame
sequence, file offset, and payload length. The reconnect loop reads one payload from
its retained segment handle when it is ready to send it; it does not materialize the
complete persisted backlog. Fresh background store-and-forward frames likewise drop
their resident payload after journal publication and are read back on demand. Memory
therefore scales with the active encoding/send window rather than total disk backlog.

Recovery also handles the canonical creation crash window in which a valid SFA
segment becomes durable before its manifest.

On startup, a dictionary sidecar truncated at a complete-block boundary is rebuilt
from the ordered symbol deltas embedded in surviving committed frames and healed
before replay. A corrupt or stale dictionary sidecar is replaced when those committed
frames independently reconstruct a complete dense dictionary from ID zero. If the
frame journal is structurally corrupt, or the surviving deltas contain a dictionary
gap or conflict that cannot be reconstructed, the foreground slot is renamed to
`<slot>.unreplayable-N`, marked with `.failed`, and preserved for inspection. The
sender then starts once with a clean slot at the configured path.
`onRecoveryQuarantine` receives the original and quarantine paths plus the terminal
cause and a typed `senderError`. The shared `onSenderError` callback receives the same
`data-loss` / `abandoned` verdict and its `quarantinedPath`. This build-time recovery
notification is synchronous because no connected sender dispatcher exists yet;
callback failures cannot interrupt recovery. Quarantined paths are never adopted by
the orphan scanner. Operational filesystem errors are not quarantined and still fail
startup, so a temporary permissions or disk problem cannot be mistaken for data
corruption.

For a standalone sender, `drainOrphans: true` scans sibling directories beneath the
configured journal directory's parent, excludes the sender's own directory, and
adopts record-bearing slots left by failed producers. Adoption is lock-protected and
uses an independent QWP connection per slot, bounded by `maxBackgroundDrainers` (4 by
default). The scanner runs immediately and then every 30 seconds; set
`orphanScanIntervalMs: 0` for a startup-only scan. Terminal recovery failures create
`.failed` in the slot so a corrupt or permanently rejected head cannot cause a hot
retry loop. After inspection or repair, call `retryQwpNodeOrphanSlot(slotDirectory)`
to make it eligible again. `onOrphanDrainEvent` reports discovery, drain, lock
contention, quarantine, scanner failures, durable-ACK capability gaps, and transient
all-replica windows through a bounded asynchronous inbox. An abandoned slot also
reports a typed `data-loss` sender error. Callback exceptions cannot interrupt
recovery.

Blocking (`off` or `sync`) foreground startup fails immediately if every usable
endpoint lacks durable-ACK support. Asynchronous foreground startup and steady-state
store-and-forward reconnects retain their records and retry through rolling upgrades.
An orphan slot retries a consecutive durable-ACK capability-gap episode until either
16 connection sweeps or the configured reconnect `maxDurationMs` is reached, then it
is quarantined behind `.failed` (`maxDurationMs: 0` disables only the time half of
the budget). A transport outage or an all-replica window resets both halves of this
orphan budget; neither transient condition can itself quarantine persisted data. The
`durable-ack-unavailable`,
`durable-ack-persistent-failure`, and `primary-unavailable` orphan events expose the
distinction to operators.

A foreground sender retries a symbol-dictionary catch-up entry that is too large for
the current target forever because a larger-cap node may return. An orphan drainer
quarantines that slot only after 16 consecutive incompatible-cap observations and a
minimum five-minute dwell. Tune the dwell with
`catchUpCapGapMinEscalationWindowMs`; an unrelated transport or upgrade failure resets
the episode so outage time cannot accidentally satisfy it.

Keep sibling adoption off unless the parent is a dedicated store-and-forward group:
every record-bearing child directory that is not the foreground slot is considered
eligible. Browser senders never scan or persist local slots.

An offline sender cannot inspect the server-advertised batch cap before its first
publication. Set `qwp.session.maxBatchSizeBytes` to a value no greater than the
smallest target node's cap when offline startup is required.

Set `awaitServerAck: true` when a particular flush must observe QuestDB's protocol ACK
before returning. `awaitDurableAck: true` implies server-ACK waiting and additionally
waits for replicated/durable progress. Browser senders use the in-memory replay
publication boundary by default and do not offer persistent disk publication.

A crash after the server accepts a frame but before local acknowledgement cleanup can
replay that frame, so delivery is at least once. Applications that require exactly-once
effects should use their own stable event key or another idempotency strategy. Closing
a persistent sender stops its drainer but preserves published, unacknowledged frames for
the next sender using that directory.

### Direct high-level API

Use `QwpSender` directly when QWP-only column types or detailed session controls are
needed:

```typescript
import * as qwp from "@questdb/nodejs-client/qwp";
import { connectQwpNodeSender } from "@questdb/nodejs-client/qwp/node";

const sender = await connectQwpNodeSender(
  {
    url: "wss://questdb.example:9000/write/v4",
    authorization: `Bearer ${token}`,
  },
  {
    autoFlushRows: 5_000,
    autoFlushBytes: 4 * 1024 * 1024,
    autoFlushIntervalMs: 1_000,
    encode: { symbolDictionary: "delta", gorilla: true },
  },
);

try {
  await sender
    .table("telemetry")
    .symbol("device", "sensor-7")
    .longColumn("sequence", 42n)
    .uuidColumn("event_id", "9f1c96b2-54b8-4d85-bb24-e82c6f1ac120")
    .at(1_775_000_000_000, "ms");
  await sender.flush();
} finally {
  await sender.close();
}
```

A row in progress is the columns staged so far plus the table selected by
`table()`. When a setter or `at()` rejects a value, the sender discards both, so a
half-built row can never reach QuestDB and the next row starts from `table()` again:

```typescript
for (const reading of readings) {
  try {
    await sender
      .table("telemetry")
      .symbol("device", reading.device)
      .floatColumn("value", reading.value)
      .at(reading.timestamp, "ms");
  } catch (error) {
    // Only this row is gone. Rows staged earlier stay pending.
    log.warn(error);
  }
}
await sender.flush();
```

Setters called after a failure raise `table name must be set before adding columns`
rather than quietly joining a fresh row. `cancelRow()` discards a row in progress the
same way without an error, and `reset()` remains the heavier option that also drops
every row staged since the last flush.

### Compiled object-row writers

For repeated rows with one table schema, compile a table-bound writer instead of
sharing the fluent row-builder state:

```typescript
const trades = sender.writer("trades", {
  symbol: qwp.symbol(),
  side: qwp.symbol(),
  price: qwp.double(),
  quantity: qwp.long(),
  timestamp: qwp.designatedTimestamp("ns"),
});

await trades.row({
  symbol: "ETH-USD",
  side: "sell",
  price: 2615.54,
  quantity: 42n,
  timestamp: 1_723_000_000_000_000_000n,
});

await trades.rows([
  {
    symbol: "BTC-USD",
    side: "buy",
    price: 39_269.98,
    quantity: 7n,
    timestamp: 1_723_000_001_000_000_000n,
  },
]);
```

`rows()` accepts `Iterable` and `AsyncIterable` sources and applies the sender's
normal auto-flush, batch-cap, backpressure, transaction, symbol-dictionary, and ACK
settings. The schema is validated once.

The schema vocabulary covers every column type the fluent row API can write:

| Field                       | QuestDB type         | Accepted row values                                                                    |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `symbol()`                  | SYMBOL               | `string`                                                                               |
| `varchar()`                 | VARCHAR              | `string`                                                                               |
| `char()`                    | CHAR                 | `string` of one UTF-16 code unit                                                       |
| `bool()`                    | BOOLEAN              | `boolean`                                                                              |
| `byte()`                    | BYTE                 | `number`                                                                               |
| `short()`                   | SHORT                | `number`                                                                               |
| `int32()`                   | INT                  | `number`                                                                               |
| `int64()`, `long()`         | LONG                 | `bigint`                                                                               |
| `float32()`                 | FLOAT                | `number`                                                                               |
| `float64()`, `double()`     | DOUBLE               | `number`                                                                               |
| `timestamp(unit)`           | TIMESTAMP            | `number` or `bigint`; `"ns"` requires `bigint`                                         |
| `designatedTimestamp(unit)` | designated TIMESTAMP | as above, required in every row                                                        |
| `date()`                    | DATE                 | `number` or `bigint` milliseconds since the epoch                                      |
| `binary()`                  | BINARY               | `Uint8Array`, copied on append                                                         |
| `uuid()`                    | UUID                 | canonical UUID text, 16 canonical big-endian bytes, or `{ low, high }`                 |
| `long256()`                 | LONG256              | unsigned 256-bit `bigint`, `0x` hex text, four little-endian words, or `{ words }`     |
| `ipv4()`                    | IPV4                 | dotted-quad text or the packed address; `0.0.0.0` is the NULL sentinel                 |
| `geohash(precisionBits)`    | GEOHASH              | raw bits, base-32 text of `precisionBits / 5` characters, or `{ bits, precisionBits }` |
| `decimal64(scale)`          | DECIMAL64            | unscaled `bigint`, decimal text, `number`, or `{ unscaled, scale }`                    |
| `decimal128(scale)`         | DECIMAL128           | as above, scale up to 38                                                               |
| `decimal256(scale)`         | DECIMAL256           | as above, scale up to 76                                                               |
| `doubleArray()`             | DOUBLE[]             | nested `number` arrays of uniform shape, or `{ dimensions, values }`                   |
| `longArray()`               | LONG[]               | nested `bigint`/`number` arrays of uniform shape, or `{ dimensions, values }`          |

LONG, LONG256, and nanosecond timestamp inputs are `bigint` so they cannot silently
lose precision. The record forms are exactly what the egress result views hand back,
so a query result value can be written straight into a row without conversion.

Widths are spelled out deliberately. The fluent row API predates these names and its
`floatColumn()` and `intColumn()` are 64-bit despite reading as 32-bit, with
`float32Column()` and `int32Column()` as the narrow forms. Compiled writers avoid the
ambiguity: `float32()`/`float64()` and `int32()`/`int64()` mean exactly what they say.

Geohash precision and decimal scale belong to the column, not the value, so they are
fixed when the schema is compiled and validated against the sender's staged schema on
every append. Decimal text and `{ unscaled, scale }` values are rescaled to the
column's scale when that is exact, and rejected when it would round: at
`decimal64(2)`, `"1.50"` stages as `150n` and `"1.005"` raises `QwpWriterRowError`.
Base-32 geohash text carries five bits per character, so `geohash(20)` accepts
`"u33d"` and rejects `"u33"`.

Regular fields may be absent, `null`, or `undefined`, which writes a NULL. A schema
may contain at most one designated timestamp and, when present, that field is required
in every row. Unknown object keys and type mismatches raise `QwpWriterRowError`; bulk
errors include the zero-based row index. A failing row is never partly staged. Rows
successfully completed before a later iterable row fails remain available to flush.

Compiled writers are also available through the regular Node `Sender` when it uses a
QWP transport. Calling `writer()` for an HTTP or TCP ILP sender raises an error. A
writer obtained from a pooled sender lease cannot be used after the lease is closed.

Like the Java QWP sender, `flush()` and `commit()` resolve after the complete
logical flush reaches the local ingress/replay publication boundary. They do
not wait for a server ACK by default. Set `awaitServerAck: true` for an
implicit ACK barrier, or use the explicit sequence API below.

For producer-controlled acknowledgement barriers, publish first and wait for the
cumulative ACK watermark separately:

```typescript
await sender
  .table("telemetry")
  .symbol("device", "sensor-7")
  .longColumn("sequence", 43n)
  .atNow();

const sequence = await sender.flushAndGetSequence();
await sender.waitForAcknowledged(sequence, 5_000);
```

`flushAndGetSequence()` always resolves at the publication boundary, independently
of `awaitServerAck`, and returns the highest stable frame sequence published by that
call. It returns `-1n` when there was nothing to publish. `publishedSequence` and
`acknowledgedSequence` expose the current immutable watermarks. ACK waits are
cumulative, so one later acknowledgement resolves all covered waits and callers may
wait for different sequences concurrently. When durable ACK was negotiated, the
acknowledged watermark advances only after QuestDB reports durable progress;
otherwise it follows ordinary protocol OK responses. A deadline failure raises
`QwpIngressAckTimeoutError` without closing an otherwise healthy session.

Rows are staged until an auto-flush boundary or an explicit `flush()`. A `null` or
`undefined` column value omits that column from the row. `atNow()` asks QuestDB to
assign the designated timestamp; `at(value, unit)` sends an explicit `ns`, `us`, or
`ms` timestamp. `close()` publishes completed rows and waits for the committed-frame
ACK watermark for up to `closeFlushTimeoutMs` (5 seconds by default, matching the
Java client). Set it to `0` or a negative value for a fast close, which publishes
without the ACK drain; publication itself stays bounded, so `close()` always
returns. An unfinished row is still discarded with a warning.
The configuration-string equivalent is `close_flush_timeout_millis`.

`autoFlushBytes` is a soft threshold over estimated raw column-buffer storage and is
disabled by default (`0`). It combines with `autoFlushRows` and
`autoFlushIntervalMs`: reaching any enabled threshold flushes after the completed row,
so one row of overshoot is possible. Once connected, an enabled byte threshold is
clamped to 90% of the server-advertised batch cap. Schema and symbol-dictionary
overhead make this an estimate; exact encoded-size enforcement and automatic frame
splitting remain the ingress session's responsibility. `sender.metrics.pendingBytes`
and `sender.metrics.effectiveAutoFlushBytes` expose the live estimate and applied
threshold. Configuration strings use `auto_flush_bytes=N`; `off` is equivalent to
zero.

The sender automatically maintains connection-scoped symbol IDs, emits dictionary
deltas, tracks acknowledgements, and splits multi-row batches at the smaller of the
client cap and the server-advertised cap. One row that cannot fit is rejected with
`QwpBatchTooLargeError` before it is sent.

Low-level Node sessions expose `publishFrame()`, `publishTables()`, and
`publishTablesDelta()` for local-publication semantics. Their `send*()` counterparts
continue to return the server ACK. Use the publication methods only with persistent
store-and-forward when local durability is the intended completion boundary.
`sendFrameWithPublication()`, `sendTablesWithPublication()`, and
`sendTablesDeltaWithPublication()` expose both boundaries from one operation: await
`publication` before releasing retryable source rows, then await `acknowledgement`
when server acceptance is also required. If a split logical batch cannot be fully
journaled, its unattempted suffix is suppressed and the operation's publication
promise rejects.

### Browser ingress

Browser applications must use the browser entry point and a same-origin WebSocket
route (directly or through a reverse proxy):

```typescript
import { connectQwpBrowserSender } from "@questdb/nodejs-client/qwp/browser";

const url = new URL("/write/v4", location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

const sender = await connectQwpBrowserSender({ url }, { autoFlush: false });

try {
  await sender.table("page_events").symbol("kind", "view").atNow();
  await sender.flush();
} finally {
  await sender.close();
}
```

The browser WebSocket API cannot set `Authorization` or arbitrary `X-QWP-*`
upgrade headers. When authentication is enabled, create QuestDB's HttpOnly session
cookies over REST before opening the WebSocket:

```typescript
import {
  bootstrapQwpBrowserSession,
  connectQwpBrowserSender,
} from "@questdb/nodejs-client/qwp/browser";

await bootstrapQwpBrowserSession({
  url: new URL("/exec", location.href),
  authentication: { type: "bearer", token: oidcOrRestAccessToken },
  // QuestDB Enterprise only; omit this to use the logged-in principal.
  serviceAccount: "market_data_writer",
});

const sender = await connectQwpBrowserSender({ url });
```

Basic authentication is also accepted as `{ type: "basic", username, password }`.
The application obtains OIDC tokens from its identity provider; this package does
not run an interactive OIDC flow. The bootstrap request uses
`credentials: "include"`. REST and WebSocket endpoints therefore need the same
browser origin, or correctly configured credentialed CORS and cookie attributes.
JavaScript never reads `qdb_session` or the Enterprise `qdbServiceAccount` cookie.

Set `sessionBootstrap` on the WebSocket options to repeat bootstrap before every
initial, reconnect, and failover attempt:

```typescript
const sender = await connectQwpBrowserSender({
  url,
  sessionBootstrap: {
    authentication: { type: "bearer", token: oidcOrRestAccessToken },
    serviceAccount: "market_data_writer",
  },
});
```

### Transactions and durable acknowledgement

Transactional auto-flush keeps automatically emitted frames in an open server-side
transaction. `commit()` (an alias for `flush()`) publishes the group-closing frame.
The example also waits for its cumulative durable acknowledgement because it enables
`awaitDurableAck`:

```typescript
const sender = await connectQwpBrowserSender(
  { url, requestDurableAck: true },
  {
    transactional: true,
    autoFlushRows: 10_000,
    awaitDurableAck: true,
    durableAckTimeoutMs: 30_000,
  },
);

for (const event of events) {
  await sender
    .table("events")
    .symbol("source", event.source)
    .longColumn("value", event.value)
    .at(event.timestamp, "ms");
}
await sender.commit();
```

Transactions are atomic per table, not across all tables in one flush. Closing a
sender publishes locally staged transactional rows but does not implicitly commit;
QuestDB rolls the open server transaction back. The sender logs a warning in this case.

In browsers, durable ACK capability is negotiated with a WebSocket subprotocol;
Node.js uses upgrade headers. Setting `awaitDurableAck` automatically requests the
capability unless `requestDurableAck` was set explicitly. The connection fails with
`QwpDurableAckUnavailableError` when the server does not confirm it. Browser durable
tracking is in memory only. Persistent store-and-forward is intentionally Node-only.

Browser ingress adds `qwp_browser_handshake=v1` to the WebSocket URL. Compatible
servers send a small `SERVER_INFO` message immediately after the upgrade, and the
sender uses its exact ingress payload cap for automatic splitting. Older servers
ignore the query parameter; after a bounded 250 ms negotiation window the client
continues in unknown-cap mode. Set `ingressNegotiationTimeoutMs` to tune that window,
or keep using `maxBatchSizeBytes` as a local compatibility limit.

### Reconnect, failover, and roles

The preferred URL and `failoverUrls` form one endpoint set. Endpoints are ranked by
observed health (`healthy`, unknown, transient rejection, transport error, topology
rejection) and then by zone affinity; configuration order breaks ties. Health outranks
zone, so a known healthy cross-zone node is preferred to an untried local node. Every
connection sweep can still try every endpoint, allowing role and health changes to
recover. A non-orderly close demotes the selected endpoint before the next sweep.
Each standalone Node sender/drainer family, and each pooled orphan scanner, shares one
live health ledger among its walkers while keeping independent sweep cursors, so
concurrent drainers cannot consume one another's endpoint attempts. After a foreground
round is exhausted, stale classifications are reset while learned zone tiers persist;
the most recent successful same-zone endpoint remains sticky. Background orphan
drainers publish health observations but never reset foreground classifications.
Ingress reconnect is enabled by default for factory-created browser and Node sessions.
Unacknowledged frames are retained in memory and replayed at least once after a
transport failure. The built-in memory replay queue is capped at 128 MiB. When the
cap is full, publication waits for ACK-driven trimming for at most 30 seconds, then
rejects with `QwpMemoryReplayAppendTimeoutError`; a single frame that can never fit
is rejected immediately with `QwpMemoryReplayFrameTooLargeError`. Set
`memoryReplayMaxBytes` and `memoryReplayAppendDeadlineMs` on ingress session options
to tune these bounds. The accounting includes a fixed per-frame allowance so many
small frames cannot bypass the byte cap.

The default memory policy uses full-jitter backoff from 100 ms to 5 seconds and a
five-minute per-outage deadline; the initial connection remains fail-fast. Set
`reconnect: false` for one fixed connection. Supplying a `reconnect` object tunes the
bounds, emits lifecycle events through `onEvent`, and retains the earlier opt-in
behavior of retrying initial connection establishment.

Each retry delay is selected between zero and the current exponential ceiling,
preventing clients disconnected together from retrying in lockstep. Configured attempt
and duration bounds apply to browser/memory reconnect and Node `"sync"` startup. A
Node foreground store-and-forward replay loop remains unbounded after startup. Without
`storeAndForward`, both Node and browser ingress replay only for the lifetime of the
process or page; configuring a Node directory makes the same replay crash-safe.

Ingress also detects a replay head that is repeatedly NACKed or followed by a
non-orderly WebSocket close. `maxFrameRejections` controls the strike threshold and
`poisonMinEscalationWindowMs` (5 seconds by default) prevents a brief outage from
being mistaken for a deterministic poison frame. Normal and going-away closes,
`NOT_WRITABLE`, and retriable symbol-dictionary catch-up rejections are retried with
pacing but do not count as poison strikes.

Node.js sees the rejected upgrade status and `X-QuestDB-Role`, so a read-only replica
or catching-up primary can be classified and skipped. Browsers deliberately expose
an opaque upgrade error because their WebSocket API hides the HTTP response. Avoid
placing ingress replica endpoints in a browser endpoint list unless the proxy routes
writers to a primary.

### Observability

Use immutable metrics snapshots for polling and callbacks for event-driven telemetry:

```typescript
import {
  QWP_INGRESS_PROGRESS_KIND,
  createQwpNodeSender,
} from "@questdb/nodejs-client/qwp/node";

const sender = createQwpNodeSender(
  { url: "ws://localhost:9000/write/v4" },
  {},
  {
    reconnect: {
      onEvent: (event) => console.info("QWP connection", event),
    },
    onProgress: (event) => {
      if (event.kind === QWP_INGRESS_PROGRESS_KIND.ACKNOWLEDGED) {
        console.info("accepted through", event.sequence);
      }
    },
    onError: (event) => console.error("QWP ingress", event.error),
    onSenderError: (error) => {
      console.error(
        "QWP rejection",
        error.category,
        error.appliedPolicy,
        error.fromFsn,
        error.toFsn,
      );
    },
  },
);

await sender.connect();
console.info(sender.metrics);
```

Callbacks are placed on bounded asynchronous inboxes and never invoked inside ACK,
reconnect, or orphan-recovery protocol stacks. Connection events default to 64 retained
entries and errors to 256; `connectionListenerInboxCapacity` and
`errorInboxCapacity` (or their snake-case unified-string keys) tune those bounds.
Overflow drops the oldest pending entry and retains the newest state. Inspect
`droppedProgressNotifications`, `droppedConnectionNotifications`, and
`droppedErrorNotifications` in the immutable ingress metrics; non-zero values mean an
observer is not keeping up. Callback failures are contained. Callbacks still execute on
the JavaScript event loop, so CPU-bound synchronous work should be moved to an
application worker.

`onSenderError` is the Java-parity rejection stream. Its immutable payload includes
`category`, applied policy, raw server status/message, wire message sequence, inclusive
stable `[fromFsn, toFsn]` correlation range, optional single-table attribution, and
`quarantinedPath` for abandoned persistent data. The legacy `onError` callback remains
available for timeouts and general session failures; classified NACK events also expose
the same payload as `event.senderError`. When `onSenderError` is omitted, QWP logs
retriable rejections at `warn` and terminal rejections or abandoned data at `error`.
General asynchronous session failures are likewise logged when `onError` is omitted,
so a background store-and-forward failure is never silent by default. Reconnect and
orphan-drain fallbacks use the same bounded asynchronous error inbox; direct session
fallback logging adds no callback or close-time dependency. Both paths work in browsers
and Node.js.

## Egress

QWP egress streams typed result batches. One connection executes one active query at
a time.

```typescript
import { connectQwpNodeEgress } from "@questdb/nodejs-client/qwp/node";

const session = await connectQwpNodeEgress(
  {
    url: "wss://questdb.example:9000/read/v1",
    failoverUrls: [
      "wss://questdb-replica-2.example:9000/read/v1",
      "wss://questdb-primary.example:9000/read/v1",
    ],
    target: "replica",
    zone: "eu-west-1a",
    authorization: `Bearer ${token}`,
    compression: "zstd",
    compressionLevel: 3,
    maxBatchRows: 4096,
  },
  { queryTimeoutMs: 30_000, bufferPoolSize: 4 },
);

try {
  const query = await session.query(
    "select timestamp, symbol, price from trades where symbol = $1",
    {
      binds: (binds) => binds.setVarchar(0, "ETH-USD"),
      initialCredit: 1024 * 1024,
    },
  );

  for await (const batch of query) {
    console.info(batch.columns);
    for (const row of batch.rows()) console.info(row);
  }

  const completion = await query.completion;
  console.info(completion);
} finally {
  await session.close();
}
```

### Bounded reusable result views

`query()` keeps its convenient materialized batches. For hot paths, `queryViews()`
avoids allocating a JavaScript value array for every column and delivers one
reusable batch view through an awaited callback:

```typescript
const query = await session.queryViews(
  "select timestamp, symbol, price from trades",
  async (batch) => {
    const timestamp = batch.column(0);
    const symbol = batch.column(1);
    const price = batch.column(2);

    // Fixed-width values are read directly from the QWP little-endian bytes.
    for (let row = 0; row < batch.rowCount; row++) {
      if (!price.isNull(row)) {
        consume(
          timestamp.getLong(row),
          symbol.getSymbol(row),
          price.getDouble(row),
        );
      }
    }

    // Raw views are available for vectorized consumers.
    consumePackedDoubles(price.valuesBytes()!);
  },
  { initialCredit: 256 * 1024 },
);
await query.completion;
```

For conventional row-major processing, the same batch also owns one reusable
`QwpResultRowView`:

```typescript
batch.forEachRow((row) => {
  if (!row.isNull(2)) {
    consume(row.getLong(0), row.getSymbol(1), row.getDouble(2));
  }
});

// Direct indexed access uses the same flyweight.
const first = batch.row(0);
consume(first.rowIndex, first.getString(1));
```

`forEachRow()` is synchronous, visits rows in index order, propagates callback
exceptions, and re-points the same row object on every iteration. Do not retain
the row object or any zero-copy value returned from it; copy the value inside the
current invocation when it must survive. Calling `batch.row(index)` also returns
that shared object, re-pointed to the requested row.

The batch, its column objects, and every `Uint8Array`/`Int32Array` returned by a
column or row are valid only until the callback settles. The decoder reuses those
objects and its NULL-index, symbol-ID, array-offset, and Gorilla-timestamp scratch
storage for later batches. Copy an individual byte view with `.slice()`, or call
`batch.materialize()` inside the callback, when data must be retained.

Raw fixed-width, NULL, VARCHAR/BINARY, and array data views point into the current
decoded frame; Zstd results point into that batch's decompressed buffer. Accessors
such as `getString()` and `get()` decode or construct only the requested cell. The
callback is awaited before automatic credit is replenished, so the configured
credit window bounds server read-ahead while application work is in progress.

`target` accepts `any` (the default), `primary`, or `replica`. Primary routing also
accepts standalone servers and a primary completing catch-up, matching the Java
client. `zone` is an opaque, case-insensitive preference for `any` and `replica`;
cross-zone endpoints remain eligible. It is ignored for `primary`, which must be
followed across zones. The client validates the authoritative role and zone from the
first QWP `SERVER_INFO` frame before accepting an endpoint, so the same guarantees
work in browsers even though browser WebSocket APIs hide upgrade response headers.

Bind indexes are zero-based in the client: index `0` is SQL placeholder `$1`.
`QwpBindValues` supports booleans, integer and floating-point values, dates,
microsecond and nanosecond timestamps, strings, UUIDs, LONG256, geohashes,
decimals, and typed nulls. Set values in ascending index order. `bindPayload` and
`bindCount` remain advanced escape hatches for pre-encoded data.

Set per-query `resetDictionary: true` to ask the server to reset its
connection-scoped egress symbol dictionary before execution. The client sends the
flag only when `SERVER_INFO` advertises `QUERY_FLAGS`; older servers receive the
same flag-free request as the default path, so this option remains safe during a
rolling upgrade.

Matching Java, the high-level client defaults `initialCredit` to zero, allowing
unbounded server send-ahead. Set a positive session-level or per-query value to bound
wire buffering, particularly in browsers. With positive credit, the exact wire size
of each consumed batch is replenished automatically. Set `autoCredit: false` and call
`query.grantCredit()` for manual control.

Both materialized `query()` results and zero-copy `queryViews()` use a client-side
decoded-batch pool with four slots by default. Set the session-level
`bufferPoolSize` to tune this bound. Materialized decoding pauses when all slots are
queued until iteration requests another batch. For `queryViews()`, callbacks remain
serial and callback-scoped, while the receive loop continues decoding into the other
reusable slots; a slow callback stalls decoding only after the pool fills. This bound
is independent of QWP credit, so `initialCredit: 0` no longer permits an unbounded
queue of decoded batches. Protocol credit remains the stronger end-to-end bound,
particularly in browsers where the WebSocket implementation may buffer raw frames
before JavaScript reads them.

A session `queryTimeoutMs` supplies the default deadline; per-query `timeoutMs`
overrides it, and zero disables it. Expiry rejects iteration and `completion` with
`QwpEgressQueryTimeoutError`, sends QWP `CANCEL`, and drains the terminal response
before the connection accepts another query. Breaking out of `for await` early also
discards buffered batches, restores their flow-control credit, sends `CANCEL`, and
rejects `completion` with `QwpEgressQueryAbandonedError`. Call `query.cancel()` for
explicit cancellation.

`await query.awaitCompletion(timeoutMs)` bounds only the caller's wait and returns
`false` without cancelling when the timeout expires, matching Java
`Completion.await(timeout, unit)`. `query.isDone()` reports terminal state. Use the
query deadline options only when timeout should actively cancel the server query.
The initial and reconnect `SERVER_INFO` timeout defaults to five seconds, matching
Java, and remains configurable through `serverInfoTimeoutMs`.

Cancellation draining is bounded by `cancelDrainTimeoutMs` (5 seconds by default).
Late batches are decoded and credited while the terminal response is pending. If the
server does not terminate the query within the bound, the client fails with
`QwpEgressQueryCancelTimeoutError` and closes the unusable connection instead of
leaving the session permanently occupied.

Node.js and browsers can request Zstd with `compression: "zstd"` or `"auto"` and a
level from 1 through 22. Raw remains the compatibility default. Node uses
`X-QWP-Accept-Encoding`; browsers send the same preference in the URL's
`qwp_accept_encoding` parameter. Compatible servers report the effective codec and
operator-forced level in the existing egress `SERVER_INFO` message. Check
`session.negotiatedCompression` after the handshake. Older servers ignore the query
parameter and safely remain raw. The decoder handles raw and Zstd batches in both
runtimes.

Set transport-level `maxBatchRows` from 1 through 1,048,576 to ask QuestDB for
smaller `RESULT_BATCH` messages. The server clamps the request to its hard cap. Node
sends `X-QWP-Max-Batch-Rows`; browsers use the `qwp_max_batch_rows` URL parameter,
which requires a server that supports browser QWP negotiation. Older servers ignore
the browser parameter and keep their configured batch size.

A single `RESULT_BATCH` may declare at most `QWP_MAX_CELLS_PER_BATCH` cells --
32Mi, its rows multiplied by its columns. The row and column caps bound each
dimension on its own, and a compressed body detaches the grid they describe from
the bytes on the wire: an all-NULL column is one bit per cell before Zstd, so
without this bound a few kilobytes of RLE-compressed bitmap declares a result no
heap can hold. The bound is checked before any column is read, and 32Mi cells sits
far above any plausible result -- the widest supported table at 16k rows, or a full
1,048,576-row batch at 32 columns. Lower `maxBatchRows` for genuinely wide tables.

Opening a connection runs under two deadlines. `connect_timeout` covers the TCP/TLS
transport, and `auth_timeout_ms` takes over for the WebSocket upgrade and the
authentication exchange as soon as the transport connects; both default to 15
seconds. Setting only `connect_timeout` bounds both phases with that value, so an
endpoint that accepts TCP and never answers the upgrade -- a stalled proxy or load
balancer -- fails inside the budget you asked for rather than 15 seconds later. Set
`auth_timeout_ms` as well when the upgrade legitimately needs longer than the
transport.

Egress failover is enabled by default in Node.js and browsers. A transport failure or
invalid protocol response closes and deprioritizes that endpoint, reconnects, resets
connection-scoped decoding state, and re-executes the active query. The default policy
uses eight connection sweeps, full-jitter backoff starting at 50 ms and capped at one
second, and a 30-second outage deadline. `QUERY_ERROR` remains a query result and does
not trigger failover.

`session.ready` resolves once with the initial `SERVER_INFO`. Read
`session.serverInfo` for the immutable snapshot from the currently bound endpoint:
role, zone, cluster and node IDs, epoch, capabilities, server clock, and negotiated
compression. Reading the property is non-perturbing and never initiates a failover
walk. If an endpoint dies, it continues to report the previous snapshot until the
transport successfully rebinds, then refreshes to the new endpoint.

Re-execution is at least once: a statement may have completed before its response was
lost, and a consumer may already have observed a prefix of SELECT rows. Queued but
unconsumed batches are discarded automatically. Configure `onReplayReset` when the
application must clear an accumulated prefix before batches restart at sequence zero;
the callback is an optional notification, not an opt-in. Set `reconnect: false` to use
one fixed connection and surface failures without replay. Supplying a `reconnect`
object tunes the failover bounds and also retains the earlier opt-in behavior of
retrying initial connection establishment.

Browser egress uses the same session API:

```typescript
import { connectQwpBrowserEgress } from "@questdb/nodejs-client/qwp/browser";

const readUrl = new URL("/read/v1", location.href);
readUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";

const session = await connectQwpBrowserEgress({
  url: readUrl,
  failoverUrls: ["wss://replica-2.example/read/v1"],
  target: "replica",
  zone: "eu-west-1a",
  compression: "zstd",
  compressionLevel: 3,
  sessionBootstrap: {
    authentication: { type: "bearer", token: oidcOrRestAccessToken },
  },
});
```

## Combined pooled client

Use `QwpClient` when one long-lived application component needs both ingestion
and concurrent queries. The Node and browser entry points provide configured
factories; each borrowed handle exclusively owns one pooled WebSocket until its
`close()` returns it:

For Node, the recommended common-case API accepts one Java-style
`ws::`/`wss::` cluster string. Every `addr` entry is shared by ingress and
egress; the facade derives `/write/v4` and `/read/v1`, applies the same
authentication and TLS configuration to both sides, and validates ingress,
egress, and pool settings before opening a socket:

```typescript
import { connectQwpNodeClient } from "@questdb/nodejs-client/qwp/node";

const db = await connectQwpNodeClient(
  "wss::" +
    "addr=node-a.example:9000,node-b.example:9000;" +
    `token=${token};` +
    "target=replica;zone=eu-west-1a;" +
    "sender_pool_max=2;query_pool_max=8;",
);
```

Repeated `addr=` keys also accumulate endpoints. Programmatic overrides for
callbacks, custom agents, store-and-forward, sender/session settings, and pool
sizes may be passed as the second argument. The whole string is still validated
before overrides are applied, matching the Java builder's fail-fast behavior.

Set `lazy_connect=on` to tolerate an unavailable cluster during startup. In the
TypeScript client ingress uses memory replay by default, or persistent replay when
`sf_dir` is present, with `initial_connect_retry=async`; egress uses
`query_pool_min=0` and connects on the first query. Explicit
`initial_connect_retry=off|sync` or a positive `query_pool_min` conflicts with
`lazy_connect` and is rejected before the client is created:

```typescript
const db = await connectQwpNodeClient(
  "wss::addr=node-a.example,node-b.example;" + "lazy_connect=on;",
);
```

For unified strings with `sf_dir`, Java-compatible defaults apply: memory
durability, a 10 GiB total journal cap, 4 MiB frame/segment batches, a 30-second
capacity wait, a 60-second close drain, and fail-fast initial connection. Set
`sender_id` to name the disk slot base; pooled senders use `<sender_id>-<slot>`.
Without `sf_dir`, `sf_max_total_bytes` and `sf_append_deadline_millis` tune the
built-in memory replay queue instead.
The parser also supports `max_name_len`, password-protected `tls_roots`, and the
Java listener/error inbox capacity keys. Those capacities actively bound asynchronous
connection and typed-error delivery and are reflected in ingress drop counters.

The object form remains available for cases where constructing the two sides
separately is useful:

```typescript
import { connectQwpNodeClient } from "@questdb/nodejs-client/qwp/node";

const db = await connectQwpNodeClient({
  ingress: {
    url: "wss://questdb.example:9000/write/v4",
    authorization: `Bearer ${token}`,
  },
  egress: {
    url: "wss://questdb.example:9000/read/v1",
    authorization: `Bearer ${token}`,
    target: "replica",
    zone: "eu-west-1a",
  },
  pool: {
    senderPoolMin: 1,
    senderPoolMax: 2,
    queryPoolMin: 1,
    queryPoolMax: 8,
    acquireTimeoutMs: 5_000,
    idleTimeoutMs: 60_000,
    maxLifetimeMs: 30 * 60_000,
    housekeepingIntervalMs: 5_000,
  },
});

try {
  const sender = await db.borrowSender();
  try {
    await sender.table("trades").symbol("symbol", "ETH-USD").atNow();
  } finally {
    // Flushes completed rows and returns the sender; the socket stays pooled.
    await sender.close();
  }

  const [prices, volumes] = await Promise.all([
    db.borrowQuery(),
    db.borrowQuery(),
  ]);
  try {
    // These use independent egress WebSockets and may execute concurrently.
    const drain = async (lease, sql) => {
      const query = await lease.query(sql);
      for await (const batch of query) consume(batch);
      await query.completion;
    };
    await Promise.all([
      drain(prices, "select * from latest_prices"),
      drain(volumes, "select * from hourly_volumes"),
    ]);
  } finally {
    await Promise.all([prices.close(), volumes.close()]);
  }
} finally {
  await db.close();
}
```

Browser applications can likewise describe the cluster, REST/OIDC
authentication bootstrap, and failover order once. A cluster URL may be an
origin, a reverse-proxy base path, or an existing `/write/v4` or `/read/v1`
endpoint; the facade derives both protocol routes while preserving query
parameters. Omit `sessionBootstrap.url` to derive the matching `/exec` route
for every failover endpoint:

```typescript
import { connectQwpBrowserClient } from "@questdb/nodejs-client/qwp/browser";

const db = await connectQwpBrowserClient({
  cluster: {
    url: "wss://node-a.example/qdb",
    failoverUrls: ["wss://node-b.example/qdb"],
    sessionBootstrap: {
      authentication: { type: "bearer", token: oidcOrRestAccessToken },
      serviceAccount: "analytics",
    },
  },
  ingress: { requestDurableAck: true },
  egress: {
    target: "replica",
    zone: "eu-west-1a",
    compression: "zstd",
  },
  pool: { senderPoolMax: 2, queryPoolMax: 8 },
});
```

`url`, `failoverUrls`, and `sessionBootstrap` belong to `cluster` in this
unified form and are rejected if repeated under `ingress` or `egress`.
Side-specific timeouts, WebSocket factories, durable-ACK settings, routing, and
compression remain available as explicit overrides. The original split object
form with complete `ingress` and `egress` trees remains supported for advanced
cases that intentionally connect the two sides differently.

`connectQwpNodeClient()` and `connectQwpBrowserClient()` prewarm each configured
pool minimum. Their `createQwp*Client()` counterparts are lazy. Pools grow to
their maximum under concurrent borrows and apply one FIFO acquisition deadline;
exhaustion raises `QwpPoolAcquireTimeoutError`. Query handles are single-flight,
but separate borrowed handles run concurrently. Returning a handle with an active
query sends `CANCEL` and waits for the session's bounded cancellation drain; a
connection that cannot drain is closed instead of being handed to another borrower.
Each query lease exposes the same refreshed snapshot as `lease.serverInfo`; accessing
it after returning the lease raises `QwpClientClosedError` rather than exposing a
pooled connection now owned by another borrower.
The shared housekeeper closes excess connections after `idleTimeoutMs` and recycles
connections older than `maxLifetimeMs` once they are idle, while always retaining
each configured pool minimum. Set either timeout to zero to disable that policy;
`housekeepingIntervalMs` controls how quickly an expired idle connection is noticed.
Prefer returning application-owned leases before calling `QwpClient.close()`.
If shutdown races a borrower, it rejects queued borrowers, closes idle connections,
and cancels active queries before closing every borrowed query connection. A query
lease that is never returned therefore cannot retain a WebSocket after client
shutdown; subsequent operations on it fail as closed. Borrowed senders remain under
their producer's ownership: shutdown waits up to `acquireTimeoutMs` (capped at five
seconds) for them to return and never closes a sender underneath its borrower. A
sender returned during or after shutdown is closed instead of re-entering the pool,
while a sender that outlives the bounded wait owns its eventual teardown.

Pooled sender `close()` flushes completed rows, discards an unfinished row with a
warning, and resets staging before reuse. With Node store-and-forward enabled, the
configured directory is treated as a pool root and each stable sender slot owns a
`sender-N` child directory, avoiding journal lock conflicts. The configured
`senderPoolMin` remains authoritative. A client-level recovery scanner reserves and
drains inactive canonical slots independently of foreground pool connections, both
inside the current range and outside it after `senderPoolMax` is reduced. Foreground
creation and recovery share an atomic slot coordinator, so neither can acquire a
managed journal while the other owns it. This managed-slot recovery is automatic;
`drainOrphans: true` additionally adopts noncanonical sibling slots beneath the pool
root.

## Error handling and cleanup

The public error classes preserve enough context for policy decisions:

| Error                              | Meaning                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `QwpUpgradeError`                  | Classified authentication, role, version, capability, timeout, transport, or browser-opaque upgrade failure |
| `QwpRoleMismatchError`             | A connected endpoint's advertised role does not satisfy the requested egress target                         |
| `QwpPoolAcquireTimeoutError`       | Every pooled connection is leased beyond the configured acquisition deadline                                |
| `QwpPoolResourceError`             | Creating a new pooled sender or query connection failed                                                     |
| `QwpClientClosedError`             | The pooled client or an individual returned lease is already closed                                         |
| `QwpDurableAckUnavailableError`    | Durable acknowledgement was required but not negotiated                                                     |
| `QwpSendTimeoutError`              | A send did not drain before its deadline; delivery is unknown                                               |
| `QwpSenderCloseTimeoutError`       | Sender shutdown could not publish and ACK-drain all committed ingress frames within its deadline            |
| `QwpIngressNackError`              | QuestDB rejected an ingress frame                                                                           |
| `QwpIngressAckTimeoutError`        | The cumulative ingress ACK watermark did not reach the requested sequence before its deadline               |
| `QwpBatchTooLargeError`            | One encoded row cannot fit the effective ingress cap                                                        |
| `QwpReconnectExhaustedError`       | The configured reconnect boundary was reached                                                               |
| `QwpReplayRejectedError`           | A replayed frame was rejected and retained for inspection                                                   |
| `QwpReplayStoreFullError`          | The Node.js replay journal reached its configured size                                                      |
| `QwpReplayStoreAppendTimeoutError` | The Node.js replay journal did not regain capacity before the configured append deadline                    |
| `QwpReplayStoreCheckpointError`    | A periodic Node.js replay-journal checkpoint failed; operations fail closed until a retry succeeds          |
| `QwpReplayStoreLockedError`        | Another process owns the configured Node.js replay directory                                                |
| `QwpEgressQueryError`              | QuestDB returned a terminal query error                                                                     |
| `QwpEgressQueryAbandonedError`     | Result iteration ended before the server completed the query                                                |
| `QwpEgressQueryTimeoutError`       | The client deadline expired and cancellation began                                                          |
| `QwpEgressQueryCancelTimeoutError` | A cancelled query did not produce a terminal server response before the drain deadline                      |
| `QwpEgressReplayRequiredError`     | Deprecated compatibility type from the former explicit replay opt-in                                        |

Always close senders and sessions in `finally`. Sender publication plus ACK draining is
bounded by `closeFlushTimeoutMs`; the subsequent WebSocket closing handshake is bounded
by `closeTimeoutMs`. In Node, `connectTimeoutMs` and `authTimeoutMs` independently
bound transport connection and authenticated upgrade. `sendTimeoutMs`, acknowledgement
timeouts, and query deadlines cover later lifecycle phases; configure each according
to the deployment rather than using one very large catch-all value.

## Migration guide

### Existing Node.js `Sender`

For the common fluent API, migration is primarily a transport change:

```diff
- const sender = await Sender.fromConfig("http::addr=localhost:9000");
+ const sender = await Sender.fromConfig("ws::addr=localhost:9000");
```

Review these behavioral differences before rollout:

- QWP `flush()` uses the Java-compatible local-publication boundary by default in
  browsers and Node.js. Set `awaitServerAck` for a protocol ACK barrier, or
  `awaitDurableAck` to wait through durable upload. With Node persistent
  store-and-forward, local publication means durable journal append.
- QWP symbol dictionaries are connection-scoped and automatic.
- Table and column identifiers are rejected locally using the Java client's rules;
  column identity is case-insensitive and preserves the spelling first declared.
- Large batches are split to the negotiated WebSocket payload cap.
- QWP transactional auto-flush is per table and must be explicitly committed.
- Browser and Node QWP ingress reconnect by default with in-memory, at-least-once
  replay. That queue has a 128 MiB cap and a bounded 30-second capacity wait by
  default. Configure Node store-and-forward when replay must survive process failure.
- HTTP/TCP-only keys do not carry over to `ws::`; use the unified QWP connect-string
  vocabulary. Programmatic callbacks, custom agents, and other non-string hooks remain
  available under `extraOptions.qwp`.
- Auto-flush defaults differ from the ILP transports, matching the Java client's
  separate WebSocket defaults: `auto_flush_rows` is `1000` where `http::` uses
  `75000` and `tcp::` uses `600`, and `auto_flush_interval` is `100` ms where both
  use `1000` ms. A workload migrated on the one-line change above therefore sends
  smaller batches far more often; set both keys explicitly to keep its previous
  batching.

Roll out `ws::` per sender instance so the existing protocols can remain in service
during migration.

### Low-level QWP ingress

Code that manually creates `QwpTableBuffer` and calls
`QwpIngressSession.sendTables()` can normally move to `connectQwpNodeSender()` or
`connectQwpBrowserSender()`. Keep low-level sessions only when an application needs
to produce encoded table buffers itself. The high-level sender owns batching, symbol
deltas, ACK tracking, auto-flush, transactions, and durable waits.

### Java client concepts

The TypeScript high-level sender follows the Java client's core model—fluent rows,
automatic batching, connection-scoped symbol dictionaries, negotiated caps, durable
acknowledgement, and persistent replay—but uses runtime-specific connection factories:

| Java client concept          | TypeScript API                                                |
| ---------------------------- | ------------------------------------------------------------- |
| Sender/builder configuration | `Sender.fromConfig()` in Node.js, or `connectQwp*Sender()`    |
| Fluent table row             | `table()`, typed column methods, `at()` / `atNow()`           |
| Local publish/commit         | `flush()` / `commit()`                                        |
| Explicit ACK barrier         | `flushAndGetSequence()` plus `waitForAcknowledged()`          |
| Durable delivery             | `requestDurableAck` plus `awaitDurableAck`                    |
| Store-and-forward            | Node `storeAndForward`; intentionally unavailable in browsers |
| Fire-and-forget UDP ingress  | Node `udp::` or `connectQwpNodeUdpSender()`                   |
| Query parameters             | `session.query(sql, { binds })`                               |
| Materialized result batches  | `for await (const batch of query)`                            |
| Reusable result views        | `queryViews()` with column views or `forEachRow()` row views  |
| Egress row/buffer bounds     | `maxBatchRows` and session `bufferPoolSize`                   |

Unlike Java's dedicated dispatcher threads, TypeScript callback inboxes schedule work on
later JavaScript event-loop turns. This keeps user callbacks out of protocol call stacks,
but CPU-bound callback code still blocks the runtime and belongs in a Worker or
`worker_threads` task.

## Development benchmarks

The repository includes diagnostic QWP benchmarks for ingress encoding, fluent sender
construction, symbol dictionaries, egress materialization and reusable views, Zstd,
store-and-forward persistence/recovery, and live completion-boundary latency. See
[`benchmarks/README.md`](benchmarks/README.md) for commands and result interpretation.
They are intentionally not CI performance gates.

## Public API policy

Only the four package entry points listed at the top are public. In particular,
paths containing `internal`, `qwp-node`, or `src` are implementation details even if
a bundler can resolve them. The compatibility contract checks the documented
high-level constructors, session classes, errors, constants, and option signatures
from the shared, browser, and Node entry points. Additional low-level codec exports
from `qwp` are intended for advanced integrations; prefer high-level APIs when no
custom encoder or transport is required.
