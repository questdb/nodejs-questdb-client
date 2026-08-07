# Handoff — deferred follow-ups, completed + remaining

**Supersedes:** `docs/superpowers/plans/HANDOFF-plan4-deferred.md`.

**Context:** Branch `feat/qwp-design`. On top of Plan 4 (`git log b5399b2..HEAD`),
this session resolved most of that handoff's deferred items. QWP suite is green
**161 passed, 2 skipped** (Docker-only integration guarded by `QWP_TEST_ADDR`).
`tsc --noEmit` clean, `eslint src/**` clean, `bunchee` emits ESM+CJS. Live e2e
against QuestDB at `localhost:9000` passes.

Source of truth: `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`
(section numbers cited below).

---

## DONE in this session (each verified by unit tests)

- **A2 — Quarantine (spec 8.4).** New `src/qwp/sf/quarantine.ts`:
  `quarantineSlot()` renames `<sf_dir>/<sender_id>` to
  `<sender_id>.quarantined.<n>` (a name `acquireSlot` never re-adopts), drops a
  `.failed` sentinel, and refuses past `MAX_QUARANTINED` (64) copies.
  `SfEngine.open()` catches bad-magic / non-contiguous / negative-baseSeq
  recovery failures and surfaces a `SenderError(DATA_LOSS, ABANDONED)` with
  `quarantinedPath`. Tests in `test/qwp/sf/engine.test.ts`.
- **A3 — `sf_durability=periodic` (spec 8.2, 9.2) + `sf_sync_interval_millis`.**
  `parseSfOptions` accepts `sf_sync_interval_millis` (default 5000, spec 9.1)
  and enforces `sf_sync_interval_millis requires sf_durability=periodic` and
  `periodic requires sf_dir`. The engine runs a background
  `runBarrier()` every interval that fsyncs the active segment
  (`fh.sync()`, spec 8.1.5 `syncPublished` semantics) then writes the ack
  watermark. **Node has no directory fsync** — the slot-dir covering fsync of
  spec 8.2 has no portable analogue; documented in a comment.
- **C1 — ACK watermark coalesced, not per-ACK (spec 8.2 consequence 1).**
  `SfEngine.acknowledge()` now only marks `watermarkDirty`; the boundary is
  written on the barrier cadence and on the final barrier in `close()`. A new
  `.ack-watermark` appears only after an ACK was observed; a no-ACK engine
  writes nothing. Tests in `test/qwp/sf/engine.test.ts`.
- **C3 — `request_durable_ack` wired (spec 6.5.1).** Confirmed against the
  QuestDB server source: the request header is **`X-QWP-Request-Durable-Ack:
  true`**; the echo is **`X-QWP-Durable-Ack: enabled`** (only when the server's
  durable-ack registry is enabled). `buildUpgradeRequest` sends it when
  `request_durable_ack=on`; `parseUpgradeResponse` reads the echo;
  `QwpWebSocket.durableAck` reflects it; and `QwpTransport.connectLoop`
  **fails fast (terminal, no rotation)** on `request_durable_ack=on` without the
  echo, via a `DurableAckMismatchError` that escapes the rotation loop.
- **C4 — eager-connect double-connect (spec 4.3).** `QwpTransport.connect()`
  is now idempotent: an explicit `connect()` joins the in-flight/finished
  fire-and-forget connect (`connectPromise`) instead of re-opening the engine
  (which would trip the slot lock). Tests in `test/qwp/transport.test.ts`.
- **B1b — catch-up seq off-by-one (spec 6.6.1).** `AckTracker` now knows how
  many dictionary catch-up frames precede the ring replay
  (`onConnected(replayStartFsn, catchUpFrames)`); catch-up ACKs (lowest wire
  seqs) are ignored and ring-frame FSNs are shifted by the catch-up count.
  `sendDictCatchUp()` returns its frame count and the transport passes it, so
  the bug is fixed ahead of B1 (harmless while the dict is empty). Tests in
  `test/qwp/ackTracker.test.ts`.
- **B1a — verified already fixed.** `columnWriter` size path (line 102) and
  write path (line 257) both use `symbolId(v)`; `deltaDict.test.ts` covers
  ids ≥ 128.
- README QWP caveats updated (periodic durability now real; `request_durable_ack`
  now fails fast when unconfirmable; `drain_orphans` still unimplemented).

**QWP test files touched:** `test/qwp/sf/engine.test.ts` (new),
`test/qwp/ackTracker.test.ts`, `test/qwp/options.test.ts`,
`test/qwp/transport.test.ts`, `test/qwp/ws.handshake.test.ts`,
`test/qwp/mockServer.ts`.

---

## REMAINING — the biggest gap, deliberately not enabled this session

### B1. Wire the symbol dictionary into the buffer (delta mode end-to-end)

`QwpBuffer.attachDict(dict, persist)` and `SfEngine.persistSymbols` /
`SymbolDict.addRecovered` exist and are unit-tested, but **nothing in
`src/sender.ts` / `src/qwp/transport.ts` calls them**, so `.symbol-dict` is never
written at runtime and delta mode never activates (frames go full-dict, which is
why data is correct today). This is the single biggest structural gap.

Why this session did NOT flip it on:

1. **Spec 5.2 ordering — the blocker.** "The baseline advances only after a
   frame carrying the batch's symbols is **queued onto the ring**, never at
   symbol-allocation time." `QwpBuffer.sealFrames` currently advances
   `confirmedMaxId` *before* `sendFrames` queues the frame. Today that is
   harmless because frames are self-sufficient. In delta mode, a failed publish
   between `sealFrames` and ring-append (`PAYLOAD_TOO_LARGE`, backpressure
   deadline) would advance the baseline past symbols the server never received →
   `DICTIONARY_GAP` on the next frame. **Must move the baseline advance to
   publish time** (return the introduced-id-range from `sealFrames`, advance in
   `sender.flush()`/`sendFrames` only on successful append, and degrade to
   full-dict on failure) before enabling delta.
2. **Recovery seeding.** `transport.dict` is a *different* `SymbolDict` from the
   engine's recovered one. On disk-mode recovery you must seed `transport.dict`
   from `engine.symbolDict` via `addRecovered` (positional, **never** `getOrAdd`,
   which de-dupes and desyncs ids), and call `buffer.setConfirmedMaxId(M)` (M =
   recovered size − 1) so only *new* symbols re-persist (otherwise the first
   flush re-writes the whole recovered baseline to `.symbol-dict` and corrupts
   the positional id scheme).
3. **End-to-end verification needs a non-empty dictionary against a real
   server** (the in-process mock never produces a catch-up frame). This session's
   server (`localhost:9000`, QuestDB 10.0.0) is available for it.

Suggested wiring point: the `Sender` constructor creates `createBuffer(options)`
and `createTransport(options)`; add e.g. `QwpTransport.attachSymbolBuffer(buffer)`
that calls `buffer.attachDict(this.dict, (e) => this.engine.persistSymbols(e))`
and, in `doConnect()` after `engine.open()`, seeds `this.dict` from
`engine.symbolDict` and feeds `buffer.setConfirmedMaxId(...)`. Keep the
one-way `disableDeltaDict()` fallback (spec 5.2) live.

---

## REMAINING — deferred, optional

### A1. Orphan scan + background drainers (spec 8.4)
`drain_orphans` still throws at construction (`parseSfOptions`,
"drain_orphans is not yet implemented"). Scan `<sf_dir>/` for slot dirs not held
by a live lock; hand each to a drainer (own WS connection, bounded by
`max_background_drainers`) that replays read-only until `ackedFsn` catches the
startup snapshot of `publishedFsn`, then releases. Drainers must use
`HostTracker.newCursor()` (private round, spec 1.2, never the shared one). The
`.failed` sentinel that orphan drainers should skip is now dropped by A2, so
that half is ready. Removing the construction-time throw is the enable switch.
This needs the live server and multi-process coordination (see
`test/qwp/sf/crash.test.ts` for the child-process pattern).

### C2. `sf-manifest.bin` / `SFM1` (spec 8.2, 8.1.1) — NOT in the original plan.
Recovery validates the chain only by scanning `.sfa` files and checking
contiguity in `SegmentRing.recovered`; there is no manifest to cross-check the
chain head against (`MANIFEST_REQUIRED_FLAG`, segment header flags bit 0, is
also unset). Only add if cross-checking the chain head earns its complexity;
keep the alternating-generation crash-safe scheme (offsets 0 / 4096) if you do.

---

## Environment notes
- `pnpm <script>` gates fail (ignored-builds). Use
  `./node_modules/.bin/{tsc,vitest,eslint,bunchee}` directly.
- Docker is unavailable; a QuestDB 10.0.0 runs at `localhost:9000`
  (`QWP_TEST_ADDR=localhost:9000 ./node_modules/.bin/vitest run test/qwp/integration.test.ts`).
- **Trap reminders** (`plans/README.md`): never zero a torn tail during the scan
  (8.1.5); recovery de-duplication of `.symbol-dict` is forbidden (8.1.6);
  `seq` is connection-scoped, not an FSN (6.6.1); `421` retries forever / `401`
  terminal (6.5.1); periodic fsync has no Node directory-fsync analogue (8.2).
