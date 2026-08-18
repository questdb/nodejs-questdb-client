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
| `@questdb/nodejs-client`             | Node.js            | Existing `Sender`, including QWP ingress selected with `ws::` or `wss::`                  |
| `@questdb/nodejs-client/qwp/browser` | Browser            | Browser-safe QWP ingress, egress, authentication bootstrap, sessions, and codecs          |
| `@questdb/nodejs-client/qwp/node`    | Node.js            | QWP ingress and egress with upgrade headers, TLS agents, and persistent store-and-forward |
| `@questdb/nodejs-client/qwp`         | Browser or Node.js | Shared protocol codecs and low-level session abstractions for advanced integrations       |

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

Advanced QWP options are accepted in the second argument:

```typescript
const sender = await Sender.fromConfig(
  "wss::addr=questdb.example:9000;token=REST_OR_OIDC_TOKEN",
  {
    qwp: {
      webSocket: {
        requestDurableAck: true,
        failoverUrls: ["wss://questdb-dr.example:9000/write/v4"],
        storeAndForward: {
          directory: "/var/lib/my-service/qwp-replay",
          maxBytes: 512 * 1024 * 1024,
        },
      },
      sender: {
        awaitDurableAck: true,
        autoFlushRows: 10_000,
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

Give each active sender its own store-and-forward directory. The Node.js journal
persists frames and their symbol dictionary before sending. Persistent senders can
start while every endpoint is offline and reconnect indefinitely by default. Unless
`awaitServerAck: true` or `awaitDurableAck: true` is selected, `flush()` resolves once
the complete logical flush is durable in the local journal; a background drainer then
sends it in order. Applications can therefore keep publishing during an outage until
the configured `maxBytes` applies backpressure. A failed journal publication leaves
the high-level rows staged so the caller can retry.

The persisted symbol dictionary is lifetime-monotonic and cannot be reclaimed by an
ACK. It counts toward the `maxBytes` target, but the journal preserves up to 32 MiB
(or the configured target when smaller) for live frame records if dictionary growth
uses all remaining headroom. Dictionary persistence itself is never rejected by the
target, so actual disk usage can exceed it by the non-reclaimable dictionary
overshoot. Frame growth beyond the liveness allowance remains backpressured until
ACK trimming frees record files.

The journal takes an exclusive lock when it is loaded and holds it until the sender
or session closes. A second live process using the same directory fails with
`QwpReplayStoreLockedError` before recovery or cleanup can mutate journal contents.
Locks left by a terminated process on the same host are recovered automatically;
locks owned by a live local process, another host, or an unidentifiable owner fail
closed.

An offline sender cannot inspect the server-advertised batch cap before its first
publication. Set `qwp.session.maxBatchSizeBytes` to a value no greater than the
smallest target node's cap when offline startup is required.

Set `awaitServerAck: true` when a particular flush must observe QuestDB's protocol ACK
before returning. `awaitDurableAck: true` implies server-ACK waiting and additionally
waits for replicated/durable progress. Browser senders continue to default to their
existing ACK-waiting behavior and do not offer persistent publication.

A crash after the server accepts a frame but before local acknowledgement cleanup can
replay that frame, so delivery is at least once. Applications that require exactly-once
effects should use their own stable event key or another idempotency strategy. Closing
a persistent sender stops its drainer but preserves published, unacknowledged frames for
the next sender using that directory.

### Direct high-level API

Use `QwpSender` directly when QWP-only column types or detailed session controls are
needed:

```typescript
import { connectQwpNodeSender } from "@questdb/nodejs-client/qwp/node";

const sender = await connectQwpNodeSender(
  {
    url: "wss://questdb.example:9000/write/v4",
    authorization: `Bearer ${token}`,
  },
  {
    autoFlushRows: 5_000,
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

Rows are staged until an auto-flush boundary or an explicit `flush()`. A `null` or
`undefined` column value omits that column from the row. `atNow()` asks QuestDB to
assign the designated timestamp; `at(value, unit)` sends an explicit `ns`, `us`, or
`ms` timestamp. `close()` does not flush pending rows.

The sender automatically maintains connection-scoped symbol IDs, emits dictionary
deltas, tracks acknowledgements, and splits multi-row batches at the smaller of the
client cap and the server-advertised cap. One row that cannot fit is rejected with
`QwpBatchTooLargeError` before it is sent.

Low-level Node sessions expose `publishFrame()`, `publishTables()`, and
`publishTablesDelta()` for local-publication semantics. Their `send*()` counterparts
continue to return the server ACK. Use the publication methods only with persistent
store-and-forward when local durability is the intended completion boundary.

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
transaction. `commit()` (an alias for `flush()`) closes the group and waits for its
cumulative acknowledgement:

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
sender with uncommitted transactional auto-flushes rolls the open server transaction
back. The sender logs a warning in this case.

In browsers, durable ACK capability is negotiated with a WebSocket subprotocol;
Node.js uses upgrade headers. Setting `awaitDurableAck` automatically requests the
capability unless `requestDurableAck` was set explicitly. The connection fails with
`QwpDurableAckUnavailableError` when the server does not confirm it. Browser durable
tracking is in memory only. Persistent store-and-forward is intentionally Node-only.

### Reconnect, failover, and roles

The preferred URL and `failoverUrls` form one endpoint set. Endpoints are ranked by
observed health (`healthy`, unknown, transient rejection, transport error, topology
rejection) and then by zone affinity; configuration order breaks ties. Health outranks
zone, so a known healthy cross-zone node is preferred to an untried local node. Every
connection sweep can still try every endpoint, allowing role and health changes to
recover. A non-orderly close demotes the selected endpoint before the next sweep.
`reconnect` controls bounded exponential backoff and emits lifecycle events. Node
ingress requires a persistent replay store when reconnect is enabled; browser ingress
can only replay from memory for the lifetime of the page.

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
  },
);

await sender.connect();
console.info(sender.metrics);
```

Callback failures are contained and cannot fail the session. Keep callbacks short;
Node.js and browsers run them on the JavaScript event loop. The ingress snapshot
separates client-session sequences from persistent replay watermarks and reports
published, sent, replayed, acknowledged, durable, reconnect, and error counters.

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
  },
  { queryTimeoutMs: 30_000 },
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

The high-level client defaults `initialCredit` to 256 KiB, bounding unread wire data
to roughly that window plus at most one server batch. The exact wire size of each
batch is replenished when iteration advances beyond it, so a slow consumer limits
server read-ahead in Node.js and browsers. Set a session-level `initialCredit` to tune
the default, override it per query, or explicitly set zero for legacy unbounded
streaming. Set `autoCredit: false` and call `query.grantCredit()` for manual control.

A session `queryTimeoutMs` supplies the default deadline; per-query `timeoutMs`
overrides it, and zero disables it. Expiry rejects iteration and `completion` with
`QwpEgressQueryTimeoutError`, sends QWP `CANCEL`, and drains the terminal response
before the connection accepts another query. Breaking out of `for await` early also
discards buffered batches, restores their flow-control credit, sends `CANCEL`, and
rejects `completion` with `QwpEgressQueryAbandonedError`. Call `query.cancel()` for
explicit cancellation.

Cancellation draining is bounded by `cancelDrainTimeoutMs` (5 seconds by default).
Late batches are decoded and credited while the terminal response is pending. If the
server does not terminate the query within the bound, the client fails with
`QwpEgressQueryCancelTimeoutError` and closes the unusable connection instead of
leaving the session permanently occupied.

Node.js can request Zstd with `compression: "zstd"` or `"auto"` and a level from 1
through 22. Raw remains the compatibility default. Check
`session.negotiatedCompression` after the handshake. The decoder handles raw and
Zstd batches in both runtimes, but browsers cannot advertise
`X-QWP-Accept-Encoding`; a same-origin proxy must add that header to opt a browser
into compressed responses.

Egress reconnect never silently resumes a partially consumed result. Configure
`onReplayReset` to opt into at-least-once query re-execution, discard any rows from
the previous attempt in that callback, and rebuild downstream state. Without that
hook, losing a connection with an operation in flight raises
`QwpEgressReplayRequiredError`.

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

`connectQwpNodeClient()` and `connectQwpBrowserClient()` prewarm each configured
pool minimum. Their `createQwp*Client()` counterparts are lazy. Pools grow to
their maximum under concurrent borrows and apply one FIFO acquisition deadline;
exhaustion raises `QwpPoolAcquireTimeoutError`. Query handles are single-flight,
but separate borrowed handles run concurrently. Returning a handle with an active
query sends `CANCEL` and waits for the session's bounded cancellation drain; a
connection that cannot drain is closed instead of being handed to another borrower.
Call `QwpClient.close()` only after returning application-owned leases; shutdown
rejects queued borrowers and closes every pooled connection, including one still
leased by a caller.

Pooled sender `close()` flushes completed rows, discards an unfinished row with a
warning, and resets staging before reuse. With Node store-and-forward enabled, the
configured directory is treated as a pool root and each stable sender slot owns a
`sender-N` child directory, avoiding journal lock conflicts. A connected pooled
client prewarms every persistent sender slot (overriding `senderPoolMin`) so journals
left by previously busy slots are recovered even when current traffic is lower.

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
| `QwpIngressNackError`              | QuestDB rejected an ingress frame                                                                           |
| `QwpBatchTooLargeError`            | One encoded row cannot fit the effective ingress cap                                                        |
| `QwpReconnectExhaustedError`       | The configured reconnect boundary was reached                                                               |
| `QwpReplayRejectedError`           | A replayed frame was rejected and retained for inspection                                                   |
| `QwpReplayStoreFullError`          | The Node.js replay journal reached its configured size                                                      |
| `QwpReplayStoreLockedError`        | Another process owns the configured Node.js replay directory                                                |
| `QwpEgressQueryError`              | QuestDB returned a terminal query error                                                                     |
| `QwpEgressQueryAbandonedError`     | Result iteration ended before the server completed the query                                                |
| `QwpEgressQueryTimeoutError`       | The client deadline expired and cancellation began                                                          |
| `QwpEgressQueryCancelTimeoutError` | A cancelled query did not produce a terminal server response before the drain deadline                      |
| `QwpEgressReplayRequiredError`     | Re-execution needs an explicit reset callback                                                               |

Always close senders and sessions in `finally`. Closing is idempotent and bounded by
`closeTimeoutMs`. `connectTimeoutMs`, `sendTimeoutMs`, acknowledgement timeouts, and
query deadlines cover separate lifecycle phases; configure each according to the
deployment rather than using one very large catch-all value.

## Migration guide

### Existing Node.js `Sender`

For the common fluent API, migration is primarily a transport change:

```diff
- const sender = await Sender.fromConfig("http::addr=localhost:9000");
+ const sender = await Sender.fromConfig("ws::addr=localhost:9000");
```

Review these behavioral differences before rollout:

- QWP `flush()` waits for a protocol ACK by default. With Node persistent
  store-and-forward it defaults to local durable publication; set `awaitServerAck` to
  restore ACK waiting, or `awaitDurableAck` to wait through durable upload.
- QWP symbol dictionaries are connection-scoped and automatic.
- Large batches are split to the negotiated WebSocket payload cap.
- QWP transactional auto-flush is per table and must be explicitly committed.
- Node reconnection requires store-and-forward and has at-least-once replay semantics.
- Existing HTTP, TCP, and TLS options do not automatically apply to QWP; put QWP-only
  connection and session controls under `extraOptions.qwp`.

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
| Explicit drain/commit        | `flush()` / `commit()`                                        |
| Durable delivery             | `requestDurableAck` plus `awaitDurableAck`                    |
| Store-and-forward            | Node `storeAndForward`; intentionally unavailable in browsers |
| Query parameters             | `session.query(sql, { binds })`                               |
| Result batches               | `for await (const batch of query)`                            |

Do not translate Java threading assumptions directly: callbacks, WebSocket delivery,
and iteration all share the JavaScript event loop.

## Public API policy

Only the four package entry points listed at the top are public. In particular,
paths containing `internal`, `qwp-node`, or `src` are implementation details even if
a bundler can resolve them. The compatibility contract checks the documented
high-level constructors, session classes, errors, constants, and option signatures
from the shared, browser, and Node entry points. Additional low-level codec exports
from `qwp` are intended for advanced integrations; prefer high-level APIs when no
custom encoder or transport is required.
