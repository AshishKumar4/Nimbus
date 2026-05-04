# W5 — Robustness (SqliteVFS LRU + OOM observability)

> Wave: W5 of MASTER-ROADMAP.md.
> Branch: `w5-robustness` (from `main` @ `48b0384`).
> Worktree: `/workspace/worktrees/w5-robustness/`.

## 0. Goal (lifted from roadmap, restated as test-of-truth)

> *Zero silent terminations. Every OOM categorized.*

Operational test-of-truth: a synthetic 50-large-installs-in-parallel
stress harness must produce **zero** facet terminations that are not
followed by a `/api/_diag/memory` ring-buffer entry whose `cause`
field is populated with one of the discriminated values
(`oom` | `sqlite_nomem` | `clone_refused` | `rpc_timeout` |
`subrequest_cap` | `condemnation` | `hard_evict` | `unknown`).

Mossaic regression: must continue to PASS (W2.6a baseline).
W2.5 install-pipeline-coverage: must continue to PASS.
W2.5 FNV / file-counter integrity: invariants preserved.

## 1. Wave anchors

CF-internal research:

| Anchor | Section | What it says |
|---|---|---|
| **Lever 5** (≡ A1 / F1) | `CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §A.4 / §F (`F1`); `_drafts/F-observability.md:43-86` | `cause` discriminator on diag-counters (XS). Add `lastFailures: DiagFailure[]` ring buffer (50 entries). Surface via `/api/_diag/memory`. |
| **Lever 8** (≡ A2 / J.1.2) | `CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §A §J.1.2; `_drafts/A-do-isolate-memory.md:99-152` | Decouple SqliteVFS LRU from facet-pool buffer staging. `vfs.shrinkForInstall()` during heavy-alloc-coord windows. 32 MiB → 8 MiB during install. +24 MiB headroom. |
| **Lever 9** (≡ A3 / J.1.3) | `CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §A.2 §J.1.3; `_drafts/A-do-isolate-memory.md:118-152` | Catch `SQLITE_NOMEM` ("out of memory" / "too large" / etc.) at `transactionSync` boundary. Drop LRU, retry batch halves. Fail loud not silent. |

## 2. Lever 8 — SqliteVFS LRU decouple

### Current architecture (file:line)

`src/sqlite-vfs.ts:48` — imports `LRU_MAX_ENTRIES` from `./constants.js`
`src/constants.ts:13` — `LRU_MAX_ENTRIES = 512` (×64 KB chunk = 32 MiB).
`src/sqlite-vfs.ts:118-120` — `private cache = new Map<string, CacheEntry>(); private _cacheBytes = 0;`
`src/sqlite-vfs.ts:343-381` — `cacheSet()` / `evictOne()`. The eviction trigger is line 360: `while (this.cache.size >= LRU_MAX_ENTRIES)`. The cap is the **module-level constant** — not adjustable at runtime.
`src/sqlite-vfs.ts:1303-1358` — `getStats()`. Reports `cache.maxEntries: LRU_MAX_ENTRIES` and `cache.maxBytes: LRU_MAX_ENTRIES * CHUNK_SIZE` — hard-coded.

### The coupling problem

The 32 MiB hot working set cohabitates with the install-staging path:

| Layer | Bytes (peak) | Source |
|---|---|---|
| SqliteVFS LRU | 32 MiB | `cache: Map<key, CacheEntry>` |
| In-flight RPC payloads (writeBatch from facet) | up to 32 MiB | `parallel/facet-pool.ts:#dispatchSlot` arg payloads + structured-clone overhead |
| `pendingWrites` deferred queue | up to ~32 MiB (500 × ~64 KB throttle) | `sqlite-vfs.ts:451-470` |
| Facet-pool slot-warm `args` reachable while timer pending | ~28 MiB per slot | `parallel/facet-pool.ts:499-540` |

Sum at peak: ~120 MiB. Against a 128 MiB shared-isolate ceiling (often
lower per `_drafts/A-do-isolate-memory.md:21-39`) — **no headroom.**
`heavy-alloc-coord.ts` (`acquireHeavyAlloc`) currently signals
pre-bundle to back off, but does **not** signal the SqliteVFS to drop
its LRU. Lever 8 closes that gap.

### Target architecture

1. Make the cap **runtime-mutable** in `SqliteVFS`. Replace the
   `LRU_MAX_ENTRIES` reference at the eviction-trigger site with an
   instance field (default seeded from the constant; preserves current
   behaviour). Add `getStats().cache.maxEntries` to read from the
   instance field.

2. Two new public methods on `SqliteVFS`:
   - `shrinkForInstall(targetEntries = 128)` — sets `_lruMaxEntries =
     targetEntries`, calls a new private `evictDownToLimit()` which
     loops `evictOne()` while `this.cache.size > this._lruMaxEntries`.
     Idempotent; refcount-based so nested heavy-alloc owners don't
     race.
   - `restoreAfterInstall()` — decrement refcount; when zero, restore
     `_lruMaxEntries = LRU_MAX_ENTRIES`. (No re-population — the cache
     warms naturally on next reads.)

3. Wire from `acquireHeavyAlloc()` in `heavy-alloc-coord.ts`. When
   `acquireHeavyAlloc()` transitions count 0 → ≥1, fire
   `vfs.shrinkForInstall()`. When the matching `release()` transitions
   ≥1 → 0, fire `vfs.restoreAfterInstall()`. Coordinator gets a
   `setVfsObserver(vfs: SqliteVFS)` registration hook so it doesn't
   pull `SqliteVFS` as a static import (preserves layering).

4. Default shrink target: **128 entries × 64 KB = 8 MiB**. Matches the
   sketch in `J.1.2`. Evicted dirty pages flow through the existing
   `deferWrite()` path (no data loss).

### Headroom math

Pre: 32 MiB LRU, 32 MiB in-flight RPC, 32 MiB pending = 96 MiB just on
the I/O lanes. Post-shrink: 8 MiB LRU + 32 MiB in-flight + 32 MiB
pending = 72 MiB. **+24 MiB recovered**, exactly the figure projected
in §J.1.2.

### Risks

- **Eviction storm.** Shrinking from 512 → 128 entries flushes ~384
  dirty pages via `deferWrite` → `flushPendingWrites`. Mitigation:
  shrink runs *before* the install allocates, so the flush is paid
  once and is sync-fast (single transactionSync per ~500 entries per
  the deferWrite throttle).
- **Cold-cache bounce.** After shrink + install, the next read of any
  evicted page goes back to SQL. Acceptable — install workloads
  write-once-then-rarely-reread the same chunks.
- **Refcount leak.** A caller that acquires heavy-alloc but throws
  before release would leave LRU shrunk forever. Mitigation: existing
  `acquireHeavyAlloc()` returns a one-shot release; pre-bundle's site
  already wraps in try/finally. Add an audit-time invariant test in
  the functional probe.

## 3. Lever 9 — `SQLITE_NOMEM` catch + fail-loud retry

### Where errors propagate today

`src/sqlite-vfs.ts:472-571` — `flushPendingWrites()` is the
deferred-write engine. Already has a one-shot retry for
`transactionSync`-rollback failures (lines 541-552), but the retry is
agnostic to the *cause*. SQLITE_NOMEM is treated identically to a
constraint conflict — both go to `_recordFailedWrite()`.

`src/sqlite-vfs.ts:1072-1156` — `writeBatch()` (the bulk install
path). Wraps a single `transactionSync` around N inode + chunk
inserts. If `transactionSync` throws, the catch at line 1152 logs and
re-throws. **No retry. No discrimination.**

`src/npm-installer.ts:288, 339, 989` — three call sites of
`vfs.writeBatch()`. None wrap in try/catch. A SQLITE_NOMEM during a
500-package wave fails the whole wave silently in the supervisor.
Currently surfaced only as a "writeBatch failed" log line.

### Discriminator

A SQLITE_NOMEM exception in workerd/SQLite manifests as one of:
- `e.message` contains `'SQLITE_NOMEM'`
- `e.message` contains `'out of memory'` (case-insensitive)
- `e.message` contains `'too large'` (page-cap symptom)
- `e.message` contains `'database or disk is full'` (rare, but
  observed when the per-DO cap lands)

Per CF research §A.2 the SPEC is in flight (workerd PR 6380). After
it merges, the message text is fixed; before it merges Nimbus only
gets the indirect symptom (RPC failure / "Cannot deserialize"). Build
the discriminator to match **both**, with a single classifier in a
new `src/oom-classify.ts` module:

```ts
export type OomCause = 'sqlite_nomem' | 'clone_refused' | 'oom'
  | 'rpc_timeout' | 'subrequest_cap' | 'condemnation'
  | 'hard_evict' | 'unknown';

export function classifyError(e: unknown): OomCause { /* … */ }
```

### Retry path

In `SqliteVFS.writeBatch()`:

1. Wrap the inner `doTransaction()` call in try/catch (preserve
   existing `cacheInvalidateBatch` / `clearPendingWritesForPaths` —
   they ran before the try and don't need rollback).
2. On catch, classify. If `oom_cause === 'sqlite_nomem'`:
   - Record a `DiagFailure` entry with `cause: 'sqlite_nomem'`,
     `phase: getCurrentInstallPhase()`, the affected `lruBytes`, the
     `inFlightBytes` of the batch.
   - Drop the LRU (call `evictAll()` — a new method that synchronously
     clears the cache + flushes any cleanly-evictable pages). **This
     is the Nimbus-side back-off** — frees pages owned by US.
   - Retry by halving: `writeBatch({ inodes: half1, chunks: chunksFor(half1), deletePaths: half1Paths })` then second half. Each retry recurses ONCE through the same retry guard; bound recursion depth at 4 (so a 500-row batch falls back to ≤32-row sub-batches).
3. On any other classified cause, record a `DiagFailure` and re-throw.
   Fail loud: callers see the original error, plus the diag entry
   provides forensic context.

### Why this is safer than today

Today: SQLITE_NOMEM on a 500-row writeBatch → entire wave fails →
session blocks at "Fetching 30 packages…" with no actionable error.
With Lever 9: a 500-row batch becomes 250+250, then 125+125+125+125
on each retry. Empirically (per Mossaic install paths) the OOM is
threshold-driven: 500 rows fail, 100 rows succeed. Two halvings
suffice.

### Risks

- **Idempotence.** `writeBatch` deletes old paths first then inserts
  new. Halving must preserve this contract: the second-half call must
  NOT re-delete paths the first-half call inserted. Mitigation: the
  retry path partitions both `inodes` AND `deletePaths` AND `chunks`
  by path-set so each half operates on disjoint paths.
- **Counter drift.** Inode/file counters live in `_totalFiles` etc.
  The current writeBatch updates them outside the transaction (line
  1157+). Halving still calls writeBatch twice → counters update
  twice → consistent. Verified by the W2.5-FNV regression probe in
  Phase B.

## 4. Lever 5 — OOM cause discriminator + ring buffer + persistence

### What to capture per failure

| Field | Source | Purpose |
|---|---|---|
| `at` | `Date.now()` | Triage timestamp |
| `phase` | `readDiagCounters().installPhase` (or RPC site label) | Which lifecycle stage |
| `cause` | `classifyError(e)` | The discriminator |
| `rssEstimateBytes` | `_diagSampleMemory()` peak | Heap pressure context |
| `heapUsedBytes` | `process.memoryUsage().heapUsed` (best-effort 0 in DO) | Process JS heap |
| `lruBytes` | `vfs.getStats().cache.hotBytes` | SqliteVFS pool — distinct from heap |
| `inFlightBytes` | new counter on `SupervisorRPC` (`_inFlightBytes`) | RPC clone load |
| `lastRpcFrame` | new field set by `SupervisorRPC` on every `writeBatch` entry: `{ method, payloadBytes, atMs }` | Forensic last-known-RPC |
| `lastFacetId` | new field set by `FacetManager._execViaFacets` on every dispatch: `{ codeId, slotIndex, atMs }` | Forensic last-known-facet |
| `exitCode` (terminations only) | `processTable.exit(pid, code)` arg | Maps to facet termination |
| `pid` (terminations only) | `entry.pid` | Maps to facet termination |
| `message?` | `e.message` truncated 200 chars | Optional context |

### Ring buffer design

Module: `src/oom-discriminator.ts` (new). Singleton-per-isolate (same
pattern as `diag-counters.ts`).

```ts
export interface DiagFailure {
  at: number;
  phase: string;
  cause: OomCause;
  rssEstimateBytes: number;
  heapUsedBytes: number;
  lruBytes: number;
  inFlightBytes: number;
  lastRpcFrame: { method: string; payloadBytes: number; atMs: number } | null;
  lastFacetId: { codeId: string; slotIndex: number; atMs: number } | null;
  exitCode?: number;
  pid?: number;
  message?: string;
}

const RING_SIZE = 50;
const ring: DiagFailure[] = [];
export function recordFailure(f: DiagFailure): void { /* unshift; cap at RING_SIZE */ }
export function getFailures(): DiagFailure[] { return ring.slice(0); }
export function setLastRpcFrame(method: string, payloadBytes: number): void { /* … */ }
export function setLastFacetId(codeId: string, slotIndex: number): void { /* … */ }
```

### Persistence on close

Two boundary events trigger persistence to DO storage:

1. **`webSocketClose`** — `nimbus-session.ts:webSocketClose()`. Snapshot
   the ring + counters → `ctx.storage.put('w5_diag_snapshot', {...})`.
2. **Facet termination** — `FacetManager.exec()` catch path (line ~835)
   AND `_reportExternalExit`. On any exit code != 0, push a synthetic
   `DiagFailure` with `cause: 'unknown'` (or classified from the
   stderr if SQLITE_NOMEM detected). Persist the same way.

On wake (DO reactivation), `nimbus-session.ts` constructor reads
`w5_diag_snapshot` once and seeds the ring. Lets `cf-tail`-style
forensics survive hibernation. Bounded by RING_SIZE × ~400 B = ~20 KB
of storage per snapshot — negligible.

### Wire-up sites (phase A audit)

| Site | File:Line | Wire |
|---|---|---|
| writeBatch SQLITE_NOMEM | `src/sqlite-vfs.ts:1152` (new catch) | `recordFailure({phase: 'install', cause: 'sqlite_nomem', …})` |
| flushPendingWrites failure | `src/sqlite-vfs.ts:550, 562` | `recordFailure({phase: 'install', cause: 'sqlite_nomem' \| 'unknown', …})` |
| facet-pool dispatch error | `src/parallel/facet-pool.ts:489-494` | `recordFailure({phase: 'rpc', cause: classify(err), …})` |
| facet timeout | `src/parallel/facet-pool.ts:520-528` | `recordFailure({phase: 'rpc', cause: 'rpc_timeout', …})` |
| facet external exit | `src/facet-manager.ts:806-814, 850-855` | `recordFailure({phase: 'facet', cause: classify(err), exitCode, pid, …})` |
| webSocketClose | `src/nimbus-session.ts:webSocketClose` | persistence flush |
| RPC entry point | `src/supervisor-rpc.ts:writeBatch` | `setLastRpcFrame('writeBatch', payloadBytes)` before processing |
| Facet dispatch entry | `src/facet-manager.ts:_execViaFacets` | `setLastFacetId(codeId, slotIndex)` before await |

## 5. `/api/_diag/memory` v2

Existing handler: `src/nimbus-session.ts:1254-1289`. Augment by adding
the W5 fields without removing existing ones (back-compat):

```ts
return Response.json({
  // Existing fields (preserved):
  vfs: { files, usedBytes },
  nodeMem, perfMem,
  peak: { rssBytes, heapUsedBytes, atMs, samples },
  counters,
  limitBytes: 128 << 20,
  usagePctOfLimit,
  ts: Date.now(),

  // NEW in W5:
  lastFailures: getFailures(),
  vfsDetail: {
    lruBytes: vfs.getStats().cache.hotBytes,
    lruMaxEntries: vfs.getStats().cache.maxEntries,
    lruShrunk: lruMaxEntries < LRU_MAX_ENTRIES, // observability for Lever 8
  },
  rpc: {
    lastFrame: getLastRpcFrame(),
    inFlightCount, // best-effort gauge
  },
  facet: {
    lastDispatch: getLastFacetId(),
  },
});
```

**Schema invariant:** `lastFailures` is always an array (possibly
empty). `lastFrame` is `{ method: string, payloadBytes: number, atMs:
number } | null`. `lastDispatch` is `{ codeId: string, slotIndex:
number, atMs: number } | null`. Tests in
`audit/probes/w5/functional/diag-shape.mjs` assert this contract.

## 6. OOM telemetry on facet termination

`FacetManager` exit paths at lines 806, 832, 843, 850 already exit
the process table. Add (in priority order):

1. **At every external-exit hook fire** (`onExternalExit?(pid, code,
   reason)`): if `code !== 0`, push a `DiagFailure` synthesized from
   `reason`. Classify `reason` strings via `classifyError(reason)` —
   the classifier accepts strings as a degenerate Error.
2. **At every facet error catch** (line 814 path / 856 path): same.
3. **At `webSocketClose`** (`nimbus-session.ts`): if any pid in the
   process table has exitCode != 0 in the last N seconds and is not
   yet in the ring, synthesize an entry. Belt-and-braces.

Result: no `processTable.exit(pid, !=0)` happens without a ring entry.
This is the **zero-silent-OOM contract**.

## 7. Verification protocol — synthetic OOM stress harness

`audit/probes/w5/e2e/oom-stress.mjs`:

1. Open prod session via `runProbe`.
2. Run **50 large parallel installs** in a single shell command:
   ```sh
   for i in $(seq 1 50); do (cd /tmp && mkdir -p p$i && cd p$i && npm init -y >/dev/null && npm install fastify express ts-jest typescript &); done; wait
   ```
   Tuned to overshoot the 128 MiB cap by a comfortable margin.
3. After settle (30 s), query `/api/_diag/memory`.
4. Cross-check:
   - For every `processTable.exit(pid, code != 0)` recorded in the
     process table, find a matching `lastFailures[i].pid === pid` with
     `cause` populated.
   - **Zero unmatched terminations** = pass.
5. Mossaic regression: run install-pipeline-coverage probe. Pass = no
   regression on visible-files counts (W2.5 contract).

The 50 number is calibrated to (a) reliably trip OOM on shared-isolate
ceiling per the §A.1 measurements, (b) not exceed Cloudflare's
free-tier subrequest budget for the test run, (c) finish in under 90 s.

Local-only validation: the same harness runs against `wrangler dev`
on `0.0.0.0:8787` first (preferred), then prod. Functional tests use
a `vitest` runner against an in-memory SqliteVFS to assert LRU
shrink/restore + writeBatch retry semantics without needing the
network.

## 8. Test coverage matrix (Phase B targets)

| Probe | Type | Asserts |
|---|---|---|
| `w5/functional/lru-shrink-restore.mjs` | functional | `vfs.shrinkForInstall()` evicts to ≤128 entries; `restoreAfterInstall()` restores to 512; refcount works |
| `w5/functional/sqlite-nomem-retry.mjs` | functional | injected fake-nomem error in `transactionSync` triggers halve-retry; both halves succeed; ring entry has `cause: sqlite_nomem` |
| `w5/functional/diag-shape.mjs` | functional | `/api/_diag/memory` v2 has all W5 fields with correct types; back-compat fields preserved |
| `w5/functional/ring-persistence.mjs` | functional | `recordFailure` → `webSocketClose` snapshot → `ctx.storage.put` called; on next session-start, ring rehydrated |
| `w5/regression/install-pipeline-coverage.mjs` | regression | re-run W2.5 probe — must pass |
| `w5/regression/fnv-counter-integrity.mjs` | regression | After shrink/retry, `_totalFiles`/`_usedBytes` match a fresh O(N) walk |
| `w5/e2e/oom-stress.mjs` | e2e | 50-parallel-installs; zero silent kills |

`run-all.mjs` orchestrates: functional first (fast, fails-fast),
regression second, e2e last.

## 9. Files touched (commit map)

| Phase | File | Change |
|---|---|---|
| C | `src/oom-classify.ts` | NEW — error → `OomCause` classifier |
| C | `src/oom-discriminator.ts` | NEW — ring buffer, last-frame, last-facet, persistence helpers |
| C | `src/sqlite-vfs.ts` | LRU runtime cap + `shrinkForInstall` / `restoreAfterInstall` / `evictAll` ; writeBatch try/catch + retry |
| C | `src/heavy-alloc-coord.ts` | observer hook to fire shrink/restore on count transitions |
| C | `src/nimbus-session.ts` | `/api/_diag/memory` v2; webSocketClose persistence; constructor rehydrate |
| C | `src/facet-manager.ts` | `setLastFacetId` calls + termination ring-entry push |
| C | `src/parallel/facet-pool.ts` | `recordFailure` calls in dispatch/timeout catches |
| C | `src/supervisor-rpc.ts` | `setLastRpcFrame` calls on entry points |
| B | `audit/probes/w5/**` | new probe suite |
| A | `audit/sections/W5-plan.md` | THIS FILE |
| F | `audit/sections/W5-retro.md` | retro |
| logs | `audit/sessions/W5-progress.md` | per-phase progress |

## 10. Risks

1. **DO storage write on every webSocketClose may be expensive.**
   Mitigation: only persist if ring is non-empty AND ring has changed
   since last persist. Keep snapshot ≤20 KB.
2. **`evictAll()` synchronous flush could block input gate.** The
   existing `flushAll()` is sync by design (sqlite-vfs invariant). Stay
   sync. Worst case: a 500-page flush on a write-heavy session is
   ~1-2 ms in workerd's measurements.
3. **Classifier false-positive on user code.** A user's `npm install`
   that legitimately runs out of disk could be classified as
   `sqlite_nomem` and trigger pointless retries. Mitigation: the
   classifier runs only on errors raised inside SqliteVFS or
   facet-pool boundaries — both Nimbus-internal. User process exits
   are passed through `classifyError(stderr)` separately and treated
   as observation-only (no retry).
4. **Ring rehydrate runs in constructor** — must not throw or block
   constructor. Wrap in try/catch and log on failure; constructor
   must succeed even if the snapshot is corrupt.
5. **Recursion bound on writeBatch retry.** Cap depth at 4. A
   16th-of-batch failure bubbles up rather than infinite-looping.
6. **Facet termination message classification.** Several facet error
   paths produce different message shapes. The classifier must accept
   strings (not just Error instances) and degrade gracefully to
   `'unknown'`.

## 11. Out of scope (explicit non-goals for W5)

- Lever A4 (dedicated-isolate flag) — gated on CF dialogue.
- Lever A5 (memory-pressure notification API) — gated on CF SPEC.
- Lever F2 / F3 / F4 (Logpush, Tail Workers, Analytics Engine) — W9+.
- Lever B5 / G1 (codeId content-derivation audit) — W6.
- Lever C1 (process-logs hibernatable WS) — W9.
- Streams over RPC (E1) — W7.
- WASM swap registry — W6.

## 12. Done criteria recap

- `audit/sections/W5-plan.md` ✓ (this file)
- `audit/sections/W5-retro.md` produced in Phase F
- All `audit/probes/w5/**` tests pass locally
- `src/` reflected on `origin/w5-robustness`
- `audit/sessions/W5-progress.md` shows all 6 phases ✓
- Zero-silent-OOM contract verified on the e2e probe
