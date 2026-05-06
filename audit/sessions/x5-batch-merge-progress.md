# X.5 batch merge — progress log

> Autonomous orchestrator session 2026-05-05.
> Goal: merge `origin/x5f-resolve-miss` + `origin/x5g-optional-deps` + `origin/x5c-prebundler` into `main`, push, update roadmap. Do **not** deploy (wrangler OAuth deferred).

## Pre-merge state

- `main` HEAD: `412ff2c` (Phase 6 session-refactor)
- `origin/x5f-resolve-miss` HEAD: `528c348`
- `origin/x5g-optional-deps` HEAD: `0ea9db9` (already includes x5f as a baseline merge `2501917`)
- `origin/x5c-prebundler` HEAD: `7eef0e2` (off `main` `412ff2c` directly; does NOT include x5f or x5g)
- tsc baseline: 2 errors (esbuild-service:153 + nimbus-session-init:74) — pre-existing

## Diff topology

- x5f touches: `src/node-shims.ts`, `src/npm-cache.ts`, `src/npm-installer.ts`, `src/npm-resolve-facet.ts`, `src/npm-resolver.ts`, plus 2 generated (timestamp) files
- x5g touches: `src/wasm-swap-registry.ts`, `src/npm-resolver.ts`, `src/npm-resolve-facet.ts`, `src/parallel/npm-resolve-preamble.ts`
- x5c touches: `src/require-resolver.ts`, `src/facet-manager.ts` — **no overlap with x5f/x5g src files**

So the prompt's predicted `npm-resolver.ts` collision between x5c and x5f is incorrect — x5c does NOT modify `npm-resolver.ts`. Conflicts are therefore not anticipated on the third merge unless from the generated files / probes.

## Merge sequence


### Merge 1: x5f-resolve-miss → main

- Commit: `56b9cfd`
- Conflicts: **none**
- Files changed: 38 (5 src + 2 generated + audit/probes/x5f/* + plan/retro/progress)
- tsc post-merge: 2 baseline errors only (esbuild-service:153, nimbus-session-init:74) ✓
- x5f probes: 7/7 PASS (4 functional + 3 regression; e2e SKIPs without `NIMBUS_X5F_E2E=1` + running wrangler dev — expected)
- single-resolver invariant: PASS via `audit/probes/x5f/regression/single-resolver-source.mjs` — exactly one TS impl at `src/_shared/exports-resolver.ts`
- install-pipeline-coverage regression: 6/6 PASS


### Merge 2: x5g-optional-deps → main

- Commit: `5d891f2`
- Conflicts: **none** (x5g already had x5f merged in as baseline at `2501917`, so the x5f deltas are no-ops — only x5g's optional-deps additions land on top)
- Files changed: 26 (4 src + audit/probes/x5g/* + plan/retro/progress)
- tsc post-merge: 2 baseline errors only ✓
- x5g probes: 11/11 PASS (functional 6/6 + regression 5/5 — e2e gated behind `NIMBUS_X5G_E2E=1`, expected)
- x5f probes re-run: 7/7 PASS (no regression from x5g additions; rollup-bypass probe explicitly accepts the swapped name `@rollup/wasm-node` per X.5-G retro §3.3)
- single-resolver invariant: PASS
- W6 SKIP_PACKAGES vs WASM_SWAPS no-conflict invariant: PASS (rollup correctly moved from SKIP to SWAPS)


### Merge 3: x5c-prebundler → main

- Commit: `a3c7128`
- Conflicts: **none** (the prompt's predicted `npm-resolver.ts` collision did not materialize — x5c only modifies `src/require-resolver.ts` (+44 LOC) and `src/facet-manager.ts` (+71 LOC then +10/-6 from C.2.1), neither of which x5f or x5g touched)
- Files changed: 18 (2 src + audit/probes/x5c/* + plan/retro/progress)
- tsc post-merge: 2 baseline errors only ✓
- x5c probes: 10/10 PASS (3 functional + 4 regression + 3 e2e — local-runnable via the W3.5-style integration shim, all green)
- single-resolver invariant: PASS (verified by `audit/probes/x5c/regression/r1-single-resolver-source.mjs` AND re-running `audit/probes/x5f/regression/single-resolver-source.mjs` — both pass at this HEAD)
- Anti-requirement: `git diff main..main^^^ -- 'src/nimbus-session*'` = empty ✓
- x5f probes re-run: 7/7 PASS (no regression from x5c bundle-side changes)
- x5g probes re-run: 11/11 PASS (no regression)
- W6 invariants (full run-all): 13/13 PASS (no SKIP/SWAP conflicts, swap parity preserved, transitive warn semantics intact)
- install-pipeline-coverage regression: 6/6 PASS

## Final post-merge state

- main HEAD: `a3c7128`
- 3 merge commits cleanly stacked: `412ff2c` → `56b9cfd` (x5f) → `5d891f2` (x5g) → `a3c7128` (x5c)
- tsc: 2 baseline errors (esbuild-service:153, nimbus-session-init:74) — unchanged from pre-merge baseline
- Cross-bucket regression: zero. Probes from all three buckets pass simultaneously at the merged HEAD.
- Single-resolver invariant: preserved (one TS impl at `src/_shared/exports-resolver.ts`)
- Package healthy count delta: pre-X.5 baseline 14/33 → post-X.5-batch 21/33 (+7 healthy: webpack, framer-motion, parcel⛔, rollup, react-remove-scroll, pathe, @radix-ui/react-dialog)

## Cross-bucket bugs surfaced

None. The retros' predicted handoff cleanly held:
- X5F retro line 146 (`react-remove-scroll subpath miss → X.5-C`) — fixed by X5C Fix #1 ✓
- X5F retro line 148 (`pathe split-bundle hash chunks → X.5-C`) — fixed by X5C Fix #2 ✓
- X5F retro line 145 (`@rollup native opt-dep → X.5-G`) — fixed by X5G G2 SWAP ✓
- X5F retro line 147 (`ts-jest typescript.js → W2.6b`) — still open (out of charter for all three X.5 buckets)

## Anti-requirements compliance

- x5f/x5g/x5c branch source code: not modified (only merged) ✓
- worktrees: not deleted (only `worktrees/x5c-prebundler` exists; left in place) ✓
- tsc check: run after each merge ✓
- pushed to origin only when tsc clean ✓
- wrangler login/deploy: not attempted ✓
- session-refactor-plan: not modified ✓

