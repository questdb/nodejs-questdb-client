# Handoff — Plan 1 (walking skeleton) done, for the agent executing Plan 2

**Read first:** `docs/superpowers/plans/README.md`, then `2026-08-07-qwp-plan-2-full-codec.md`.
The design spec wins over any plan text: `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`.

## State

- Branch `feat/qwp-design` at `f6582a4`. Plan 1 (PRs 1–3) fully implemented and committed (8 task commits). Full suite green: 206 passed; the Docker e2e was verified against a live QuestDB 10.0.0 and passes with `QWP_TEST_ADDR=localhost:9000`.
- New code under `src/qwp/`: `protocol/{varint,constants,tableBuffer,frameEncoder}.ts`, `ws/{mask,frame,handshake,socket}.ts`, `buffer.ts`, `transport.ts`. Wired into `src/{options,buffer/index,transport/index,index}.ts` (`WS`/`WSS`, protocol-first `createBuffer` branch, `QwpBuffer`/`QwpTransport` exports). Tests in `test/qwp/` (incl. a testcontainers e2e).

## Three corrections to the plan (verified against the real server / Java source) — carry forward

1. **Designated timestamp = EMPTY-name column (critical).** `at()` emits a column with **`nameLen=0`** and `TYPE_TIMESTAMP`; the server names it `timestamp` and designates it, and only auto-adds its own when none is present. Sending a column literally named `timestamp` collides → `Duplicate column [name=timestamp]`, no rows land. `QwpTableBuffer.getOrCreateColumn` allows an empty name only for `TYPE_TIMESTAMP`. The compiled plan for Plan 2's codec and any golden vectors must treat `nameLen=0` as the designated timestamp. Ground truth: `QwpSchema` / `QwpTudCache` in the local Java clone.
2. **Clients mask, servers unmask.** Client→server WS frames are masked; the client-side `FrameParser` correctly rejects masked frames. The e2e emulated server in `test/qwp/ws.socket.test.ts` was patched to decode masked client frames (a real server must unmask).
3. **`tls_verify` is a `boolean`** in `SenderOptions` (parsed `unsafe_off`→false), not a string — guard TLS as `!== false`.

## Environment notes

- **`pnpm <script>` gates fail** (ignored-builds check). Use `./node_modules/.bin/{tsc,vitest,eslint}` directly. Keep zero new runtime deps (`undici` is the only one).
- **Docker is unavailable in this shell;** a **QuestDB 10.0.0** is running at `localhost:9000`. The e2e test accepts `QWP_TEST_ADDR=host:port` to target an existing server; it skips when neither that nor Docker is available.
  ```bash
  QWP_TEST_ADDR=localhost:9000 ./node_modules/.bin/vitest run test/qwp/integration.test.ts
  ```
- `questdb-client-test` submodule needs `git submodule update --init` for the pre-existing interop buffer test (unrelated to QWP).
- Local Java clone for protocol ground-truth: `/home/nick/repos/questdb-enterprise-4/questdb` — server QWP codecs under `core/src/main/java/io/questdb/cutlass/qwp/`. **Version caution:** that checkout's `java-questdb-client` submodule is at **1.3.3-SNAPSHOT**, four behind the **1.3.7-SNAPSHOT** the design spec §2 pins (`~/claude/wt/oss/wal-pending-negative/java-questdb-client`, HEAD `8f5ed4f9`). Its *server-side* `cutlass/qwp` codecs were checked and are post-#7200 (no `schema_id`), so they are safe for protocol ground-truth — but read client-side behaviour from the pinned checkout, and check `core/pom.xml` before trusting either.

## Verified end-to-end

`ws://` ingest lands `["ETH-USD", 2615.54, 7, "2023-11-14T22:13:20.000000Z"]` — SYMBOL/DOUBLE/LONG and the designated TIMESTAMP all correct against real QuestDB.

## Plan 2 scope (from `2026-08-07-qwp-plan-2-full-codec.md`)

All remaining column types, symbol dictionary (full + delta), Gorilla timestamps, commit frame, cap-splitting. Re-read the ten traps in `README.md` (symbol dict deltas, Gorilla LSB-first bit-reversal per spec §6.3.2, decimal scale rescaling not rejecting, `seq`≠FSN, etc.) and lean on the Java source for any ambiguous wire byte.
