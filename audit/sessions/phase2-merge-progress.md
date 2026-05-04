# Phase 2 Merge — Progress Log

> **Session:** Phase 2 merge orchestration
> **Started:** 2026-05-04
> **Operator:** autonomous build agent (user away ~1 year)
> **Goal:** Merge W6 + W9 + W8 into main without prod deploy.
> **Constraint:** Wrangler OAuth dead → prod deploys deferred.

## Pre-merge state

- `main` HEAD: `b266d1d audit: Phase 1 merged to main + master roadmap updated`
- Common base for all 3 wave branches: `b266d1d` (post-Phase-1 main)
- Pre-existing tsc errors on main (baseline, allowed):
  - `src/esbuild-service.ts(153,28)` — Cannot find module `esbuild-wasm/esbuild.wasm`
  - `src/nimbus-session.ts(2027,39)` — `SqliteVFSProvider` not assignable to `MountProvider`
- File overlap analysis (src/ only, vs b266d1d):
  - W6 ∩ W8: ∅
  - W6 ∩ W9: ∅
  - W8 ∩ W9: `src/nimbus-session.ts`
- W8 also touches `src/git-bundle.generated.ts` and `src/parallel/generated-workers.ts` — both timestamp-only diffs from a `bun install` postinstall regen, harmless (same noise W3-retro §S7 documented).

## Merge order

1. W6 (wasm-swap registry — fully orthogonal to W8/W9)
2. W9 (hib-logs — touches nimbus-session.ts which W8 also touches)
3. W8 (child-process — touches nimbus-session.ts; expect conflict)

---

## Merge 1 — W6 (origin/w6-wasm-swap → main)

- Merge commit: `e7e9d20 Phase 2 merge: W6 (WASM swap registry: esbuild→esbuild-wasm + 24 REJECT_INSTALL entries with transitive policy)`
- Conflicts: **none** (W6 source is fully orthogonal to anything on main)
- tsc state: 2 baseline errors only ✅
- Local probes: **17/17 ALL W6 PROBES PASS** via `bun audit/probes/w6/run-all.mjs` (functional 7/7, regression 4/4, e2e 6/6 — `registry-coverage.mjs` is the prod-gated probe and SKIPs cleanly without `NIMBUS_W6_E2E_PROD=1`).
- Push: succeeded → `b266d1d..e7e9d20 main -> main`.

## Merge 2 — W9 (origin/w9-hib-logs → main)

- Merge commit: `c303948 Phase 2 merge: W9 (hibernation-aware ProcessLogStore + WS auto-response config + hibernatable WS)`
- Conflicts: **none**. W9 modified `src/nimbus-session.ts` (PersistAdapter wiring, alarm, diag.hib) but main's only nimbus-session.ts edits were from W5 (already in base). W8's nimbus-session.ts changes are not yet on main, so no overlap surfaced now — overlap will hit on the W8 merge as designed.
- tsc state: 2 baseline errors only (nimbus-session.ts error line shifted 2027 → 2376 because W9 added 280 lines above; same root cause as W5's earlier shift). ✅
- Local probes: **6/6 ALL GREEN** via `bun audit/probes/w9/run-all.mjs` (functional 3/3, regression 2/2, e2e 1/1 SKIPped — gated on `NIMBUS_W9_E2E=1` + wrangler dev).
- Push: succeeded → `e7e9d20..c303948 main -> main`.

## Merge 3 — W8 (origin/w8-child-process → main)

- Merge commit: `bcb32df Phase 2 merge: W8 (child_process facet-mapped: spawn/exec/execFile/spawnSync/fork + ChildProcess emitter + 7 cp* RPCs)`
- Conflicts: **none** (surprise — predicted overlap on `src/nimbus-session.ts` auto-merged cleanly).
  - W9 (already on main) added imports near L31 + a `_w9*` field block at L481+ + a constructor body block at L585+.
  - W8 added an import at L30 (`FacetProcessManager`), a `_classifyCommand` helper at L397, a `private facetProcessManager` field at L495, 7 cp* RPC methods at L1130, an `_ensureFacetProcessManager` block at L1924, and a `_setCpRegistry(registry)` call in shell-init at L2282.
  - All regions interleaved without overlap. Verified post-merge that **both W8 and W9 marker symbols are present** in the merged file: `FacetProcessManager`, `_classifyCommand`, `_w9WsConfig`, `_w9IsolateGen`, `configureWsHibernation`, `_ensureFacetProcessManager`, `_setCpRegistry`, `_cpRegistry`, `_rpcCpSpawn`, `_rpcCpKill` all resolve at sane line numbers.
- W8 also touched `src/git-bundle.generated.ts` and `src/parallel/generated-workers.ts`. Both diffs are timestamp-only (W3-retro §S7 noise from `bun install` postinstall regen). Carried into main as part of the merge — no semantic content change.
- Probe-artifact hygiene: re-running the W9 + W8 local probes between merges overwrites their respective `results-build.txt` files with new timestamps. Discarded those unstaged drifts via `git checkout HEAD -- audit/probes/w<N>/results-build.txt` so the build-time artifacts on `main` match what was recorded on the wave branches.
- tsc state: 2 baseline errors only (line shifted 2376 → 2605 because W8 added 233 lines above; same root cause as W5/W9's earlier shifts). ✅
- Local probes: **21/21 ALL GREEN** via `bun audit/probes/w8/run-all.mjs` (functional 15/15, regression 2/2, e2e 4/4 — W8's e2e probes are mock-based via `_test-interpreter.mjs` shim host, so they run locally without wrangler).
- Push: succeeded → `c303948..bcb32df main -> main`.

## Final state — all 3 merges complete

- main HEAD: `bcb32df Phase 2 merge: W8 ...`
- main is now Phase 1 + Phase 2 complete (W3, W4, W5, W6, W8, W9 all merged).
- tsc: 2 baseline errors only. Every merge ran tsc and confirmed no new errors. ✅
- Total local probe coverage exercised this session:
  - W6: 17/17 ✅
  - W9: 6/6 ✅ (e2e 1/1 SKIPPED, gated on wrangler dev)
  - W8: 21/21 ✅
- All wave-branch source preserved. Worktrees + remote refs intact.
