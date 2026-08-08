# Handoff — C2 sf-manifest.bin / SFM1 done

**Supersedes:** `docs/superpowers/plans/HANDOFF-plan7.md`.

**Context:** Branch `feat/qwp-design`. This session completed **C2** — the
last deferred store-and-forward feature: the `sf-manifest.bin` / `SFM1` chain-head
manifest (spec 8.2, 8.1.1). A1 (orphan scan + background drainers) was already
done and remains green; nothing else is deferred.

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

## REMAINING — none

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
