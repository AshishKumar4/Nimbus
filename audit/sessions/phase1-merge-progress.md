# Phase 1 Merge — Progress Log

> **Session:** Phase 1 merge orchestration
> **Started:** 2026-05-04
> **Operator:** autonomous build agent (user away ~1 year)
> **Goal:** Merge W3 + W5 + W4 into main without prod deploy.
> **Constraint:** Wrangler OAuth dead → prod deploys deferred.

## Pre-merge state

- `main` HEAD: `5385bde audit: master roadmap — W4/W5 queued for batch deploy`
- Common merge base for all 3 wave branches: `48b0384`
- Pre-existing tsc errors on main (baseline, allowed):
  - `src/esbuild-service.ts(153,28)` — Cannot find module `esbuild-wasm/esbuild.wasm`
  - `src/nimbus-session.ts(1896,39)` — `SqliteVFSProvider` not assignable to `MountProvider`
- File overlap analysis (vs 48b0384):
  - W3 ∩ W4: ∅
  - W3 ∩ W5: `src/facet-manager.ts`
  - W4 ∩ W5: `src/supervisor-rpc.ts`

## Merge order

1. W3 (node-shims, mostly orthogonal)
2. W5 (robustness — touches facet-manager.ts which W3 also touched)
3. W4 (npm-cache — touches supervisor-rpc.ts which W5 also touched)

---

## Merge 1 — W3 (origin/w3-builtins → main)

- Merge commit: `8cfbd16 Phase 1 merge: W3 (node-shims, real crypto, vm/http2/repl/dc/tls/async_hooks shims, fs.promises, honest net.Socket, sha256sum)`
- Conflicts: **none** (W3 source files do not overlap with main's only post-base commit `5385bde`, which is audit-only)
- tsc state after merge: clean except the 2 pre-existing baseline errors. ✅
- Local probes: W3 probes all hit `BASE=` (Nimbus server); none are unit-testable without `wrangler dev`. Skipped per orchestrator constraint (no wrangler auth). Retro already captured local 21/22 functional+regression + 3/6 e2e at build time.
- Push attempt: **denied** (`cloudflare-seal[bot]` lacks push grant at this minute — known transient lapse per W3 retro §S6). Will retry at end of phase.

## Merge 2 — W5 (origin/w5-robustness → main)

- Merge commit: `98d3ab1 Phase 1 merge: W5 (LRU decouple, OOM discriminator, fail-loud SQLITE_NOMEM retry, telemetry hooks)`
- Conflicts: **none** — `src/facet-manager.ts` (the predicted overlap) auto-merged cleanly because W3 added imports + `REAL_NODE_IMPORTS` block in different line regions than W5's added imports + telemetry hooks. Verified post-merge that both W3's `getRealNodeImportsCode()` injection and W5's `recordFailure / classifyError` imports are present in the merged file.
- tsc state after merge: clean except the 2 pre-existing baseline errors (line numbers shifted: nimbus-session.ts now reports at L2027 instead of L1896 because W5 added code above that line). ✅
- Local probes (functional + regression, skipping e2e per orchestrator constraint):
  - `functional/diag-shape`: 21/21 ✅
  - `functional/lru-shrink-restore`: 11/11 ✅
  - `functional/ring-persistence`: 16/16 ✅
  - `functional/sqlite-nomem-retry`: 13/13 ✅
  - `regression/fnv-counter-integrity`: 12/12 ✅
  - `regression/install-pipeline-coverage`: 8/8 ✅
  - Total: **81/81 assertions** green via mock SqlStorage harness.
  - `e2e/oom-stress`: skipped (needs prod / wrangler dev).
- Push attempt: deferred to end of phase (cumulative).

## Merge 3 — W4 (origin/w4-npm-cache → main)

- Merge commit: `a177138 Phase 1 merge: W4 (R2 cross-tenant tarball+packument cache, pipelined race, diag counters)`
- Conflicts: **1 — `src/supervisor-rpc.ts`** (predicted).
  - Single conflict block at the import region (lines 27-52 pre-resolve).
  - Both branches added top-of-file imports plus, in W5's case, a helper function `_estimateWriteBatchBytes`.
  - Resolution: kept BOTH additions (purely additive, no semantic interaction). Final import order:
    1. `WorkerEntrypoint` (base)
    2. W5: `setLastRpcFrame from './oom-discriminator.js'`
    3. W4: `R2CacheClient, MAX_R2_TARBALL_BYTES from './r2-cache.js'`
    4. W4: 8 diag-counter imports
  - W5's `_estimateWriteBatchBytes` helper retained immediately after the import block.
  - W5's `setLastRpcFrame(...)` call inside `async writeBatch` and W4's 7 new RPC methods (`getCachedTarball`, `putCachedTarball`, `getCachedPackument`, `putCachedPackument`, `purgeCachedTarball`, `purgeCachedPackument`, plus `_r2()` private helper) auto-merged below the conflict region — verified by line-grep post-resolve.
  - `git diff --check` clean → no orphan conflict markers anywhere.
- tsc state after merge: clean except the 2 pre-existing baseline errors. ✅
- Local probes: all W4 probes use `runProbe` against a Nimbus server (BASE=). None are local-runnable without `wrangler dev`. Skipped per orchestrator constraint. Retro recorded 6/6 functional probes green at build time on the `w4-npm-cache` branch tip; merge is non-source-modifying for `r2-cache.ts` / `npm-install-batch-facet.ts` / `npm-resolve-facet.ts` (no overlap with main or W5), so those probe results carry forward.
- Push attempt: deferred to end of phase.

## Final state — all 3 merges complete

- main HEAD: `a177138 Phase 1 merge: W4 ...`
- main is 17 commits ahead of origin/main (1 W3 fast-merge + W3 ancestry, 1 W5 merge commit + W5 ancestry, 1 W4 merge commit + W4 ancestry).
- tsc: 2 baseline errors only (no new errors introduced by any merge or by the W4 conflict resolution). ✅
- All 3 wave branches' source code is now reachable from main.
- No wave-branch source code was modified during merge (per anti-requirement).
- All worktrees retained (per anti-requirement).
