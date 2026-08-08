# Handoff — Plan 2 (full codec) done, for the agent executing Plan 3

**Read first:** `docs/superpowers/plans/README.md`, then `2026-08-07-qwp-plan-3-errors-and-failover.md`.
The design spec wins over any plan text: `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`.

## State

- Branch `feat/qwp-design` at `c0449d0`. Plan 2 (PRs 4–8, all 10 tasks) fully
  implemented and committed on top of Plan 1 (11 commits since the plan-1→2
  handoff). Full suite green: **235 passed, 2 skipped** (`npx vitest run`
  minus the Docker-only suite); `tsc --noEmit` and `eslint src` clean.
  Only skip is the pre-existing `test/sender.integration.test.ts` (needs Docker).
- Plan 2 added `src/qwp/protocol/{columnWriter,bits,gorilla,symbolDict}.ts` and
  modified `{constants,tableBuffer,frameEncoder}.ts`, `src/qwp/{buffer,transport}.ts`,
  `src/sender.ts`. Tests in `test/qwp/` (incl. a multi-row all-types e2e).
- Plan 3's modules do **not** exist yet: no `response.ts`, `errors.ts`,
  `ackTracker.ts`, `poison.ts`, `endpoints.ts`, `hostTracker.ts`,
  `dispatcher.ts`, `test/qwp/mockServer.ts`.

## Carry-forward corrections (verified against the live server / Java source) — still true

1. **Designated timestamp = EMPTY-name column.** `at()` emits a column with
   `nameLen=0` and `TYPE_TIMESTAMP`; the server names it `timestamp`. Never send
   a column literally named `timestamp` (duplicate-column rejection). Verified
   end-to-end. — from plan-1 handoff.
2. **Clients mask, servers unmask.** Untouched by Plan 2; the mock QWP server
   you build in Task 4 must unmask client frames (reuse `encodeClientFrame`,
   do not mask server→client responses).
3. **`tls_verify` is a `boolean`** (parsed `unsafe_off`→false); guard TLS as
   `!== false` (already done in `QwpTransport.connect`).
4. **NEW — Gorilla is byte-correct against the real server, not just self-tests.**
   `gorilla=true` is now the `QwpBuffer` default (set in Task 9). The bit-reversed
   prefixes are right: a 20-row constant-1s-interval set decoded to
   `22:13:20, 22:13:21, …` exactly. Plan 3's response decoder reads ACK frames
   only — it must **not** assume anything about timestamp payloads (Plan 2 is done).

## API surfaces Plan 3 consumes — how they changed in Plan 2

These are the load-bearing contracts; don't re-derive them.

- **`encodeFrame(tables, opts)`** — arity changed in Task 7. `opts: FrameOpts =
  { gorilla: boolean; dict?: SymbolDict; confirmedMaxId?: number; deferCommit?: boolean }`.
  One-arg calls do **not** compile. `encodeCommitFrame(dict, baseline)` is exported
  (Task 9).
- **`columnPayloadSize` / `writeColumn`** moved out of `frameEncoder.ts` into
  `columnWriter.ts`, both taking `(buf, offset, col, rowCount, opts: EncodeOpts
  { gorilla: boolean; delta?: boolean })`.
- **`SymbolDict`** (connection-scoped, dense ids from 0): `getOrAdd(s)`, `size()`,
  `entriesFrom(startId)`, `addRecovered(s)` (positional, never de-dupes), `reset()`,
  `checkCap(n)`; cap = `MAX_SYMBOL_DICTIONARY_SIZE = 1_000_000`.
- **`QwpBuffer`** now owns `dict?: SymbolDict`, `confirmedMaxId`, `gorilla=true`,
  `deferCommit`; exposes `attachDict(d)`, `setConfirmedMaxId(id)`,
  `setDeferCommit(on)`, and `sealFrames(maxBatchSize): Buffer[]` which does
  cap-splitting with per-frame pre-flight. `toBufferNew()` remains as a 1-frame
  wrapper (throws if it ever sees >1). A QWP sender must use `sealFrames`, not
  `toBufferNew`, or oversized batches throw.
- **`QwpWebSocket`** currently has `maxBatchSize`, `sendBinary`, `close`, and a
  PING/CLOSE handler — **but it has NO callback for inbound binary frames and NO
  disconnect callback**. The `onData` `default` case silently ignores response
  frames. Plan 3 Task 4 must thread `onBinary`/`onClose` through
  `QwpWebSocket.connect`; this is the single biggest structural gap in the
  Plan 1/2 code that Plan 3 fills.

## Things the next agent will likely trip on

- **`at()` clears `current`.** After `at()`, you must call `.table()` again before
  adding the next row's columns. Multi-row test/builders that don't re-select the
  table throw "table name must be set before adding columns". (Mine did.)
- **`parseAddress` in `src/options.ts` uses `indexOf(":")`** — it is NOT IPv6-aware
  and treats `[::1]:9000` / `fe80::1` / `a,b` incorrectly. Plan 3 Task 6 replaces
  this for `ws`/`wss` with `parseAddrList` (multi-host list, IPv6-aware, duplicate-
  rejected). Keep the ILP HTTP/TCP path intact; only ws/wss get the list form.
  `SenderOptions` already has `addr?: string` plus derived `host`/`port` — store the
  parsed `Endpoint[]` alongside and leave `host`/`port` pointing at the first entry
  so existing transport code keeps working.
- **`QwpTransport.connect()` is still a single shot** — one `QwpWebSocket.connect`,
  no retry/rotation, no NACK/ACK handling (responses are dropped by the socket
  default). Plan 3 turns this into `connectLoop` with the `HostTracker` round,
  `421`-retries-forever / `401`-terminal classification, and dictionary catch-up.
- **Symbol dictionary ownership moves to the transport in Plan 3.** In Plan 2 the
  dict lives on `QwpBuffer` (fill-time registration). Plan 3 Task 8 re-registers
  from id 0 after every reconnect via a catch-up frame, because the server's
  dictionary is connection-scoped and empty. The transport must own the shared
  `SymbolDict` and attach it to the buffer — `confirmedMaxId` is the reconciliation
  point, and the catch-up frame must be sent before any data frame.
- **Sequencing correction in the plan is real.** Replay is NOT in scope (Task 4
  surfaces in-flight loss as `DATA_LOSS` instead of hiding it) — the retention ring
  is Plan 4. Don't try to resurrect unacked frames.
- **`QwpTransport` must honor the `tls_verify !== false` guard** and the
  upgraded-hosts flow — a `wss::` endpoint list still goes through the same
  `QwpWebSocket.connect` TLS path.

## Environment notes

- **`pnpm <script>` gates fail** (ignored-builds check). Use
  `./node_modules/.bin/{tsc,vitest,eslint}` directly. Keep zero new runtime deps
  (`undici` is the only one).
- **Docker is unavailable in this shell;** a **QuestDB 10.0.0** runs at
  `localhost:9000`. The e2e accepts `QWP_TEST_ADDR=host:port` to target an existing
  server and skips when neither that nor Docker is available.
  ```bash
  QWP_TEST_ADDR=localhost:9000 ./node_modules/.bin/vitest run test/qwp/integration.test.ts
  ```
  Plan 3's `test/qwp/mockServer.ts` is fully in-process (`node:net`), so its tests
  need **no** Docker — run them directly.
- `questdb-client-test` submodule needs `git submodule update --init` for the
  pre-existing interop test (unrelated to QWP).

## Verified end-to-end (cumulative through Plan 2, against real QuestDB 10.0.0)

- `ws://` single row SYMBOL/DOUBLE/LONG + designated TIMESTAMP land correctly.
- All-types row (SYMBOL, VARCHAR, BOOLEAN, LONG, DOUBLE, TIMESTAMP +
  designated) lands with correct values.
- **Multi-table single-frame flush** works (two extra tables land in one flush).
- **Gorilla 20-row constant-interval series** decodes exactly (bit-reversal trap
  confirmed on the wire).

## Plan 3 scope (from `2026-08-07-qwp-plan-3-errors-and-failover.md`)

Response decoder (`response.ts`), error categories/policies (`errors.ts`),
ACK→FSN correlation (`ackTracker.ts`, spec 6.6.1 — the highest-risk item: wire
`seq` is connection-scoped and restarts at 0 per reconnect, `ackedFsn =
fsnAtZero + seq` clamped), mock QWP server + surfacing in-flight loss, poison
detector (strike AND dwell — count alone is not enough), `addr` list grammar,
state-ranked host tracker with private cursors (zone-blind — do NOT add zone
tiers), reconnect/rotation/dictionary catch-up, and drop-oldest notification
dispatchers + derived connect mode (any `reconnect_*` key ⇒ eager connect).
Re-run the ten traps in `README.md` and lean on the Java source at
`/home/nick/repos/questdb-enterprise-4/questdb/core/src/main/java/io/questdb/cutlass/qwp/` **Version caution:** that checkout's `java-questdb-client` submodule is at **1.3.3-SNAPSHOT**, four behind the **1.3.7-SNAPSHOT** the design spec §2 pins (`~/claude/wt/oss/wal-pending-negative/java-questdb-client`, HEAD `8f5ed4f9`). Its *server-side* `cutlass/qwp` codecs were checked and are post-#7200 (no `schema_id`), so they are safe for protocol ground-truth — but read client-side behaviour from the pinned checkout, and check `core/pom.xml` before trusting either.
for any ambiguous wire byte.
