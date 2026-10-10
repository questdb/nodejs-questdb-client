# QuestDB JavaScript Client for browsers

The official browser-only QuestDB client. It provides QWP ingestion, streaming
queries, failover, typed row writers, and browser session authentication without
Node.js modules or polyfills.

The complete browser API is exported from `@questdb/browser-client`. There are
no additional public import paths.

## Features

- QWP ingestion through the browser's native WebSocket API
- Streaming queries with typed bind variables and result batches
- Automatic batching, reconnect, failover, and acknowledgement tracking
- Transactional ingestion and durable acknowledgement negotiation
- REST, OIDC, and Basic authentication, either through HttpOnly session
  cookies or, for third-party web applications, sent with each WebSocket
  upgrade
- ESM, CommonJS, and bundled TypeScript declarations
- No Node.js built-ins, Node.js typings, `ws`, or `undici`

## Requirements

- A modern browser with `WebSocket`, `fetch`, `URL`, `TextEncoder`, and
  `TextDecoder`
- QuestDB QWP routes exposed at `/write/v4` and `/read/v1`
- The `/exec` REST route when authentication bootstrap is needed

This package does not contain the Node.js ILP transports; use
`@questdb/nodejs-client` for server-side Node.js programs.

## Installation

```shell
npm install @questdb/browser-client
```

```shell
yarn add @questdb/browser-client
```

```shell
pnpm add @questdb/browser-client
```

The package works with browser bundlers such as Vite, Rollup, webpack, and
esbuild. Import only from the package root:

```typescript
import { connectQwpBrowserSender } from "@questdb/browser-client";
```

## Quick start: ingest from a browser

Serve QuestDB's QWP route from the application's origin, either directly or
through a reverse proxy. The browser will then apply the page's normal cookie,
origin, and TLS rules to the WebSocket connection. An application served from
another origin connects directly instead; see
[Third-party web applications](#third-party-web-applications).

```typescript
import { connectQwpBrowserSender } from "@questdb/browser-client";

const writeUrl = new URL("/write/v4", window.location.href);
writeUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

const sender = await connectQwpBrowserSender(
  { url: writeUrl },
  { autoFlush: false },
);

try {
  await sender
    .table("page_events")
    .symbol("kind", "view")
    .stringColumn("path", window.location.pathname)
    .timestampColumn("recorded_at", Date.now(), "ms")
    .atNow();

  await sender.flush();
} finally {
  await sender.close();
}
```

Use `wss:` whenever the page is served over HTTPS. Browsers block insecure
WebSockets from secure pages.

## Batch and commit rows

Transactional mode keeps automatically emitted frames in one open server-side
transaction. `commit()` publishes the final frame. Transactions are atomic per
table, not across every table in one flush.

```typescript
import { connectQwpBrowserSender } from "@questdb/browser-client";

const sender = await connectQwpBrowserSender(
  { url: writeUrl, requestDurableAck: true },
  {
    transactional: true,
    autoFlushRows: 10_000,
    awaitDurableAck: true,
    durableAckTimeoutMs: 30_000,
  },
);

try {
  for (const event of [
    { source: "checkout", value: 1n, timestamp: Date.now() },
    { source: "search", value: 3n, timestamp: Date.now() },
  ]) {
    await sender
      .table("events")
      .symbol("source", event.source)
      .longColumn("value", event.value)
      .at(event.timestamp, "ms");
  }

  await sender.commit();
} finally {
  await sender.close();
}
```

Browser replay is held in memory and survives reconnects only while the page is
alive. Persistent store-and-forward is intentionally available only from the
Node.js package.

## Type-safe object rows

Compile a table schema once when application data already has an object shape.
TypeScript checks every row against the schema.

```typescript
import {
  connectQwpBrowserSender,
  designatedTimestamp,
  double,
  symbol,
} from "@questdb/browser-client";

const sender = await connectQwpBrowserSender({ url: writeUrl });

try {
  const measurements = sender.writer("measurements", {
    device: symbol(),
    temperature: double(),
    timestamp: designatedTimestamp("ms"),
  });

  await measurements.rows([
    { device: "sensor-1", temperature: 21.4, timestamp: Date.now() },
    { device: "sensor-2", temperature: 22.1, timestamp: Date.now() },
  ]);

  await sender.flush();
} finally {
  await sender.close();
}
```

The schema vocabulary also covers QuestDB integers, decimals, UUIDs, IPv4
addresses, geohashes, binary values, and arrays.

## Authentication

Browser JavaScript cannot add an `Authorization` header to a WebSocket upgrade,
so the client authenticates in one of two ways:

- **Session cookies**, for an application served from QuestDB's origin or
  through a same-origin reverse proxy. The client authenticates over REST, and
  QuestDB sets an HttpOnly session cookie that the browser sends with the
  upgrade.
- **`auth`**, for a third-party web application served from its own origin.
  The client sends the credential with every upgrade, in its subprotocol offer.

A connection accepts one or the other, not both.

### Session cookies

Authenticate over REST first so QuestDB can set an HttpOnly session cookie. The
browser then sends that cookie during the QWP WebSocket upgrade.

```typescript
import {
  bootstrapQwpBrowserSession,
  connectQwpBrowserSender,
} from "@questdb/browser-client";

await bootstrapQwpBrowserSession({
  url: new URL("/exec", window.location.href),
  authentication: {
    type: "bearer",
    token: oidcOrRestAccessToken,
  },
  // QuestDB Enterprise only; omit to use the authenticated principal.
  serviceAccount: "market_data_writer",
});

const sender = await connectQwpBrowserSender({ url: writeUrl });
```

Basic authentication is also supported:

```typescript
const sender = await connectQwpBrowserSender({
  url: writeUrl,
  sessionBootstrap: {
    authentication: {
      type: "basic",
      username: "admin",
      password: "quest",
    },
  },
});
```

Putting `sessionBootstrap` on the connection options repeats authentication
before initial connection, reconnect, and failover attempts. The package does
not run an interactive OIDC flow; the application obtains access tokens from
its identity provider.

The bootstrap request uses credentials. Prefer serving `/exec`, `/write/v4`,
and `/read/v1` from the application's origin. JavaScript never reads the
HttpOnly cookie. An application on another origin should use `auth` instead:
QuestDB ignores cookies on a cross-origin QWP upgrade.

### Third-party web applications

An application served from its own origin, such as `https://app.example.com`,
connects to QuestDB directly once the server lists that exact origin:

```
# QuestDB server.conf
qwp.browser.allowed.origins=https://app.example.com
```

Pass the credential as `auth`. REST and OIDC tokens use the `bearer` form, and
`{ type: "basic", username, password }` is accepted too:

```typescript
import { connectQwpBrowserSender } from "@questdb/browser-client";

const sender = await connectQwpBrowserSender({
  url: "wss://questdb.example.com:9000/write/v4",
  auth: { type: "bearer", token: restToken },
});
```

An OIDC access token expires, so pass a function instead. The client calls it
before every initial connect, reconnect, and failover attempt, so a long-lived
sender or query session keeps working with each refreshed token:

```typescript
const sender = await connectQwpBrowserSender({
  url: "wss://questdb.example.com:9000/write/v4",
  auth: async ({ signal }) => ({
    type: "bearer",
    token: await identityProvider.getAccessToken({ signal }),
  }),
});
```

The `signal` aborts when the connection attempt is abandoned, and time spent in
the function counts against `connectTimeoutMs`. If the function throws, the
attempt fails with a `QwpUpgradeError` of kind `authentication` whose `cause` is
the thrown error; reconnects retry it with backoff unless that error carries
`retryable: false`.

- Use `wss:`. The credential travels in the upgrade request's
  `Sec-WebSocket-Protocol` header, base64url-encoded but not encrypted.
- QuestDB accepts the credential only from a listed origin; a page served from
  QuestDB's own origin must be listed too, or keep using session cookies. It
  creates no session and ignores cookies on these upgrades, so the connection
  runs as the credential's own principal; `serviceAccount` assumption is not
  available this way.
- QuestDB never selects the credential as the connection's subprotocol. The
  client treats a server that does as defective and closes the connection
  without retrying or trying another endpoint.
- With authentication disabled, a listed origin needs no credential.
- The server must support `qwp.browser.allowed.origins`. The allowlist covers
  only the QWP routes; it does not enable CORS for REST.

## Stream query results

QWP egress streams typed result batches. A session runs one active query at a
time and automatically reconnects and walks configured failover URLs.

```typescript
import { connectQwpBrowserEgress } from "@questdb/browser-client";

const readUrl = new URL("/read/v1", window.location.href);
readUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

const session = await connectQwpBrowserEgress(
  {
    url: readUrl,
    compression: "zstd",
    sessionBootstrap: {
      authentication: { type: "bearer", token: oidcOrRestAccessToken },
    },
  },
  { queryTimeoutMs: 30_000 },
);

try {
  const query = await session.query(
    "select timestamp, device, temperature " +
      "from measurements where device = $1",
    {
      // Bind index 0 corresponds to SQL placeholder $1.
      binds: (binds) => binds.setVarchar(0, "sensor-1"),
      // A positive credit window bounds server read-ahead.
      initialCredit: 1024 * 1024,
    },
  );

  for await (const batch of query) {
    for (const row of batch.rows()) {
      console.log(row);
    }
  }

  await query.completion;
} finally {
  await session.close();
}
```

Use `queryViews()` for reusable zero-copy result views in allocation-sensitive
applications. Copy any view that must outlive its batch callback.

## Combined ingestion and query client

`connectQwpBrowserClient()` creates bounded sender and query pools for an
application component that needs concurrent ingestion and queries:

```typescript
import { connectQwpBrowserClient } from "@questdb/browser-client";

const clusterUrl = new URL("/", window.location.href);
clusterUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

const db = await connectQwpBrowserClient({
  cluster: {
    url: clusterUrl,
    sessionBootstrap: {
      authentication: { type: "bearer", token: oidcOrRestAccessToken },
    },
  },
  ingress: { requestDurableAck: true },
  egress: { target: "replica", compression: "zstd" },
  pool: { senderPoolMax: 2, queryPoolMax: 4 },
});

try {
  const sender = await db.borrowSender();
  try {
    await sender.table("events").symbol("kind", "view").atNow();
  } finally {
    // Flushes completed rows and returns the sender to the pool.
    await sender.close();
  }

  const query = await db.borrowQuery();
  try {
    const result = await query.query("select count() from events");
    for await (const batch of result) console.log([...batch.rows()]);
    await result.completion;
  } finally {
    await query.close();
  }
} finally {
  await db.close();
}
```

## Error handling and shutdown

- Always close senders, query sessions, borrowed pool handles, and pooled
  clients in `finally` blocks.
- Await asynchronous row completion methods such as `at()`, `atNow()`, and
  writer `row()`/`rows()` calls.
- An unfinished row is never completed implicitly during `flush()` or `close()`.
- Do not share one sender between unrelated concurrent producers.
- Re-executed queries are at least once after failover; clear already consumed
  results in an `onReplayReset` callback when duplicate prefixes matter.

## More documentation

- [Complete repository README](https://github.com/questdb/nodejs-questdb-client#readme)
- [QWP guide](https://github.com/questdb/nodejs-questdb-client/blob/main/QWP.md)
- [Browser API reference](https://questdb.github.io/nodejs-questdb-client/modules/_questdb_browser-client.html)
- [QuestDB documentation](https://questdb.com/docs/)
- [QuestDB Community Forum](https://community.questdb.com/)
