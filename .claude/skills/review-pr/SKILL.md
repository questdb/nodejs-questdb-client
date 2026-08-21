---
name: review-pr
description: Review a GitHub pull request or local Git range against @questdb/nodejs-client TypeScript ILP/QWP client coding standards
argument-hint: "[PR number or URL | --range=<base>..<head>] [--level=0..3]"
allowed-tools: Bash, Read, Grep, Glob, Agent
---

# Review a Node.js client pull request

**Usage:** `/review-pr [PR number or URL | --range=<base>..<head>] [--level=0..3]`

Review the PR or local range identified by the invocation arguments. When this skill
is run as `/skill:review-pr <args>`, the `<args>` are appended as a `User:` message;
treat that text as `$ARGUMENTS`. Parse exactly one review target: a PR number/URL,
or `--range=<base>..<head>`. The range head may be omitted (`--range=<base>..`) to
review the working tree, including uncommitted changes. If both targets are supplied,
stop and ask which was intended. If neither is supplied, ask for one.

Use `Bash` only for read-only `gh` and Git queries, plus repository validation
commands when evidence requires them. Use `Read`, `Grep`, `Glob`, and fresh-context
agents through the Agent tool. Do not edit the primary working tree, push, post
comments, or mutate the PR. Step 3b may create an isolated temporary worktree solely
to verify a regression test against reverted production hunks; remove it afterward.

## Review mindset

You are a senior QuestDB engineer performing a blocking code review.
`@questdb/nodejs-client` is mission-critical software: it serializes rows into the
QuestDB InfluxDB Line Protocol (ILP) over HTTP/HTTPS or TCP/TCPS, and into the QuestDB
Wire Protocol (QWP) over WebSocket or fire-and-forget UDP, with a browser build, an
egress query path, and a crash-safe Node store-and-forward journal. A bug can silently
corrupt bytes, drop or duplicate rows, abandon persisted data, leak credentials,
exhaust resources, or break supported Node.js and browser consumers.

**A review that blocks on everything blocks on nothing.** Every finding costs an
author and CI round-trip. Reserve blocking severity for defects with a real user
consequence, report other issues at the severity their evidence earns, and approve
when the gates pass. Zero findings is a successful outcome.

- **Assume nothing is correct until verified.** Read surrounding source and tests;
  do not review the diff in isolation.
- **Treat the diff as the entry point, not the boundary.** Contract changes often
  break unchanged callers, overrides, transports, protocol versions, or generated
  type consumers.
- **Discovery is not a finding.** Every concern, including agent output, is an
  untrusted hypothesis until it passes Step 3b. Omit anything unproved.
- **Falsify before explaining.** Search for guards, validation, retries, alternate
  callers, unsupported configurations, and identical base behavior before building
  a failure narrative. Failure to disprove is not proof.
- **Keep the PR blast radius small.** The PR owns defects it introduces or exposes.
  Pre-existing behavior that is unchanged from base does not block it; a fully proved
  pre-existing bug may leave as an adjacent issue draft.
- **Do not praise the code.** Focus on defects, risks, and missing evidence.
- **Think adversarially.** Exercise `null`/`undefined`, empty strings and arrays,
  `NaN`/`Infinity`, imprecise `number` integers, `bigint`, multi-byte UTF-8, all ILP
  delimiters, maximum buffer sizes, retries after uncertain sends, connection drops,
  TLS/auth failures, and every negotiated protocol version. For QWP also exercise
  mid-frame socket loss, replay after a restart, a NACK of an already replayed frame,
  a full or externally locked journal directory, a role-rejected or capability-gapped
  endpoint, and a truncated or hostile server frame.
- **Store-and-forward promises no data loss.** Once rows enter the journal, only a
  rejection that is deterministic under byte-identical replay may abandon them, and a
  transient outage must never end the replay loop or surface to the producer. Treat a
  breach of the store-and-forward checklist as Critical.
- **Demand efficient hot paths.** Per-row and per-cell work scales to millions of
  rows. Avoid allocations, repeated scans, redundant conversions, extra buffer copies,
  and suboptimal algorithms there. Bounded setup/configuration work is less severe.
- **Check what is missing.** Look for absent error handling, cleanup, tests, public
  exports, TSDoc, README changes, deprecation wiring, and cross-transport parity.
- **Untested behavior is a coverage risk, not proof of a defect.** A missing test is
  Critical only when a supported, reachable regression could cause material user harm
  and existing safeguards do not contain it.
- **Verify every PR claim.** Reproduce fixes where practical, check performance claims
  against the actual multiplier, and treat the PR description as a hypothesis.
- **Assess reachability before reporting.** Drop theoretical paths that callers,
  validation, configuration, or buffer bounds make impossible.
- **Never review generated artifacts as source.** `dist/cjs/**`, `dist/es/**`, and
  `docs/**` are generated. Review their `src/**/*.ts` or documentation source instead.

## Review level

Parse `$ARGUMENTS` for `--level=N`, `-lN`, or a bare digit `0`-`3`. Default to
level 0. Strip the level token and any `--range=` token before passing a PR target
to `gh`.

| Level | What runs |
|-------|-----------|
| **0 (default)** | Steps 1, 2, 2.4, 2.5f, 2.6, and 4. Review inline without agent fanout. Build a compact coverage map and apply the Step 3b admission gate inline from a blank evidence form. |
| **1** | Add Steps 2.5a and 2.5e when tests change. Run Agent 1 plus at most two applicable roles from Agents 2-7, 9-13, and 14-15. Independently falsify each surviving atomic candidate. |
| **2** | Run all of Step 2.5, restricting 2.5b to exported/public/protected symbols, transport interfaces, shared helpers, and configuration options. Run Agent 1 plus at most four change-relevant roles. Independently falsify each surviving candidate. |
| **3** | Run the full workflow. Select at most six applicable discovery roles: Agent 1 always; Agent 8 when changed symbols have out-of-diff callers; Agents 2-7 and 14-15 when their domains are touched; Agents 9-13 for changed tests or a fix claim; Agent 10 only when a distinct adversarial pass is warranted. Depth comes from evidence, not agent count. |

State the selected level at the start of the review. If defaulted, mention that level
3 exists for a full mission-critical pass. Changes to `src/buffer/**`, `src/_qwp/**`,
`src/qwp-node/**`, transport/auth/TLS, protocol negotiation, flush semantics, or any
public entry point (`src/index.ts`, `src/qwp/index.ts`, `src/qwp/node.ts`,
`src/qwp/browser.ts`) are high risk; recommend level 3, but honor an explicit lower
level and state the limitation. Replay-journal, ack-watermark, drainer, and failover
changes stay high risk regardless of how small the diff is.

## Spawning review agents

Steps 3 and 3b use fresh-context, read-only Agent tasks. Discovery tasks receive the
diff, Step 2.4 gitlink verdicts, the Step 2.5 surface map, the Step 2.6 coverage map,
the chosen role, and the candidate contract. Agents 10 and Step 3b falsifiers are
deliberate reduced-context exceptions.

Use a shared temporary artifact for large maps instead of pasting them into every
prompt. Never pass a discovery narrative, proposed severity/fix, votes, or verification
claims to a falsifier. The parent owns role selection, the private candidate ledger,
admission, severity, deduplication, and the final report.

## Step 1: Gather review context

Every mode must end with `$BASE` and `$HEAD` identified. Behavioral findings require
the same trigger at both revisions unless the surface is genuinely new.

### GitHub PR

```bash
PR='<PR number or URL after removing the level token>'
gh pr view "$PR" --json number,title,body,labels,state,baseRefOid,headRefOid
gh pr diff "$PR"
gh pr view "$PR" --comments
BASE=$(gh pr view "$PR" --json baseRefOid --jq .baseRefOid)
HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
```

Also inspect the commit subjects with a read-only query when available. Do not check
out the PR into the primary working tree merely to review it.

### Local range (`--range`)

```bash
BASE='<base from --range>'
HEAD='<head from --range, or empty for the working tree>'
git diff "$BASE"${HEAD:+"...$HEAD"} --stat
git diff "$BASE"${HEAD:+"...$HEAD"}
git diff "$BASE"${HEAD:+"...$HEAD"} --name-only
git status --porcelain
```

With an empty head, include staged and unstaged tracked changes. `git diff` omits
untracked files, so read any untracked source/test files that belong to the change.
In range mode skip Step 2 because there is no PR metadata, state that fact, and run
all other selected steps normally.

## Step 2: PR title and description

Skip this step in range mode.

Check the repository conventions in `CONTRIBUTING.md` and recent accepted PRs:

- Title follows Conventional Commits: `type(scope): description`.
- Description explains end-user impact, not only implementation details.
- A bug fix links or closes its issue.
- Tone is analytical and avoids superlatives.
- Public API, option/default, export, or compatibility changes are explicit.
- README/TSDoc updates accompany user-visible behavior where needed.
- New or renamed options document their defaults and deprecation path through
  `SenderOptions.resolveDeprecated`.
- New or renamed QWP keys are wired through `src/qwp-node/client-config.ts`, validated
  against the transports that support them, and documented in `QWP.md`.
- A changed public QWP surface updates `test/qwp/public-api-contract.ts`.

## Step 2.4: Submodule boundaries (mandatory at every level)

Treat submodule gitlink changes as opaque. Detect mode `160000` pointer moves, record
the path and old/new hashes, and classify each as exactly:

```bash
git diff --raw "$BASE"${HEAD:+"...$HEAD"} | awk '$1 ~ /^:160000/ || $2 == "160000"'
```

- **OPAQUE** — the superproject changes only the gitlink. Do not enter the submodule,
  fetch its branches, expand the commit range, inspect its files, attribute upstream
  behavior changes to this PR, or report findings from its contents. Assume the
  referenced changes were already merged and reviewed upstream.

Review submodule contents only when the user explicitly requests that as an independent
task. A genuine integration defect remains in scope only when code in the superproject
diff calls or configures the bumped submodule incorrectly; file the finding at that
superproject callsite and do not use an expanded submodule range as evidence.

Repeat each `OPAQUE` verdict in Step 4 so the scope decision is auditable. If no
gitlinks changed, state `Submodules: none` in the summary.

## Step 2.5: Map the change surface

Use `rg` and `rg --files` (or Grep/Glob equivalents) rather than reasoning about
callers from memory. The resulting map is input to every normal Step 3 agent.

### 2.5a Semantic delta per changed symbol

For every modified or added function, method, class, abstract/protected member,
exported type/constant, interface, and configuration option, record:

- **Symbol:** fully qualified name.
- **Before:** signature, sync/async return shape, thrown errors and inputs, state
  mutation (`hasTable`, `hasSymbols`, `hasColumns`, `position`, `endOfLastRow`),
  allocation behavior, protocol versions, and exact wire bytes where applicable.
- **After:** the same fields.
- **Delta:** the concrete behavioral difference. Use `no behavioral change` only
  after checking; words such as “refactored” or “simplified” are insufficient.

### 2.5b Callsite inventory

For every changed exported/public/protected symbol, base-class member, shared helper,
transport-interface method, or option name, search all source, tests, README/examples,
and exports. Group results by file and include overrides and implementations.

At minimum check:

- All four public entry points — `src/index.ts`, `src/qwp/index.ts`, `src/qwp/node.ts`,
  `src/qwp/browser.ts` — and emitted public type implications.
- `SenderBufferBase` plus `SenderBufferV1`/`V2`/`V3` overrides and `createBuffer`.
- `SenderTransport` plus Undici, stdlib HTTP, and TCP implementations.
- `SenderOptions.resolveAuto`, `resolveDeprecated`, config parsing, `fromConfig`, and
  `fromEnv` for option changes, plus `src/qwp-node/client-config.ts` for QWP keys.
- Changed `src/_qwp/_core/**` constants and codecs against both the ingress encoder and
  the egress decoder; one cap or type byte is normally read by both sides.
- `QwpSender` and the writer helpers, `QwpIngressSession`, `QwpEgressSession`,
  `QwpClient`, the reconnecting connections in `src/_qwp/_internal/**`, and the UDP
  sender.
- `QwpNodeFileReplayStore`, `QwpNodeOrphanDrainer`, the advisory lock, and the segment
  maintenance worker for any store-and-forward change.
- Unit/integration tests and test helpers, including `test/qwp/**` and its fixtures.
- `test/qwp/public-api-contract.ts` for any exported QWP symbol, type, or option.
- `README.md`, `QWP.md`, and examples for public symbols/options.

A changed shared symbol with no recorded `rg` command is a skill violation. Never
assert “only used here” without the search trace.

### 2.5c Implicit contract list

For each changed symbol, record before versus after for every applicable contract:

- Inputs that throw synchronously and which callers catch or propagate.
- `null`/`undefined`: accept, reject, or omit. `strictNullChecks` is off, so validate
  runtime behavior rather than trusting the signature.
- Buffer capacity: bytes reserved by `checkCapacity(data, base)` versus bytes emitted.
- Row state: reads/transitions of `hasTable`, `hasSymbols`, `hasColumns`, `position`,
  and `endOfLastRow`, including empty-row closure.
- Sync/async shape and whether every caller awaits it.
- ILP bytes: separators, escaping, marker bytes, byte order, arrays, timestamp units,
  decimal payloads, and protocol-version applicability.
- Transport lifecycle, retry/idempotency, auto-flush behavior, auth, TLS, and cleanup.
- Number precision: `number` versus `bigint`, especially LONG and nanosecond values.
- Configuration name/default/validation/deprecation behavior.
- Allocation and complexity on setup, per-row, and per-cell paths.

### 2.5d Cross-context exposure list

List places where the change is visible but the diff does not touch, grouped by:

- Per-row/per-cell buffer-build hot path.
- Protocol-version fanout (ILP v1/v2/v3, and the QWP frame version with its negotiated
  caps and capabilities).
- Transport fanout (Undici, stdlib HTTP, TCP/TCPS, QWP WebSocket ingress, QWP egress,
  Node UDP).
- Runtime fanout (Node entry points versus the browser build, which must stay free of
  Node built-ins, `ws`, and `qwp-node` imports).
- Flush, commit, retry, replay, and lazy auto-flush paths.
- Reconnect, failover, role/capability rejection, and poison-frame escalation.
- Store-and-forward journal, orphan drainer, advisory locking, and the maintenance
  worker thread.
- Protocol negotiation, durable-ACK capability negotiation, and configuration parsing.
- Auth/TLS and resource lifecycle.
- Worker-thread use (one mutable `Sender` per worker) and multi-process use of a single
  store-and-forward directory.
- Public ESM/CJS/type surface across all four entry points.
- Tests, helpers, README, `QWP.md`, and examples.

Every listed context must be checked in Step 3.

### 2.5e Test surface and helper inventory

Run when tests are added or changed. Use repository searches to record:

- Existing setup/teardown, fixtures, mock HTTP/proxy helpers, buffer hex helpers,
  custom matchers, and parameterized-test patterns the change could reuse.
- Callers of any changed shared test helper or fixture.
- The production symbols each changed test actually exercises.
- Whether the assertion observes public behavior, exact wire bytes, transport calls,
  resource cleanup, or only implementation details.

### 2.5f Build and runtime profile (mandatory at every level)

Record current facts with file/line citations; do not rely on this list becoming stale:

- TypeScript flags from `tsconfig.json`, especially `strictNullChecks`,
  `noImplicitAny`, and `noUncheckedIndexedAccess`.
- Node.js version floor and `@types/node` version.
- Runtime dependencies and what each covers: `undici` (HTTP), `ws` (Node QWP
  WebSocket), and the native `fs-ext-extra-prebuilt` advisory locks used by
  store-and-forward. That last one is an `optionalDependency` that `advisory-lock.ts`
  reaches through a lazy `import()`; a static top-level import would restore an eager
  native load for every ILP consumer. bunchee externalizes only `dependencies` and
  `peerDependencies`, so `--external fs-ext-extra-prebuilt` in the `build` script is
  load-bearing — without it the module is inlined and its native binary lookup
  breaks at runtime. `fzstd` is a devDependency that the bundler inlines; making it an
  external import would break installs.
- Dual ESM/CJS build and every `package.json` exports subpath (`.`, `./qwp`,
  `./qwp/browser`, `./qwp/node`), plus which sources each subpath is allowed to import.
- ILP protocol default/negotiation and TCP's explicit-version requirement.
- QWP `QWP_VERSION`, the `/write/v4` ingress and `/read/v1` egress routes, the caps in
  `src/_qwp/_core/constants.ts`, and the capabilities negotiated per connection.
- `worker_threads` use by the segment maintenance worker, and the `Date.now()` /
  `Math.random()` dependencies in backoff, episode, and timeout accounting that
  deterministic tests must be able to control.
- `Buffer.write` versus `writeInt*` boundary semantics. A short `Buffer.write` can
  silently truncate, while numeric writes throw out of bounds; `writeInt8` requires
  `-128..127` and marker bytes above 127 must be sign-folded.

Put the relevant facts at the top of normal Step 3 prompts. Agent 10 receives only
the reduced context defined below.

## Step 2.6: Test coverage map (mandatory at every level)

For every production behavioral change, including each new branch/error/NULL/boundary
path, build an internal row containing:

- **Change:** symbol and exact behavior/path.
- **Test:** exact test file and name found through recorded `rg`/`rg --files` searches.
- **Failure link:** assertion and why it fails if the behavior regresses.
- **Reachability/population:** supported API/configuration/event and affected users.
- **Credible consequence:** concrete recurrence and observed harm.
- **Change risk:** complexity, caller breadth, state/resource sensitivity, safeguards.
- **Stable test design:** least invasive meaningful unit/integration/fault-injection
  assertion and observation seam.
- **Effort/fragility evidence:** concrete setup, nondeterminism, platform, or production
  seam costs; “hard to test” alone is not evidence.
- **Dimensions:** applicable protocol, transport, runtime (Node/browser), happy/error,
  NULL, boundary, concurrency, retry, reconnect/replay, crash-recovery, and
  resource-cleanup dimensions.
- **Disposition:** `COVERED`, `CRITICAL GAP`, `MODERATE GAP`, `ACCEPTED GAP`, or `EXEMPT`.

Mark rows with no effective assertion `UNTESTED` before classification. Missing tests
alone never establish Critical severity:

- **Critical gap:** a supported reachable regression can cause data loss/corruption,
  a security failure, outage/hang, compatibility break, unbounded resource loss, or
  similarly material harm; safeguards do not contain it; Step 3b admits it.
- **Moderate gap:** meaningful but bounded exposure, including most bug fixes without
  an effective regression test.
- **Accepted gap:** localized low-risk behavior where a stable test is demonstrably
  disproportionate or more fragile than the code and existing safeguards are strong.
- **Exempt:** verified non-behavioral source, documentation, generated-output, or CI
  changes.

Publish only admitted gaps. Keep covered, accepted, exempt, and omitted rows private
unless the user asks for the complete map.

## Step 3: Change-specific candidate discovery

Use fresh-context, read-only Agent tasks. Select only roles materially touched by the
change and obey the review-level cap. Agent count is never evidence.

Every normal discovery task receives the diff, change-surface map, coverage map, and
these candidate rules:

- Generate atomic, falsifiable hypotheses; do not assign severity, propose fixes,
  write persuasive titles, or claim verification.
- Cite the exact changed hunk or unchanged callsite contract allegedly broken.
- Name the supported-state producer: exact public API call, option, protocol, server
  response, runtime, or event that creates every trigger. Use `producer: unknown`
  rather than inventing one.
- Give reachability, head observation, same-trigger base observation, user symptom,
  evidence commands/artifacts, and strongest counterevidence. Mark unchecked fields
  `unknown`.
- Universal claims such as “never”, “only”, “no retry”, or “all transports” require
  an exhaustive caller/event-source inventory.
- Do not split supporting mechanisms into findings without independent consequences.
- Pre-existing unchanged behavior is not a PR finding. Fully proved pre-existing bugs
  may be proposed as adjacent issues only after Step 3b.
- Returning no candidate is valid and preferred to speculation.

### Agent roles

**Agent 1 — Correctness and ILP semantics:** Check nullish omission, separators,
escaping, input validation, integer precision, timestamp conversion, float edge cases,
array shape/type/emptiness, decimal encoding, error paths, and exact v1/v2/v3 wire
behavior. Check every changed symbol against its callers and overrides.

**Agent 2 — Buffer and byte-encoding safety:** Reconstruct bytes and capacity math.
Check every write against `checkCapacity`, UTF-8/escaping expansion, signed marker
bytes, little-endian numeric/dimension encoding, `position`, overlapping compaction,
resize/max-size behavior, `toBufferView` aliasing, `toBufferNew` mutation, and decimal
two's-complement bounds.

**Agent 3 — Transport, negotiation, auth, and TLS:** Check serializer negotiation,
TCP explicit versions, retry classification/idempotency, Undici/stdlib parity, Basic/
Bearer/JWK credentials, secret exposure, TLS verification/custom roots, timeouts, and
connect/send/close behavior.

**Agent 4 — Async, concurrency, and flush semantics:** Check every Promise/`await`,
ordering across `at`/`atNow`/`tryFlush`/`flush`, row loss after `toBufferNew` compaction,
uncertain-send duplication, lazy interval/row-count auto-flush, and unsafe sharing or
interleaving of mutable Sender state.

**Agent 5 — Resource management and lifecycle:** Trace sockets, Undici pools/agents,
user-supplied versus owned agents, timers, abort controllers, listeners, and buffer
views on success, failure, and early return. Verify failed connect/send/TLS paths close
or preserve ownership correctly.

**Agent 6 — Performance and algorithmic optimality:** For each loop, scan, allocation,
copy, conversion, and data structure, state complexity and the best feasible approach.
Focus on per-row/per-cell `toString`, string concatenation, repeated `Buffer.byteLength`,
per-character writes, resize copying, large arrays, and avoidable buffer copies. Every
candidate must state its multiplier or fixed bound and whether users wait on the path.

**Agent 7 — Public API, compatibility, and code quality:** Check `src/index.ts`, ESM/
CJS exports, `.d.ts` implications, TSDoc, option defaults/deprecations, supported Node
APIs, README/examples, unsound casts, dead code/imports, ESLint, Prettier, naming, and
member ordering. Separate compatibility defects from cosmetics.

**Agent 8 — Cross-context caller impact:** Walk every 2.5b callsite with callers up to
two levels. For each, return `SAFE`, `CANDIDATE`, or `INSUFFICIENT_EVIDENCE` and state
whether the new contract breaks valid inputs, row state, bytes, sync/async shape,
protocol subclasses, transports, config readers, error/retry paths, or worker contexts.

**Agent 9 — Test coverage:** Recheck every Step 2.6 test and failure link, add missed
behavior rows, and mutation-spot-check the most dangerous changed conditions. Check
the matrix of protocols, transports, auth/TLS, auto-flush, resize, escaping, nullish
values, arrays, precision, timestamps, retry/error, and resource cleanup.

**Agent 10 — Fresh-context adversarial:** Receive only the diff and changed filenames.
Instruction: “Generate a small set of falsifiable ways this code could be wrong and
try to disprove each before returning it.” It may inspect the repository but receives
no surface map, checklists, prior candidates, severities, or fixes.

**Agent 11 — Test efficacy and correctness:** Trace each changed test from production
symbol to assertion. Find vacuous assertions, tests that do not reach the changed path,
wrong/stale expected wire bytes, happy-path-only coverage, swallowed asynchronous
assertion failures, timing-dependent synchronization, and cleanup failures.

**Agent 12 — Test-code quality:** Search the 2.5e inventory before flagging duplicated
setup or helpers. Check parameterization opportunities, misleading names, copy/paste
residue, debug output, commented code, unjustified skipped tests, brittle implementation
assertions, and unnecessary casts. Name a real reusable alternative for each complaint.

**Agent 13 — Regression-test efficacy:** For a bug-fix claim, identify which production
hunk each test depends on. A candidate survives only if the test passes at head and
fails when the production fix is reverted in an isolated scratch worktree.

**Agent 14 — QWP wire format and protocol sessions:** Reconstruct frame headers,
LEB128 varints, column encodings, Gorilla bit packing, zstd framing, symbol-dictionary
IDs with their delta/reset flags, decimal scale, geohash bits, array shape, and NULL
bitmaps against the caps in `src/_qwp/_core/constants.ts`. Check the ingress encoder and
the egress decoder together because both read the same constants. Check status-byte to
category to policy mapping, per-table transaction grouping, durable-ACK negotiation,
ingress cap splitting, and that a truncated, oversized, or hostile server frame is
rejected before it is allocated, copied, or trusted.

**Agent 15 — Store-and-forward, replay, and failover:** Verify the durability contract
in the checklist below. Trace the cumulative ack watermark, replay from
`ackedFsn + 1`, segment format and checkpoints, append backpressure and deadlines,
cross-process advisory locking, orphan-slot quarantine, poison-frame strike accounting,
capability-gap episodes, reconnect budgets, and endpoint health/zone ranking. Any path
that abandons accepted rows, advances the watermark past an unacknowledged frame, or
ends the steady-state replay loop on a transient failure is a data-loss candidate.

Combine outputs into a private candidate ledger. Split compound narratives into atomic
propositions, deduplicate by proposition plus evidence, and record dependencies. Do not
draft severity, fixes, or report prose yet.

## Step 3b: Independently falsify, prove, and admit candidates

Use this state machine without shortcuts:

`HYPOTHESIS → FALSIFYING → PROVEN → ADMITTED`

Missing proof, unresolved contradiction, failed reproduction, unsupported producer,
or dependency on an omitted premise ends at `OMITTED`. “Could not disprove” is not
`PROVEN`, and there is no public downgraded/false-positive section.

At levels 1-3, launch one fresh-context falsifier per atomic candidate. Give it only:

1. The neutral proposition.
2. Repository plus base/head identities (or captured working-tree diff hash) and
   relevant filenames.
3. Raw evidence/artifact paths.

Do not send the discovery narrative, severity, fix, author identity, votes, or claims
that anyone verified it. At level 0, apply the same protocol inline from a blank form.

The falsifier first constructs the strongest disproof: missing producer, unsupported
configuration, impossible version pairing, omitted caller, retry, guard, validation,
cleanup, downstream containment, or identical/better base behavior. Only a surviving
candidate receives affirmative proof.

Admit a behavioral candidate only when every applicable field has cited evidence:

- **Attribution:** changed hunk, or unchanged callsite plus changed contract.
- **Supported-state producer:** exact supported API/config/protocol/runtime/event.
- **Reachability:** complete producer-to-symptom path, including guards, retries,
  dispatch, ownership, and cleanup.
- **Head observation:** executed trigger and observed result at the reviewed revision.
- **Base observation:** identical trigger/result at `$BASE`, or `N/A — genuinely new
  surface` with proof.
- **User symptom:** independently observable consequence.
- **Counterevidence search:** strongest disproof and why it does not apply.
- **Artifact:** command/test, output, environment/configuration, and revision identity.

Runtime-shape, race, ordering, retry, restart, resource-lifetime, compatibility, and
wire-format claims require executed artifacts; static reading alone cannot admit them.
For fully static compile errors or standards violations, mark runtime-only fields
`N/A — static` and cite the complete source proof. Coverage searches prove absence of
a test, not the reachability or impact needed for a Critical gap.

Apply these special burdens:

- Universal negatives require an exhaustive inventory and executed probe.
- Concurrency/order candidates must force or observe the interleaving.
- Regression-test candidates must run green at head and red with the production fix
  reverted in a scratch worktree, never the primary working tree.
- If execution is impossible, record the limitation privately and omit the behavioral
  candidate rather than replacing evidence with confident prose.
- If a parent premise is omitted, omit every dependent candidate.

Then independently verify Node-client specifics:

1. Read exact source lines in `src/**/*.ts`, not generated output, and trace callers,
   interfaces, factories, and v1/v2/v3 overrides.
2. Count every emitted byte against capacity, including escaped multi-byte UTF-8,
   separators, suffixes, marker bytes, dimension headers, and decimal payloads.
3. Reconstruct expected wire bytes and compare them with both production output and
   byte-level test expectations.
4. Validate nullish behavior at runtime because TypeScript nullability may be disabled.
5. Trace `toBufferNew`/compaction relative to awaited sends for loss/duplication claims.
6. Trace retry classes and whether the server could have durably accepted an uncertain
   send before replay.
7. Trace every socket, agent, timer, abort controller, listener, and buffer view through
   success/error/early return; never destroy a user-supplied agent.
8. For performance, prove complexity, hot/cold placement, call frequency, multiplier
   or fixed bound, and a materially better feasible implementation.
9. For public API/config claims, check every export, parser, default, deprecation path,
   README example, ESM/CJS output implication, and supported Node version.
10. For test efficacy, prove the assertion reaches the change and would fail under the
    claimed regression. Recompute expected hex/bytes rather than trusting fixtures.
11. For QWP wire claims, reconstruct the frame bytes for encode and decode, and check
    every length, cap, and flag against `src/_qwp/_core/constants.ts` rather than against
    an assumed peer behavior.
12. For replay, ack, reconnect, or failover claims, trace the cumulative ack watermark
    and prove which frames a restart, NACK, or non-orderly close resends or drops.
    Classify the failure through `qwpDefaultSenderErrorPolicy` before calling anything
    terminal.
13. For store-and-forward claims, execute against a real directory: fill it, hold its
    lock from a second process, truncate or corrupt a segment, and kill the process
    between append and checkpoint. Durability and crash-recovery claims need journal
    artifacts, never source reading alone.
14. Derive a fix only after admission, then verify it compiles and closes all admitted
    paths without creating a compatibility, ownership, or retry defect.

### Net user impact and ledger classification

Before assigning severity, answer in order:

- **Population:** named supported API/config/protocol/runtime population.
- **Delta vs base:** observed difference for the identical trigger.
- **Magnitude/frequency:** per cell, row, flush, request, Sender lifetime, or once.
- **Offsets:** validation, retry, server rejection, type/build gate, operational process,
  or other containment before the user sees harm.
- **Net:** `net-negative`, `net-neutral`, or `net-positive`. Only net-negative behavioral
  candidates may be findings.

Classify ledger entries as:

- **ADMITTED in-diff** — proved defect inside the diff.
- **ADMITTED out-of-diff-breakage** — proved unchanged caller broken by this PR's
  changed contract.
- **OMITTED pre-existing/not-attributed** — same or worse behavior exists at base and
  this PR does not expose a new path.
- **OMITTED false** — counterevidence disproves it.
- **OMITTED unverified** — required producer, path, observation, artifact, or dependency
  is missing.

Keep omitted candidates and disproofs private. A fully proved pre-existing bug may
become an adjacent issue draft; false or unverified candidates never do. Verify every
enumerated instance independently rather than sampling and generalizing.

## Review checklists

### Correctness and wire format

- Nullish omission must not emit a separator or leave invalid row state.
- `number` LONG values beyond `2^53` lose precision; nanosecond timestamps require
  `bigint`; v1 timestamps use microseconds while v2+ preserve nanoseconds.
- Reject or intentionally encode `NaN`, `Infinity`, invalid units, invalid types, and
  unsupported protocol features.
- Verify table/symbol/column escaping for space, comma, equals, newline, carriage
  return, quote, backslash, and multi-byte UTF-8.
- Validate irregular/non-homogeneous/empty arrays and v2 dimension/type bytes.
- Verify v3 decimal sign, scale, length, two's complement, and big-endian payload.

### Buffer and byte safety

- Every write has capacity for actual escaped UTF-8 bytes and suffix/marker bytes.
- `writeInt8` values stay in `-128..127`; sign-fold unsigned marker bytes.
- Doubles, int32 values, and dimensions use correct little-endian width/order.
- Do not retain `toBufferView` across mutation; account for `toBufferNew` compaction.
- Verify overlapping compact copies, growth termination, `max_buf_size`, and exact
  `position` advancement.

### Transport, protocol, auth, and TLS

- Negotiated serializer matches the server; TCP requires an explicit version.
- Retriable classification, backoff, and time budgets are correct; uncertain replay
  cannot silently duplicate accepted rows.
- Undici and stdlib HTTP agree on auth, TLS, timeout, retry, and response handling.
- Basic/Bearer/JWK credentials are correct and never logged or included in errors.
- Verification is disabled only explicitly; custom CA/roots are applied.
- QWP endpoint selection honors the health and zone ranking; a background drainer
  publishes health observations but never resets foreground classifications.
- Upgrade failures are classified into a `QwpUpgradeError` kind, and a browser's opaque
  upgrade error is never reported as a specific cause.
- WebSocket close codes carry no policy meaning; classify by status byte and upgrade
  kind instead.

### QWP wire format and sessions

- Frame header magic, version, flags, table count, and payload length agree between
  encoder and decoder, and every cap in `src/_qwp/_core/constants.ts` is enforced on both
  sides.
- Varints stay inside uint64; row, column, name-length, array-element, and dictionary
  limits are checked on encode and on decode.
- Symbol dictionary IDs stay dense and connection-scoped; delta and reset flags match
  what the peer reconstructs, and a `DICTIONARY_GAP` rejection triggers catch-up rather
  than a terminal failure.
- Gorilla, zstd, and raw encodings round-trip; decompression respects
  `QWP_MAX_ZSTD_DECOMPRESSED_SIZE`, and every server-supplied length is validated before
  it is allocated or copied.
- Decimal scale, geohash bits, long256 words, UUID, IPv4, binary, and array shape
  validation match the documented bounds for each column and bind type.
- Server-supplied text decodes as fatal UTF-8 into a `QwpProtocolError`, never into a
  silently mangled value.
- Transactions are atomic per table, not across a flush; closing publishes staged rows
  without committing them.
- Durable ACK is requested through the Node upgrade header or the browser subprotocol,
  and an unconfirmed capability fails with `QwpDurableAckUnavailableError`.
- Ingress splitting respects the negotiated cap, and a single row above the cap fails
  with `QwpBatchTooLargeError` instead of being dropped.
- The browser entry point stays free of Node built-ins, `ws`, and `qwp-node` symbols.

### Store-and-forward and durability

A breach here is Critical: the contract is that a running producer neither loses data
nor hard-fails on a transient outage.

- The steady-state replay loop does not surface transport or server errors to the
  producer. Journal exhaustion and its append deadline are the errors a caller may see.
- Node foreground replay is unbounded after startup. Attempt and duration budgets apply
  to `"sync"` startup and to the browser/memory policy only; a budget that latches a
  running sender terminal during a long outage is a data-loss defect.
- Backoff is exponential with full jitter and a capped per-attempt delay, while the
  store-and-forward retry loop itself stays uncapped.
- NACK policy follows `qwpDefaultSenderErrorPolicy`: `WRITE_ERROR`, `INTERNAL_ERROR`,
  `DICTIONARY_GAP`, and an unknown status retry from `ackedFsn + 1`; `NOT_WRITABLE`
  retries elsewhere; only rejections that are deterministic under byte-identical replay
  go terminal. An unrecognized status byte fails open to retry, never closed.
- The ack watermark never advances past a NACKed or unacknowledged frame, and abandoned
  bytes are quarantined and reported through `QwpSenderError` rather than dropped.
- Repeated rejection escalates through the poison-frame detector, honoring
  `maxFrameRejections` and `poisonMinEscalationWindowMs`. Normal and going-away closes,
  `NOT_WRITABLE`, and dictionary catch-up must not consume strikes, and a transient
  class must not consume a capability-gap episode budget.
- Orphan-drainer terminals are the ones that are terminal by design — authentication,
  protocol, poison frame, and an exhausted capability-gap episode — and they quarantine
  the slot behind its `.failed` sentinel for an operator. Any other terminal is a
  finding.
- Segment magic, format version, and checkpoint invariants hold; a torn, truncated, or
  foreign-version segment is quarantined instead of replayed.
- Advisory locking is fail-closed: a directory owned by another process yields
  `QwpReplayStoreLockedError`, a release that cannot be proved stays on the retry list,
  and the maintenance worker is stopped on every exit path.
- UDP ingress is fire-and-forget by contract — no acknowledgement, no replay, no
  durability claim. Review it for datagram sizing and socket cleanup, not against the
  guarantees above.

### Async, concurrency, and resources

- Await every Promise; preserve send order and error propagation.
- Understand that compaction precedes the awaited send and auto-flush is lazy.
- Do not invite concurrent mutation or share a Sender across workers.
- Close owned sockets/pools/agents/timers/listeners on every path; preserve user-owned
  agents; do not retain stale buffer views.
- Close QWP sockets, keepalive and ACK timers, reconnect timers, the maintenance worker
  thread, and advisory locks on every path, including a failed upgrade, an aborted
  replay, and a quarantined slot.

### Performance

- Avoid per-row/per-cell allocations, repeated `toString`/`Buffer.byteLength`, string
  concatenation, and avoidable conversions/scans.
- Avoid per-character writes where safe bulk copying exists, resize thrashing, needless
  buffer copies, and O(n²) work over rows/cells/array elements.
- State the data multiplier for hot-path findings; bounded setup costs are Moderate at
  most unless they create an outage or compatibility failure.

### Public API and code quality

- Export new public symbols; treat removals/renames/signature/default changes as
  compatibility changes.
- Only the four documented entry points are public. Paths containing `internal`,
  `qwp-node`, or `src` are implementation details even when a bundler resolves them.
- A changed exported QWP symbol, option, constant, or error updates
  `test/qwp/public-api-contract.ts` and `QWP.md`.
- Keep TSDoc/types accurate and avoid casts that hide runtime null/type problems.
- Wire renamed options through parsing, validation, `resolveDeprecated`, `resolveAuto`,
  `fromConfig`, and `fromEnv` as applicable, and through the QWP config parser for QWP
  keys.
- Update README/examples for user-visible behavior.
- Keep ESLint/Prettier clean; remove dead code/imports; follow local naming/order.

### Tests

- Cover each changed protocol/transport/auth/TLS/configuration path that behaves
  differently, plus error, nullish, boundary, resize, retry, and cleanup paths.
- Use byte-level assertions for serializer changes and transport-level assertions for
  network/auth changes.
- Recompute expected hex/bytes and ensure assertions can fail and reach production code.
- QWP changes need frame-level assertions, and behavior that depends on it needs a
  reconnect, replay, restart, or lock-contention test. Reuse the fake sockets, fixtures,
  and interop helpers already in `test/qwp/`.
- A bug fix needs a regression test that fails without the fix unless the Step 2.6
  proportionality analysis admits a non-Critical gap.
- Prefer existing helpers and deterministic synchronization; avoid brittle timing,
  debug residue, misleading names, and implementation-only assertions.

### TODOs and commit messages

- Scan added/changed lines for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND`.
  Distinguish moved comments from newly deferred work and verify referenced issues.
- Check Conventional Commit subjects against `CONTRIBUTING.md`; descriptions should
  state user impact where relevant.

## Step 4: Output

Present only **ADMITTED** findings. Omitted hypotheses, disproofs, retractions, agent
counts, candidate counts, and the private ledger never appear. Do not publish a concern
and retract it later. Keep the report actionable; if a normal PR produces more than
about seven findings, rerun admission and remove dependent, duplicate, not-attributed,
or low-value items.

Every Critical and Moderate finding begins with three lines written from the completed
admission form:

- **Problem:** what is wrong, at most 12 words.
- **Net impact:** supported population and magnitude, at most 12 words.
- **Evidence:** decisive artifact/static proof and reviewed revision identity.

Then provide only the minimal producer → path → symptom trace, base comparison, exact
file/line, in-diff versus out-of-diff-breakage classification, and suggested fix.

### Severity classification

Severity is determined by reachable user consequence, not checklist category.

**Critical** requires a supported trigger and one of:

- Wrong/missing/duplicated/corrupted data or ILP/QWP wire bytes.
- Abandoned, silently dropped, or unreplayable store-and-forward data, or an ack
  watermark advanced past an unacknowledged frame.
- Crash, hang, outage, unbounded loop, OOM, or unbounded socket/timer/listener leak.
- A steady-state replay loop that ends, or surfaces a transient transport failure to the
  producer, instead of retrying.
- Credential exposure, auth/TLS bypass, or another security failure.
- Silent/misleading failure that makes ingestion appear successful or undiagnosable.
- Public API, config, runtime, module-system, protocol, or rolling-version compatibility
  break affecting existing supported consumers.
- User-observable throughput/latency/network regression multiplied per row/cell/request.
- An admitted Critical coverage gap meeting Step 2.6's full reachability/impact burden.

Every behavioral Critical must complete: “user does X → sees Y,” with an executed
same-trigger base comparison. A performance Critical states the multiplier. A theory
without a supported trigger is omitted, not preserved as Moderate.

**Moderate** covers admitted attributable issues with bounded/developer-facing impact:
proved weak tests, missing internal-path coverage, documentation defects, concrete
standards violations, or bounded setup/configuration costs. Dynamic speculation and
unchanged hardening opportunities are omitted.

**Minor** covers concrete cosmetics on changed lines: naming, ordering, formatting,
or comment wording.

Exclude merge mechanics, tautologies true of every similar PR, deliberate project
decisions without evidence they are wrong, generated artifacts as source, and all
contents behind `OPAQUE` submodule gitlink bumps.

### Critical

List blocking admitted issues in descending user impact. Include the three summary
lines, population/base delta/magnitude/offsets/net-negative determination, exact file
and lines, supported trigger and symptom, executed artifacts, classification, contract
and caller for out-of-diff breakage, and a fix scoped to this PR.

### Moderate

List non-blocking admitted issues with the three summary lines and decisive evidence.

### Minor

List optional, concrete cosmetics. Omit the section when empty.

### Adjacent findings (not blocking — file as GitHub issues)

Include only fully proved pre-existing bugs encountered in changed files or mapped
callers that this PR does not introduce, expose, or worsen. They never affect the
verdict and are never proposed as changes to this PR. For each provide:

- **Problem:** issue-title-length summary.
- **Net impact:** population and magnitude.
- **Location:** exact file and lines.
- **Symptom/reachability:** observed path, or named guard if latent.
- **Suggested fix:** one or two lines.
- **Standalone severity:** Critical, Moderate, or Minor.

Offer to file them; never file without permission.

### Coverage map

State the test-gate result and number of admitted coverage gaps. Render admitted gap
rows with their recorded search and failure link. Do not expose covered/accepted/exempt
rows or omitted-candidate counts unless asked.

### Summary

Choose exactly one verdict:

- **approve** — no open Critical findings and the test gate passes.
- **approve with comments** — both gates pass, but named Moderate items remain.
- **request changes** — at least one Critical finding is open or the test gate fails.
- **needs discussion** — product, architecture, or compatibility decision is required.

Apply these hard gates:

- **Correctness gate:** any admitted Critical requires `request changes`. Omitted
  hypotheses never affect the verdict.
- **Test gate:** fails only for admitted Critical coverage gaps. Zero test changes or
  missing regression coverage alone does not fail it.
- Before finalizing, re-audit each rendered behavioral finding for strongest disproof,
  supported producer, independent falsifier context, dynamic head/base evidence,
  dependency survival, net-negative user impact, and post-admission severity.
- If both gates pass, approve plainly; Moderate/Minor items do not justify withholding
  approval.

Also state:

- Test-gate result and admitted gap count.
- Regressions or tradeoffs.
- Submodule verdicts (`path: OPAQUE — contents excluded`) or `Submodules: none`.
- Admitted split: in-diff / out-of-diff-breakage.
- Severity distribution.
- At levels 0-1, the callsite-analysis limitation rather than implying exhaustive
  out-of-diff coverage.

Do not state agent counts, candidate counts, rejected/false-positive counts, or
retraction history.
