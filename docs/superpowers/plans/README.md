# QWP implementation plans — read this first

Four plans implement QWP ingest over `ws://` in this client. They are **strictly
sequential**: each consumes interfaces the previous one produced.

| Order | Plan | Spec PRs | Deliverable |
|---|---|---|---|
| 1 | `2026-08-07-qwp-plan-1-walking-skeleton.md` | 1–3 | `ws://` ingest works end-to-end, testcontainers-green |
| 2 | `2026-08-07-qwp-plan-2-full-codec.md` | 4–8 | All column types, symbol dictionary, Gorilla, commit frame, cap-splitting |
| 3 | `2026-08-07-qwp-plan-3-errors-and-failover.md` | 9–11 | Response decoding, error policy, poison detector, reconnect, multi-host |
| 4 | `2026-08-07-qwp-plan-4-store-and-forward.md` | 12–16 | Durable send log, replay, crash recovery, release 5.0.0 |

**Design spec:** `../specs/2026-08-07-qwp-nodejs-client-design.md`. Every plan
cites it by section number; when a plan and the spec disagree, the spec wins and
the plan should be corrected.

## Plan B — benchmarks (separate track)

`2026-08-08-qwp-plan-b-benchmarks.md`, spec
`../specs/2026-08-08-qwp-node-benchmarks-design.md`.

**Not** part of the sequence above. It runs *after* Plans 1–4 have shipped, adds
nothing to `src/`, and validates the implementation rather than extending it:
encoder throughput against hand-written floors, row-building overhead,
store-and-forward append cost, and end-to-end flush latency. Ad hoc — no CI job,
no gate.

It carries its own trap list, disjoint from the one below, because benchmarks
fail differently from protocol code: they produce a confident number instead of
an error. The three worst are **`/tmp` is usually tmpfs**, so a "disk" benchmark
silently measures RAM while its own `dd` guard reports an excellent figure;
**`hz` is callbacks per second, not rows per second**, understating throughput
by four orders of magnitude; and **an unconsumed result can be optimised away**,
which corrupts a floor comparison in whichever direction happens to win. See
that plan's own review log for the full set.

## Things that will bite, in order of likelihood

These are the traps the spec review surfaced. Each is a case where the *obvious*
implementation is the inverse of the correct one.

1. **Values are compacted.** A column payload carries only non-null values, not
   `rowCount` slots. Getting this wrong yields frames that are self-consistent in
   length but wrong in content — the server may accept them and land corrupt
   data rather than NACK (spec 6.2.1).
2. **`seq` is not an FSN.** The ACK sequence is connection-scoped and restarts at
   0 on every reconnect. Storing it as an FSN works until the first reconnect,
   then trims from near the start of the log (spec 6.6.1).
3. **Gorilla prefixes are bit-reversed.** Packing is LSB-first, so logical `'10'`
   is written as `0b01`. Getting it wrong produces plausible-but-wrong
   timestamps, not a decode failure (spec 6.3.2).
4. **The notification inbox drops the OLDEST.** Drop-newest is the intuitive
   bounded-queue policy and inverts the intent (spec 4.2).
5. **`421` retries forever, `401` never does.** Both are "the server refused the
   upgrade"; conflating them either spins on bad credentials or kills a sender
   during an ordinary failover (spec 6.5.1).
6. **Decimal scale rescales, it does not reject.** A lock-and-reject port rejects
   data Java accepts, order-dependently (spec 6.5.3).
7. **Poison escalation needs strikes AND dwell.** Count alone turns a brief
   outage into a producer-fatal terminal (spec 7.4).
8. **A `ws::` sender can silently fall back to ILP v1.** `createBuffer` must
   branch on protocol *before* `protocol_version` (spec 3.5).
9. **Size suffixes are 1024-based.** `auto_flush_bytes=64m` read by `parseInt` is
   64 bytes — a flush per row, silently (spec 9.1.1).
10. **Never zero a torn tail during the scan.** It can hold valid-CRC frames that
    are the only surviving copy (spec 8.1.5).

## Scope boundaries worth knowing before you start

- **No ingest-side compression.** `FLAG_ZSTD` is egress-only; the ingest encoder
  never sets it. Do not implement zstd, and the Node version-floor question does
  not arise (spec 9.3).
- **The ingest sender is zone-blind.** Endpoint selection ranks by host *state*
  only; zone tiers and `target=primary` belong to the query client (spec 1.2).
- **No query client, facade, or UDP sender** in any of these plans (spec 1.1).
