# Handoff — A1 orphan scan + background drainers done

**Supersedes:** `docs/superpowers/plans/HANDOFF-plan6.md`.

**Context:** Branch `feat/qwp-design`. This session completed **A1** — the last
major deferred store-and-forward feature: orphan scanning and background
drainers (spec 8.4). Enable switch was removing the "drain_orphans is not yet
implemented" construction-time throw, which is now gone.

Source of truth: `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`
(section numbers cited).

**Green:** `tsc --noEmit` clean; `eslint src/` clean; QWP unit suite 170 passed /
3 skipped; integration (live `localhost:9000`, `QWP_TEST_ADDR`) 3/3. Live
integration re-verified after the engine `recover()` refactor below.

---

## DONE this session — A1: orphan scan + background drainers (spec 8.4, 1.2, 7.5, 8.3)

### New modules
- **`src/qwp/sf/orphanScanner.ts`** — `scanOrphans(sfDir)` lists subdirectories not held by a
  live lock. Skips dotfiles (incl. the `.slot-locks` logical-lock area) and any
  slot renamed with a `.quarantined.<n>` infix (those already carry a `.failed`
  sentinel and are human-in-the-loop, so the `.failed` skip falls out of the
  rename — the "A2 change" the previous plan referenced).
- **`src/qwp/sf/drainer.ts`** — `OrphanDrainer` + `startOrphanDrainers`:
  - **Adoption (spec 8.3):** takes the parent-anchored **logical lock**
    (`<sfDir>/.slot-locks/<senderId>`) → **revalidates** the scanner snapshot
    (slot's `.lock` still not live) → takes the **slot lock** via `acquireSlot`
    (which cleans a stale `.lock` and refuses if a live holder appeared) →
    releases the logical lock.
  - **Read-only recovery:** `SfEngine.openReadOnly` parses the ring + ack
    watermark + symbol dictionary without taking a lock, opening write
    descriptors, or starting the durability barrier.
  - **Replay:** opens its **own** WebSocket using a **private round cursor**
    (`HostTracker.newCursor()` — never the shared round, spec 1.2), re-registers
    the recovered dictionary from id 0 (spec 7.5), replays every unacked frame
    until `ackedFsn` catches the startup snapshot of `publishedFsn`, then
    releases the slot.
  - **Terminal vs transient:** an auth failure or a persistent cap-gap
    (16 attempts **and** 300 s dwell, spec 7.5) drops a `.failed` sentinel and
    emits `DATA_LOSS`/`ABANDONED` with `quarantinedPath`; a transient outage is
    retried indefinitely (single-endpoint backoff loop, so it never busy-spins).
  - Health results are recorded into the shared `HostTracker` ledger (not the
    shared round).
- `startOrphanDrainers` bounds concurrency to `max_background_drainers` and
  reports each drainer eagerly via `onStart` so `transport.close()` can stop
  them even while scanning/starting.

### Files touched
`src/qwp/sf/orphanScanner.ts` (new), `src/qwp/sf/drainer.ts` (new),
`src/qwp/sf/slotLock.ts` (added `isLiveLock`, `lockHolderLive`,
`acquireLogicalLock`, `releaseLogicalLock`), `src/qwp/sf/engine.ts`
(refactored `open()` → shared `recover()` + added `SfEngine.openReadOnly`),
`src/qwp/transport.ts` (start drainers once in `doConnect`, after our own slot
locks; stop them on `close()`), `src/options.ts` (`drain_orphans` now requires
`sf_dir` instead of throwing "not yet implemented"), `README.md`.

### Test coverage (the `.failed` path is unit-covered)
- `test/qwp/sf/orphan.test.ts` (new, 4 tests): scanner finds stale/absent-lock
  slots while skipping live-held, dotfile and quarantined dirs; drainer replays
  a foreign sender's orphan slot to a fresh ACKing server (rows present); drainer
  re-registers the recovered `.symbol-dict` (bare catch-up frame precedes the
  replayed delta frames); drainer drops `.failed` + emits `DATA_LOSS` on a
  401 auth-terminal failure.
- Existing `crash.test.ts` still covers the *same-sender re-adopt* path (a new
  `default` sender recovers its own slot), which complement the *foreign-slot*
  drainer path.

---

## REMAINING — deferred

### C2. `sf-manifest.bin` / `SFM1` (spec 8.2, 8.1.1) — still optional
Recovery validates the chain only by scanning `.sfa` files and checking
contiguity; there is no manifest to cross-check the chain head against
(`MANIFEST_REQUIRED_FLAG` also unset). Keep the alternating-generation scheme
(offsets 0 / 4096) if you add it.

### Cleanup — `.symbol-dict` read quarantine (mostly done)
The engine `recover()` refactor now routes **both** a corrupt segment chain and
a corrupt symbol dictionary through the caller's failure path: the owner
`open()` wraps `recover()` in `failQuarantined`, and the drainer wraps it in a
`.failed` + `DATA_LOSS`. The old hole ("corrupt `.symbol-dict` reads fail open()
with a bare `bad magic` instead of quarantining") is closed. No further work.

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
  delta baseline advances only after a frame is queued onto the ring (5.2);
  drainers must use `HostTracker.newCursor()` — never the shared round (1.2).
