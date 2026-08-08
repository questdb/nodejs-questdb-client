# Handoff — Plan 3 (errors & failover) done, for the agent executing Plan 4

**Read first:** `docs/superpowers/plans/README.md`, then `2026-08-07-qwp-plan-4-store-and-forward.md` (Plan 4 may not exist yet at this commit — if not, the design spec still governs).
The design spec wins over any plan text: `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`.

## State

- Branch `feat/qwp-design`. Plan 3 (Tasks 1–9) fully implemented and committed on
  top of Plan 2. Full QWP suite green: **111 passed, 2 skipped** (`npx vitest run
  test/qwp/`); `tsc --noEmit` and `eslint src/` clean. Live e2e against real
  QuestDB 10.0.0 (via `QWP_TEST_ADDR=localhost:9000`) passes both tests.
  Only non-Docker skips are the two `test/qwp/integration.test.ts` rows (no
  `QWP_TEST_ADDR` set in the bare run) plus the pre-existing Docker-only
  `test/sender.integration.test.ts`.
- Plan 3 added `src/qwp/protocol/response.ts`, `error.ts`, `ackTracker.ts`,
  `poison.ts`, `endpoints.ts`, `hostTracker.ts`, `dispatcher.ts`; heavily
  modified `src/qwp/transport.ts`, `src/qwp/ws/socket.ts`, `src/options.ts`,
  `src/sender.ts`, `src/qwp/protocol/constants.ts`; added `test/qwp/mockServer.ts`.
- All 9 plan tasks verified by an independent reviewer (pass/fail checklist in
  the review: all PASS, no blockers). Plan 3 = 10 commits: `90eb9bc`
  (Task 1/response) + the 9 commits in `git log 90eb9bc..HEAD`.

## Carry-forward corrections (verified live / against Java source) — still true

1. **Designated timestamp = EMPTY-name column.** `at()` writes a column with
   `nameLen=0`, `TYPE_TIMESTAMP`; server names it `timestamp`. Never send a column
   literally named `timestamp` (duplicate-column rejection). — from Plan 1.
2. **Clients mask, servers unmask.** The Plan 3 mock (`test/qwp/mockServer.ts`)
   has its own `MaskedFrameReader` (unmasks client frames) and `encodeServerFrame`
   (does NOT set the mask bit). Do not "fix" the mock by reusing the shared
   `FrameParser` (rejects masked inbound) or `encodeClientFrame` (masks outbound):
   the client's ACK tests would fail. The plan text's original mock snippet was
   buggy on both counts; the implemented version is correct.
3. **`tls_verify` is a `boolean`** (`unsafe_off`→false). Guard TLS / cert verify
   as `!== false`. `wsOptions()` already does `rejectUnauthorized: opts.tls_verify !== false`.
4. **Gorilla byte-correct** (Plan 2, bit-reversed prefixes) — Plan 3's decoder
   reads ACK frames only; don't assume timestamp payloads.
5. **`421` role reject retries forever; `401`/`403` is terminal** (`parseUpgradeResponse`
   throws `QwpUpgradeError` with `kind` `"role-reject"` vs `"auth"`). `connectLoop`
   records `TOPOLOGY_REJECT` for role-rejects and re-throws auth (`transport.ts`).
6. **Poison escalation needs strikes AND dwell** (`PoisonDetector`), and the
   **notification inbox drops the OLDEST** (`Dispatcher`). Both implemented and
   unit-tested; neither is yet wired into the transport lifecycle (see gaps).

## API surfaces Plan 4 consumes — how they changed in Plan 3

- **`QwpTransport`** gained the connection lifecycle: `connect()` → `connectLoop()`
  (host-tracker rotation, `421`-forever), `sendDictCatchUp()` (re-register dict
  from id 0 after every connect, before any data frame), `ackedFsn` getter,
  `onError(h)`, `onConnectionEvent(h)`, `connectedEndpoint`, and test hooks
  `registerSymbolForTest` / `reconnectForTest`. `sendFrames(frames)` bumps
  `inFlight` and `acks.onFrameSent()` per frame; `onResponse` decrements on OK and
  `onDisconnected` emits `DATA_LOSS` for in-flight loss.
- **`QwpWebSocket.connect(opts)`** now takes `onBinary`/`onClose` callbacks and
  fires them for inbound BINARY frames and external/remote-close teardown. Its own
  `close()` sets `closed` first, so a graceful shutdown does NOT trigger `onClose`.
  `maxBatchSize` comes from the `X-QWP-Max-Batch-Size` handshake header.
- **`AckTracker`** (`onConnected(fsnAtZero)`, `onFrameSent()`, `onAck(wireSeq)`,
  `acked`) — the seq→FSN bridge and clamp. `ackedFsn` is Plan 4's replay start.
- **`SenderError` / `Category` / `Policy` / `classify` / `defaultPolicyFor`** in
  `errors.ts` — the error taxonomy Plan 4's quarantine + replay policy will lean on.
- **`Dispatcher<T>`** — drop-oldest inbox; the transport routes errors through one
  (cap `error_inbox_capacity ?? 256`) and connection events through a separate one
  (cap `connection_listener_inbox_capacity ?? 64`). Config minimum is **16**.
- **`HostTracker.newCursor()`** — the private round used by background drainers.
- **`parseAddrList`** (`endpoints.ts`) — the IPv6-aware multi-host list parser.
  `SenderOptions` now stores `endpoints` for ws/wss (host/port point at entry 0).
- **`UNCAPPED_CATCHUP_PACKING_LIMIT = 64 KiB`** in `constants.ts` — catch-up cap
  when the server does not advertise one.

## The single biggest structural gap Plan 4 must close

**The transport's dictionary is NOT attached to the buffer.** In Plan 2 the
`SymbolDict` lived on `QwpBuffer` (fill-time registration) and data frames were
delta-encoded against it. Plan 3 moved dictionary ownership to the transport
(`transport.dict`), which now does the post-reconnect catch-up — **but the
`Sender` still builds the buffer via `createBuffer(options)` with
`attachDict(undefined)`, so real data frames are still full-dict/inline mode and
`transport.dict` stays empty at runtime** (it's only populated by
`registerSymbolForTest` in tests). The sender must wire `buffer.attachDict(
transport.dict)` (and feed `confirmedMaxId`) so fills register into the
transport-owned dict and delta frames align with catch-up. Don't try to bolt this
onto the current buffer path; it belongs in the Plan 4 store-and-forward
restructure where the send log becomes the frame source of truth. Flag it to the
reader explicitly rather than silently assuming delta mode works end-to-end.

## Things the next agent will likely trip on

- **`send()` vs `sendFrames()` asymmetry.** `send()` writes a single frame but
  does NOT bump `inFlight`/`acks`; only `sendFrames()` does. Harmless today
  (QWP flush always uses `sendFrames`), but confusing — don't route replay through
  `send()` or acked-FSN tracking silently breaks.
- **No auto-reconnect after a mid-stream drop, yet.** `onDisconnected` surfaces
  `DATA_LOSS` but does NOT re-enter `connectLoop`; a real send after a drop throws
  "not connected" until the user reconnects. Plan 4's store-and-forward + replay
  is exactly where that must become automatic (drain unacked from the ring, not
  resurrect in-flight).
- **`applyMask` mutates in place.** The mock's `MaskedFrameReader` calls
  `applyMask(payload, key)` on a `Buffer.from(...)` copy — safe. But `encodeClientFrame`
  also applies the mask in place on its own copy. Don't share payload buffers
  between mock writes or the mask double-applies.
- **Eager connect (SYNC) is fire-and-forget** (`sender.ts` constructor: any
  `reconnect_*` key ⇒ `this.connect().catch(log)`). A user who ALSO calls
  `await sender.connect()` explicitly can double-connect. Untested edge; reconcile
  in Plan 4's connect-mode handling.
- **`Dispatcher` delivers via `setImmediate`** — test assertions must wait a tick
  (the ACK/in-flight tests wait 100–200ms; the reconnect catch-up test polls for
  `frames[0]`). Don't assert synchronously after a send.
- **Options `endpoints` vs re-parse:** `connect()` re-runs
  `parseAddrList(this.options.addr!, 9000)` rather than reading
  `options.endpoints`. Both are consistent; don't mix them.
- **`HANDOFF-plan2-to-plan3.md` still exists** and its "plan-2 consumed" notes are
  stale — this file supersedes it for Plan 4 purposes.

## Environment notes

- **`pnpm <script>` gates fail** (ignored-builds check). Use
  `./node_modules/.bin/{tsc,vitest,eslint}` directly. Zero new runtime deps.
- **Docker unavailable in this shell;** a **QuestDB 10.0.0** runs at
  `localhost:9000`. The e2e accepts `QWP_TEST_ADDR`:
  ```bash
  QWP_TEST_ADDR=localhost:9000 ./node_modules/.bin/vitest run test/qwp/integration.test.ts
  ```
  The in-process `mockServer.ts` (node:net) needs no Docker — run mock tests directly.

## Verified end-to-end (cumulative through Plan 3, against real QuestDB 10.0.0)

- All Plan 2 wins (single row, all-types, multi-table single-frame, Gorilla
  20-row constant-interval series) still land correctly.
- ACK handling, NACK categorisation (PARSE_ERROR → terminal), and in-flight-loss
  `DATA_LOSS` surfacing verified against the in-process mock.
- `421`-rotation (bad endpoint → good endpoint), `401`-terminal, and dictionary
  catch-up-after-reconnect verified against the mock.
- Live e2e (both integration tests) green after the transport/socket changes.

## Plan 4 scope preview (from `2026-08-07-qwp-plan-4-store-and-forward.md`)

Durable send log, the retention ring (the missing piece that makes `DATA_LOSS`
from a quarantined slot and replay-from-`ackedFsn+1` possible), crash recovery,
and release 5.0.0 (originally specified as 4.3.0 — see design spec §3.5 for why
it became a major). `AckTracker.ackedFsn` is your replay baseline; `HostTracker.newCursor()`
is for background drainers; the mock + `Dispatcher` + error taxonomy are ready to
consume. Remember the trap list in `README.md` still applies — notably the `.symbol-dict`
file fallback and never-zeroing a torn tail during the scan (spec 8.1.5/8.1.6).
