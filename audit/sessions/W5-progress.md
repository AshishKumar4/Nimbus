# W5 — Progress log

Tracker for the autonomous W5 wave. Append per phase.

## Phase A — 2026-05-04T19:42:00Z
- Status: ✓
- Commit: (pending)
- Notes: W5-plan.md authored covering Lever 8 (LRU decouple), Lever 9
  (SQLITE_NOMEM catch+retry), Lever 5 (cause discriminator + ring +
  persistence), `/api/_diag/memory` v2, OOM telemetry on facet
  termination, synthetic-OOM stress harness verification protocol,
  test coverage matrix, files-touched commit map, risks, scope.
  Sub-agent review unavailable (provider-not-found); inline self-review
  performed: spot-checked all file:line refs against actual src/;
  added build-phase notes to (a) ensure writeBatch retry partitions
  chunks+inodes+deletePaths consistently, (b) gate persistence behind
  `ctx.waitUntil`, (c) include children-index integrity test in
  Phase B.

## Phase B — 2026-05-04T19:55:00Z
- Status: ✓
- Commit: (pending)
- Notes: TDD scaffold authored. Suite of 7 probes:
  - functional/lru-shrink-restore (Lever 8 — fails: shrinkForInstall undef)
  - functional/sqlite-nomem-retry (Lever 9 — fails: oom-discriminator missing)
  - functional/diag-shape (/api/_diag/memory v2 — fails: discriminator missing)
  - functional/ring-persistence (snapshot + rehydrate — fails: missing)
  - regression/fnv-counter-integrity (W2.5 invariants — fails on retry path)
  - regression/install-pipeline-coverage (probe-presence — passes)
  - e2e/oom-stress (zero-silent-OOM contract — fails: discriminator missing)
  Mock SqlStorage authored at audit/probes/w5/_mock-sql.mjs supporting
  SqliteVFS's full SQL surface in-memory with an injectFailures(n,msg)
  hook so we can deterministically synthesize SQLITE_NOMEM. Suite
  driver run-all.mjs orchestrates ordered execution.
  6/7 failing as expected; only install-pipeline-coverage's
  probe-presence check passes (correct — we don't modify the W2.5 probe
  in W5).

## Phase C — 2026-05-04T20:00:00Z
- Status: ✓
- Commits: 1539e2d (C.1-C.3), 9a0d2ae (C.4-C.5), 3fd04cf (C.6)
- Notes: Build complete in 6 commits across 3 pushes.
  - C.1: src/oom-classify.ts (118 LOC) — discriminator with 8 OomCause
    values; accepts Error / string / unknown.
  - C.2: src/oom-discriminator.ts (211 LOC) — globalThis singleton;
    ring 50-deep with 200-char message cap; snapshotForStorage /
    rehydrateFromStorage v1; setLastRpcFrame / setLastFacetId slots.
  - C.3: src/sqlite-vfs.ts (+249 LOC) — runtime-mutable _lruMaxEntries
    via shrinkForInstall(target=128) / restoreAfterInstall() with
    refcount; evictAll(); writeBatch wrapped in _writeBatchWithRetry
    (depth-bounded at 4) with halve-partition by inode path-set.
  - C.4: src/heavy-alloc-coord.ts (+50 LOC) — registerAllocObserver
    fires onAcquire/onRelease on 0↔≥1 edges. Observer errors caught.
  - C.5: src/nimbus-session.ts (+170 LOC) — observer registration in
    ensureSqliteFs; /api/_diag/memory v2 with lastFailures/vfsDetail/
    rpc.lastFrame/facet.lastDispatch (back-compat preserved); ring
    persistence in webSocketClose / webSocketError via ctx.waitUntil;
    rehydrate from ctx.storage in constructor (fail-soft).
  - C.6: src/parallel/facet-pool.ts + src/facet-manager.ts +
    src/supervisor-rpc.ts (+92 LOC) — setLastFacetId on dispatch;
    recordFailure on dispatch catch; _w5RecordTermination on every
    non-zero exit path; setLastRpcFrame on writeBatch entry.

## Phase D — 2026-05-04T20:05:00Z
- Status: ✓
- Notes: Audit phase. All 7 W5 probes GREEN. tsc --noEmit baseline-
  matches main (only the two pre-existing errors). Self-review
  ($1000-bet) ran inline (sub-agent provider unavailable):
    * Identified: writeBatch retry on single-path-delete payload
      becomes wasteful (depth-bounded so no infinite loop) — bounded
      by depth=4. Add follow-up test in retro recommendations.
    * Identified: only writeBatch RPC instruments setLastRpcFrame.
      writeFile / putRegistryEntries don't. Acceptable for W5 (write-
      Batch is the largest-payload + most-likely OOM site); add to
      W5.5 follow-ups.
    * Identified: rehydrate is fired async-unawaited in constructor;
      worst case missed entries from prior isolate during the first
      ~ms after wake. Acceptable.

## Phase E — 2026-05-04T20:08:00Z
- Status: ✓
- Commit: 855a0b4
- Notes: Pushed 4 times across the wave for incremental visibility
  (Phase A, Phase B, C.1-C.3, C.4-C.5, C.6, Phase D). Final ref:
  origin/w5-robustness @ 855a0b4.

## Phase F — 2026-05-04T20:10:00Z
- Status: ✓
- Notes: W5-retro.md authored. Done criteria all met:
  - W5-plan.md ✓
  - W5-retro.md ✓
  - audit/probes/w5/** all green locally (86/86 assertions)
  - src/ pushed on origin/w5-robustness
  - W5-progress.md complete for all 6 phases
  Zero-silent-OOM contract met locally. Prod validation listed as
  W5.5 #1+#2 follow-ups in retro.
