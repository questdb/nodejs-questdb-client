# Handoff — Plan 4 done; deferred items for the next agent

**Context:** Branch `feat/qwp-design`. QWP Plan 4 (Store-and-Forward, spec PRs 12–16) is
fully implemented and committed on top of Plans 1–3 (`git log b5399b2..HEAD`). The QWP
suite is green: **142 passed, 2 skipped** (`npx vitest run test/qwp/` — the 2 skips are
Docker-only). `tsc --noEmit` and `eslint src/**` are clean; `bunchee` emits ESM+CJS.
Live e2e against real QuestDB 10.0.0 (`QWP_TEST_ADDR=localhost:9000`) passes. Release
version bumped to 4.3.0.

**Source of truth:** `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`.
Plan: `docs/superpowers/plans/2026-08-07-qwp-plan-4-store-and-forward.md`. Traps list:
`docs/superpowers/plans/README.md`.

---

## What the next agent should do

There is no Plan 5 in `plans/README.md` (only four plans). The items below are what the
Plan 4 implementation deliberately left out or left latent. Each is either (a) an
explicitly reduced-scope item from the plan's self-review, or (b) a correctness gap a
review surfaced after the fact. **All are optional follow-ups** — verify each against
the spec section cited before implementing, and don't treat "exists" as "correct".

---

## A. Explicitly reduced scope in the plan's self-review

### A1. Orphan scan + background drainers (spec 8.4)
- **Status:** `drain_orphans` is parsed but `parseSfOptions` throws `"drain_orphans is not yet implemented"` (`src/options.ts`).
- **What's needed:** scan `<sf_dir>/` for slot dirs not held by a live lock; hand each to
  a drainer that opens its **own** WS connection (bounded by `max_background_drainers`),
  replays read-only until ackedFsn catches the startup snapshot of publishedFsn, then
  releases the slot. Drainers must use `HostTracker.newCursor()` (spec 1.2: private round,
  never the shared one).
- **Design note:** when you enable it, remove the construction-time throw in `parseSfOptions`.

### A2. Quarantine — rename + `.failed` sentinel + 64-copy cap (spec 8.4)
- **Status:** not built. A corrupt/unopenable slot currently fails loudly in `scanSegment`
  (`segment.ts` throws on bad magic/version) instead of being set aside.
- **What's needed:** two-step quarantine (rename slot with a quarantine infix **not** the
  sender's own name + drop a `.failed` sentinel so orphan drainers skip it). Cap at 64
  quarantined copies per `sf_dir`; refuse to set aside another beyond that. On `DATA_LOSS`
  / `ABANDONED`, surface `quarantinedPath`.

### A3. `sf_durability=periodic` fsync cadence (spec 8.2)
- **Status:** only `memory` durability is wired. `periodic` is accepted by the parser but
  **no** background barrier is scheduled — it is effectively a no-op. The README now states
  this honestly, but the feature is unimplemented.
- **What's needed:** a background task that, every `sf_sync_interval_millis`, does the
  covering barrier — fsync the slot dir **before** unlinking trims, and **again** after
  the batch; also fsync the active segment (write + `fdatasync` per `syncPublished()`
  semantics, spec 8.1.5). Add `sf_sync_interval_millis` to `ValidConfigKeys` (it is
  currently rejected as unknown).

---

## B. The single biggest structural gap (carried from Plan 3 handoff)

### B1. The transport's symbol dictionary is NOT attached to the buffer
- **Status:** `QwpBuffer.attachDict(dict, persist)` (`src/qwp/buffer.ts`) exists and is
  fully unit-tested (delta→full-dict fallback, `{id,text}` storage), and
  `SfEngine.persistSymbols` / `SymbolDict.addRecovered` exist. But **nothing in
  `src/sender.ts` / `src/qwp/transport.ts` calls them** — the Sender still builds the
  buffer in full-dict mode, so:
  - `.symbol-dict` is never written at runtime (persist path is dead);
  - delta mode never activates end-to-end;
  - `transport.dict` stays empty (only `registerSymbolForTest` populates it),
    so `sendDictCatchUp()` is a no-op in production.
- **Why it matters:** delta mode is the point of the whole persisted-dict design (8.1.6),
  and the fallback defence (5.2) is unreachable. Data is currently correct because frames
  are full-dict/self-sufficient.
- **Where it belongs:** wire `buffer.attachDict(transport.dict, (entries) => engine.persistSymbols(entries))`
  (and feed `setConfirmedMaxId`) in the Sender/transport glue, with the engine as the
  source of truth. See the `KNOWN GAP` comment above `SfEngine.persistSymbols`.
- **Before you wire delta mode, fix these two latent delta bugs that review found:**
  - **B1a. `columnWriter` delta size vs write must both use the id.** The writer uses
    `symbolId(v)`; the size path was fixed to match (`varintSize(symbolId(v))`) and has a
    regression test (`deltaDict.test.ts`, ids ≥ 128). Verify a frame carrying >127
    distinct symbols round-trips.
  - **B1b. Catch-up frame seq off-by-one (spec 6.6.1).** The mock advances its `seq`
    counter for **every** binary frame including the dict catch-up, but the client counts
    only ring frames via `ackTracker.onFrameSent()`. With a populated dictionary the
    catch-up frame occupies server seq 0, so the catch-up ACK can be misattributed to (and
    over-trim) the first ring frame. **Untestable in-process (empty dict ⇒ no catch-up
    frame); verify against a real QuestDB with a non-empty dictionary.**

---

## C. Smaller gaps / nits a reviewer flagged

- **C1. Ack watermark written on every ACK (spec 8.2 note 1).** `SfEngine.acknowledge`
  writes the whole 8 KiB `.ack-watermark` file per ACK via async `writeFile`. The spec
  says "must not write the watermark per ACK". Functional today (monotonic), but wasteful.
  Throttle to a cadence (e.g. align with the trim-quantum / `sf_sync_interval_millis`).
- **C2. `sf-manifest.bin` / `SFM1` not implemented (spec 8.2, 8.1.1).** Recovery validates
  the chain only by scanning `.sfa` files and checking contiguity in `SegmentRing.recovered`;
  there is no manifest to cross-check the chain head against. The plan did not include it;
  if you add it, keep the crash-safe alternating-generation scheme (offsets 0 / 4096).
- **C3. `request_durable_ack` is parsed but not wired.** `SenderOptions.request_durable_ack`
  is accepted, but no code path sets a durable-ack request. The transport only *handles*
  `STATUS.DURABLE_ACK` responses. If you advertise `request_durable_ack=on` (the README
  does), it must actually request durable ACKs.
- **C4. Eager-connect double-connect edge (carried from Plan 3 handoff).** In the `Sender`
  constructor, any `reconnect_*` key ⇒ derived `ConnectMode.SYNC` fires `this.connect()`
  fire-and-forget; a user who **also** calls `await sender.connect()` explicitly can
  double-connect. Untested. Reconcile in the connect-mode handling.

---

## Environment notes

- `pnpm <script>` gates fail (ignored-builds check). Use
  `./node_modules/.bin/{tsc,vitest,eslint,bunchee}` directly. `tsx` (a devDependency) is
  used for the crash-recovery child tests.
- Docker is unavailable in this shell; a **QuestDB 10.0.0** runs at `localhost:9000`
  (`QWP_TEST_ADDR=localhost:9000 ./node_modules/.bin/vitest run test/qwp/integration.test.ts`).
  The in-process `mockServer.ts` needs no Docker.
- **Trap reminders still applying** (`plans/README.md`): never zero a torn tail during the
  scan (8.1.5); recovery de-duplication of `.symbol-dict` (8.1.6); `seq` is connection-scoped,
  not an FSN (6.6.1); `421` retries forever / `401` terminal (6.5.1).
