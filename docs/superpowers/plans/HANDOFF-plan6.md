# Handoff — B1 delta wiring done + remaining deferred items

> **SUPERSEDED — do not follow this file as current state.** Superseded by
> `HANDOFF-plan7.md`, and the head of the chain is `HANDOFF-plan8.md`.
> Its "remaining work" lists are stale: items recorded here as gaps were
> resolved in later sessions. Read `HANDOFF-plan8.md` first and use this file only as
> history.

**Supersedes:** `docs/superpowers/plans/HANDOFF-plan5-deferred.md`.

**Context:** Branch `feat/qwp-design`. This session completed **B1** — the last
big gap from the previous plan handoff: the symbol dictionary is now wired into
the buffer, so **delta symbol-dictionary mode runs end-to-end**. Verified with a
live QuestDB (10.0.0 at `localhost:9000`) including a non-empty dictionary
recovered across a restart.

Source of truth: `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`
(section numbers cited).

**Green:** `tsc --noEmit` clean; `eslint src/` clean; QWP unit suite 166 passed
/ 3 skipped; full unit suite 328 passed / 3 skipped (only `sender.integration`
fails, and only because Docker/TestContainers is unavailable); bunchee emits
ESM+CJS. QWP live e2e `QWP_TEST_ADDR=localhost:9000` passes (3/3).

---

## DONE this session — B1: wire the symbol dictionary into the buffer (spec 5.2, 8.1.6, 7.5)

### Fix 1 — baseline advance moved to publish time (the spec-5.2 blocker)
`QwpBuffer.sealFrames` no longer advances `confirmedMaxId` at seal/encode time.
It still write-ahead-persists the batch's new symbols (moving only the persist
cursor), then records the intended advance in a transient `deltaTarget`. The
transport calls the new `QwpBuffer.confirmDeltaPublished()` from
`QwpTransport.sendFrames` **only after each frame is successfully queued onto
the store-and-forward ring**; a `PAYLOAD_TOO_LARGE` / backpressure-deadline
throw happens *before* that call, so a failed publish can never advance the
baseline past ids the server never saw. `reset()` now keeps `confirmedMaxId`
(and `deltaTarget`) — the dictionary is connection-scoped, independent of any
one buffered batch.

Split batch in delta mode: **part 0 carries the whole batch delta; parts 1..n
are pinned to the post-batch baseline (empty delta)** — otherwise each re-ships
the same entries and the server would re-register them positionally, silently
renumbering ids. Safe because later parts publish only after part 0. Deliberate
one-way delta→full-dict fallback on persist failure is preserved
(`disableDeltaDict`, spec 5.2).

### Fix 2 — recovery seeding
`QwpTransport.attachSymbolBuffer(buffer)` (called from the `Sender` constructor)
shares the transport-owned `this.dict` with the buffer and installs
`engine.persistSymbols` as the persist hook. In `doConnect()` after
`engine.open()`, the engine's recovered dictionary is copied into `this.dict`
**positionally via `addRecovered`** (never `getOrAdd`, which de-dupes and would
desync positions), and `buffer.setConfirmedMaxId(recoveredSize - 1)` is fed so the
first flush re-persists only *new* symbols instead of re-writing the recovered
baseline. `sendDictCatchUp` now also re-pins the buffer baseline to
`dict.size() - 1` after re-registering the whole dictionary on a fresh/reconnected
server.

### Fix 3 — latent `.symbol-dict` header bug surfaced by enabling delta
`SfEngine.persistSymbols` appended raw chunks with **no `SYD1` header**, so a
recovered dictionary read threw `symbol dict: bad magic`. The engine now writes
the `SYD1` header on a fresh (or zero-length) slot before any chunk.
(Note: a corrupt `.symbol-dict` read is still not inside the
`failQuarantined` guard — see **C2/cleanup** below.)

**Files touched:** `src/qwp/buffer.ts`, `src/qwp/transport.ts`,
`src/sender.ts`, `src/qwp/sf/engine.ts`, `README.md`.

**New tests:** `test/qwp/deltaPublish.test.ts` (ordering + delta-split),
one case in `test/qwp/transport.test.ts` (delta wiring through the mock server),
one case in `test/qwp/sf/engine.test.ts` (SYD1 header + positional recovery),
one live case in `test/qwp/integration.test.ts` (delta persist + recover across a
restart against the real server).

---

## REMAINING — deferred

### A1. Orphan scan + background drainers (spec 8.4)
`drain_orphans` still throws at construction (`parseSfOptions`,
"drain_orphans is not yet implemented"). Scan `<sf_dir>/` for slot dirs not held
by a live lock; hand each to a drainer (own WS connection, bounded by
`max_background_drainers`) that replays read-only until `ackedFsn` catches the
startup snapshot of `publishedFsn`, then releases. Drainers must use
`HostTracker.newCursor()` (private round, spec 1.2, never the shared one). The
`.failed` sentinel orphan drainers should skip is already dropped by the A2
change. Removing the construction-time throw is the enable switch. Needs the
live server + multiprocess coordination (see `test/qwp/sf/crash.test.ts`).

### C2. `sf-manifest.bin` / `SFM1` (spec 8.2, 8.1.1) — not in the original plan
Recovery validates the chain only by scanning `.sfa` files and checking
contiguity; there is no manifest to cross-check the chain head against
(`MANIFEST_REQUIRED_FLAG` also unset). Only add if cross-checking earns its
complexity; keep the alternating-generation scheme (offsets 0 / 4096) if you do.

### Cleanup / hardening worth doing alongside (small)
- The `.symbol-dict` read in `SfEngine.open` is load-bearing (spec 8.1.6) but is
  **not** wrapped in the `failQuarantined` guard the segment scan uses — a truly
  corrupt dictionary currently fails `open()` with a bare `bad magic` error
  instead of quarantining the slot. Consider routing it through the same
  quarantine path (left out here to keep B1's diff focused).

---

## Environment notes
- `pnpm <script>` gates fail (ignored-builds). Use
  `./node_modules/.bin/{tsc,vitest,eslint,bunchee}` directly.
- Docker is unavailable; a QuestDB 10.0.0 runs at `localhost:9000`
  (`QWP_TEST_ADDR=localhost:9000 ./node_modules/.bin/vitest run test/qwp/integration.test.ts`).
- **Trap reminders** (`plans/README.md`): never zero a torn tail during the scan
  (8.1.5); recovery de-duplication of `.symbol-dict` is forbidden (8.1.6);
  `seq` is connection-scoped, not an FSN (6.6.1); `421` retries forever / `401`
  terminal (6.5.1); periodic fsync has no Node directory-fsync analogue (8.2);
  delta baseline advances only after a frame is queued onto the ring, and a
  reconnect catch-up re-pins it to the dictionary tail (5.2, 7.5).
