# Handoff — C2 sf-manifest.bin / SFM1 done

**Supersedes:** `docs/superpowers/plans/HANDOFF-plan7.md`.

**Context:** Branch `feat/qwp-design`. This session completed **C2** — the
last deferred store-and-forward feature: the `sf-manifest.bin` / `SFM1` chain-head
manifest (spec 8.2, 8.1.1). A1 (orphan scan + background drainers) was already
done and remains green; nothing else from the earlier handoffs is
deferred — but see the OPEN spec-9.1 defaults gap below, found after this file
was first written.

Source of truth: `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`
(section numbers cited).

**This file is the head of the handoff chain** — `HANDOFF-plan4-deferred` through
`HANDOFF-plan7` are superseded history and now carry banners saying so. Their
"remaining work" lists describe gaps that later sessions closed; do not work from
them.

**The next substantial piece of work is Plan B**, `2026-08-08-qwp-plan-b-benchmarks.md`
(spec: `specs/2026-08-08-qwp-node-benchmarks-design.md`) — a self-contained 9-task
benchmark suite. With ingest, store-and-forward and the deferred items all closed,
it is the only planned work left, and it is a separate track rather than a fifth
rung of the four-plan stack. Its own trap list is in `plans/README.md`; the two
that bite hardest are that `/tmp` is usually tmpfs (so the SF "disk" numbers
measure RAM while a `dd` guard reports an excellent figure) and that vitest's `hz`
is callbacks per second, not rows per second.

**Green:** `tsc --noEmit` clean; `eslint src/` clean; QWP unit suite **178 passed /
0 skipped** (was 170 passed + 3 integration-skipped; this run adds 8 manifest
tests); live integration (`localhost:9000`, `QWP_TEST_ADDR`) 3/3. Full
non-integration project run 340 passed / 10 skipped; the only failure is
`test/sender.integration.test.ts` (TestContainers — Docker unavailable, a known
pre-existing environment limitation unrelated to this change).

---

## DONE this session — C2: sf-manifest.bin / SFM1 (spec 8.2, 8.1.1)

### New/changed modules
- **`src/qwp/sf/boundary.ts`** — generalized `writeBoundary`/`readBoundary` to
  take an optional `magic` (defaults to `AKW1_MAGIC`, so existing ack-watermark
  callers and tests are unchanged). Exported `AKW1_MAGIC`.
- **`src/qwp/sf/manifest.ts`** (new) — `writeManifest`/`readManifest` for
  `sf-manifest.bin`, magic `SFM1` (0x314d4653), version 1. Same
  alternating-generation scheme as `.ack-watermark`: 8 KiB file, two
  independently CRC-protected 64-byte records at offsets 0 / 4096, CRC stored
  last, recovery keeps the valid record with the greatest generation, falls back
  to no manifest if absent/corrupt. `MANIFEST_FILE_NAME`, `MANIFEST_FILE_SIZE`.
- **`src/qwp/sf/engine.ts`** —
  - recovery reads the manifest and cross-checks the scanned chain head against
    it; throws (→ owner `failQuarantined` / drainer `.failed` + `DATA_LOSS`)
    only on the **lost-tail** condition;
  - `openActiveFile` now sets **`MANIFEST_REQUIRED_FLAG` (flags bit 0)** on every
    segment it writes, and records the new chain head;
  - added `persistManifest(head)` writing the alternating record (fsynced in
    periodic durability, page-cache otherwise — consistent with the watermark).

### The lost-tail rule (why no false quarantines)
The manifest is written **after** the new segment's header exists, so a crash in
the middle of rotation can never leave the manifest *ahead* of a file that is
already on disk. On recovery:
- manifest **absent/corrupt** → no cross-check, permissive (old slots keep
  working after upgrade);
- manifest **equality or behind** the scanned head → benign (the write-order
  race a crash can produce) → accept, resume the generation;
- manifest **strictly ahead** of the scanned head, or present with **no** chain
  at all → a recorded tail segment (or the whole chain) vanished from disk =
  real data loss → throw → quarantine.
This is what makes the manifest genuinely load-bearing (it detects a missing tail
segment) while never set-aside-ing a recoverable slot.

### Tests added
- `test/qwp/sf/manifest.test.ts` (new, 4): SFM1 magic bytes (LE) + layout,
  alternating-slot fallback on a torn record, null on absent/corrupt.
- `test/qwp/sf/engine.test.ts` (+4): records chain head + re-opens consistently;
  advances head across a segment rotation; quarantines when the manifest head is
  ahead (lost tail — deletes the segment); sets `MANIFEST_REQUIRED_FLAG`.

Tooling note (from plan7): match the alternating-parity intent carefully when
testing — `slot = (generation % 2) * 4096`, so gen 1 lives at offset 4096, gen 2
at offset 0, not the reverse.

---

## REMAINING from the plan-4 deferred list — none (see the ledger below)

## OPEN — found after this handoff was written (spec 9.1 vs shipped)

**The mode-dependent `sf_max_total_bytes` default was never implemented.** Spec
9.1 specifies **128 MiB in memory mode, 10 GiB in disk mode**, and spec 8 leans on
`sf_dir`-presence driving memory-vs-disk defaults throughout. The shipped code has
only `MEMORY_MAX_TOTAL_BYTES = 128 * 1024 * 1024` (`transport.ts:24`) and applies
it unconditionally at `transport.ts:88`, regardless of `sf_dir`. `drainer.ts:41`
hardcodes the same 128 MiB. **There is no disk constant anywhere in the tree** —
`10 GiB` appears in no source file and no test.

*Consequence:* a disk-mode user who does not set `sf_max_total_bytes` explicitly
gets **~80× less retention than designed**. The ring reaches its cap 80× sooner
during an outage and begins shedding unacked frames (`DATA_LOSS`) — which is the
exact guarantee store-and-forward exists to provide, so the failure lands on the
feature's headline promise rather than an edge case.

*Not fixed here* (this review is document-only). The fix is a disk branch on
`sf_dir` presence at both construction sites plus a test pinning each default;
note that `segmentBytes` needs no such branch — spec 9.1 gives one value (4 MiB)
for both modes, so `MEMORY_SEGMENT_BYTES` is merely misnamed, not wrong.

### Poison-frame detection is not wired at all

`PoisonDetector` (`src/qwp/poison.ts`) is **never constructed anywhere in
`src/`** — `grep` finds it only in its own unit test. `HANDOFF-plan3-to-plan4`
said so plainly ("Both implemented and unit-tested; neither is yet wired into the
transport lifecycle"); the `Dispatcher` half of that warning *was* wired
(`transport.ts:94`, `:99`), the poison half never was, and it then dropped out of
handoffs 4-8 without ever being closed.

*Consequence:* the client has **no poison-frame escalation**. A frame that is
repeatedly rejected never escalates to quarantine, so the strikes-AND-dwell rule
the spec and every handoff trap list emphasise is inert in shipped code. Both
config keys that tune it — `max_frame_rejections` (spec default 4) and
`poison_min_escalation_window_millis` (5,000) — are accepted, validated, and then
**silently ignored**, which is worse than rejecting them.

`sf_append_deadline_millis` (spec default 30,000) is in the same state: accepted
and parsed, never read. A systematic sweep of all 38 accepted keys found exactly
these three QWP keys with no consumer outside `options.ts` (the other four —
`tls_roots`, `tls_roots_password`, `token_x`, `token_y` — are pre-existing
base-client keys, not QWP regressions).

### `MAX_ROWS_PER_TABLE` is declared but never enforced

`constants.ts:43` defines it at 1,000,000 and **nothing reads it**. Its three
neighbours are all enforced — `MAX_COLUMNS_PER_TABLE` and `MAX_NAME_LENGTH` in
`tableBuffer.ts`, `MAX_SYMBOL_DICTIONARY_SIZE` in `symbolDict.ts` — so this one
reads as an oversight rather than a decision.

*Reachability is narrow but the failure is wide.* With `auto_flush_rows`
defaulting to 1,000 nothing approaches the limit; it needs auto-flush raised or
disabled, or a long defer-commit transaction. If it is crossed, the server
rejects the frame — and under store-and-forward that frame is already durable, so
it replays forever. **Combined with the unwired `PoisonDetector` above, that is a
permanent stall with no escalation**: the two gaps compose into exactly the
failure the poison design exists to prevent.

*Fix with care.* The spec names it `DEFAULT_MAX_ROWS_PER_TABLE` (6.4) — a
server-side **default** an operator may raise, not a protocol invariant. So a
hardcoded client-side throw could reject frames a correctly configured server
would accept. Prefer failing the frame with a clear diagnostic, or drop the
constant rather than leaving a limit that looks enforced and is not.

### Three spec-9.1 keys are not accepted at all

`durable_ack_keepalive_interval_millis` (default 200, "≤ 0 disables"),
`auth_timeout_ms` (15,000) and `catch_up_cap_gap_min_escalation_window_millis`
(300,000) appear in spec 9.1 — the last one also in the spec's accepted-key list —
but are absent from `ValidConfigKeys` and absent from `src/` under any name. Setting
any of them **throws as an unknown option**. The keepalive is the one with teeth:
with `request_durable_ack=on` there is nothing to bound a durable-ack wait.

### Two more defaults disagree with spec 9.1

- **`max_background_drainers`** — `drainer.ts:287` defaults to **1**; spec 9.1 says
  **4**. Orphan slots drain 4× less concurrently than designed after a crash.
- **`auto_flush_interval`** — `sender.ts:129` falls back to the hardcoded
  `DEFAULT_AUTO_FLUSH_INTERVAL = 1000`; spec 9.1 says QWP's default is **100 ms**.
  Rows already delegate through `transport.getDefaultAutoFlushRows()`, but no
  matching `getDefaultAutoFlushInterval()` hook exists — which is precisely the
  change spec 9.1's own prose says "must be added". QWP users get a 10× slower
  flush cadence than specified.

**Closure ledger for items carried from `HANDOFF-plan4-deferred`.** Those items
stopped being mentioned once resolved, which leaves "fixed" indistinguishable
from "forgotten" without reading source. Each was re-verified against `src/` at
this commit:

| Item | Where it landed |
|---|---|
| **C1** watermark written per ACK | `SfEngine.acknowledge` now only sets `watermarkDirty`; the write is coalesced onto the barrier cadence (spec 8.2 consequence 1). |
| **C3** `request_durable_ack` parsed but not wired | reaches the wire via `drainer.ts` (`requestDurableAck`). |
| **C4** eager-connect double-connect | `QwpTransport.connect()` is idempotent — returns early on `this.ws`, otherwise joins the in-flight `connectPromise`, so the constructor's fire-and-forget attempt and an explicit `connect()` cannot open the engine twice. |
| **B1a** delta size vs write disagreeing on id | `varintSize(symbolId(v))`, with the ids ≥ 128 regression test in `deltaDict.test.ts`. |
| **B1b** catch-up frame seq off-by-one | `sendDictCatchUp()` returns its frame count and `acks.onConnected(ackedFsn + 1, catchUpFrames)` consumes it, so catch-up frames no longer shift ACK attribution onto the first ring frame. |

Everything deferred in earlier handoffs is done: A1 orphan scan + drainers (8.4),
the `.symbol-dict` read-quarantine hole, and C2 manifest. No further deferred work.

Housekeeping candidates (not required):
- `git add` + commit the manifest work (the feature branch has a long history of
  `feat(qwp): ...` single-purpose commits).
- The 8 KiB manifest file is written once per rotation; if a future plan
  implemented pre-created hot-spare segments (8.1.2) it could be folded into the
  spare-provisioning pass to keep it off the producer path, but this port has no
  hot spares today and rotation-time writes are already doing file I/O.

---

## Environment notes
- `pnpm <script>` gates fail (ignored-builds). Use
  `./node_modules/.bin/{tsc,vitest,eslint,bunchee}` directly.
- Docker is unavailable; a QuestDB 10.0.0 runs at `localhost:9000`
  (`QWP_TEST_ADDR=localhost:9000 ./node_modules/.bin/vitest run test/qwp/integration.test.ts`).
  `test/sender.integration.test.ts` (TestContainers) fails on this box regardless
  of these changes.
- **Trap reminders** (`plans/README.md`): never zero a torn tail during the scan
  (8.1.5); recovery de-duplication of `.symbol-dict` is forbidden (8.1.6);
  `seq` is connection-scoped, not an FSN (6.6.1); `421` retries forever / `401`
  terminal (6.5.1); periodic fsync has no Node directory-fsync analogue (8.2);
  delta baseline advances only after a frame is queued onto the ring (5.2);
  drainers must use `HostTracker.newCursor()` — never the shared round (1.2).
