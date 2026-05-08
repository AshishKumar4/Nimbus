# Batch Merge VIII — progress log

> Two branches merged sequentially into local `main` and pushed to `origin/main`.
> Push grant LIVE this wave (per dispatch). Order: x5t-tsjest → x5-drizzle.
> Pre-merge baseline: `origin/main` HEAD `9d4b61d` (post-Batch-Merge-VII).

## Pre-merge state

- Branch: `main`
- HEAD: `9d4b61d` (= `origin/main` HEAD)
- Working tree: clean
- tsc: 2 baseline errors (`src/esbuild-service.ts:153`, `src/nimbus-session-init.ts:74`)
- Branches in scope:
  - `origin/x5t-tsjest` tip `8108317` (3 LOC + 5 comment in `src/node-shims.ts`)
  - `origin/x5-drizzle` tip `7be65a1` (`src/npm-resolver.ts` + `src/npm-resolve-facet.ts`)

## Merge 1 — x5t-tsjest

- Command: `git merge --no-ff origin/x5t-tsjest -m "merge: x5t-tsjest — realpathSync.native shim (charter-pass; ts-jest stays ⚠ on dotfile filter)"`
- Strategy: ort
- Conflicts: **0**
- Files changed: 12 (1 src/, 11 audit/)
- src/ diff: `src/node-shims.ts` only (+8 LOC: 3 logic + 5 comment) ✓ matches retro charter
- Anti-touched files: untouched ✓
- Merge commit SHA: `b0968fd`
- Branch tip `8108317` reachable: ✓ (`git merge-base --is-ancestor origin/x5t-tsjest HEAD` == 0)
- tsc post-merge: **2 baseline errors only** (byte-identical to pre-merge baseline)
- Charter-pass status (per X5T-retro §1): ts-jest `.native` blocker GONE; NEW orthogonal blocker (`.ts-jest-digest` install-pipeline dotfile drop) surfaces; strict-✅ flip deferred to X.5-U.

## Merge 2 — x5-drizzle

- Command: `git merge --no-ff origin/x5-drizzle -m "merge: x5-drizzle — bestEffortNames soft-skip → drizzle-orm ⛔→✅ (P0 strict recovery)"`
- Strategy: ort
- Conflicts: **0**
- src/ diff vs pre-merge (post-x5t HEAD `b0968fd`):
  - `src/npm-resolver.ts` (+41 LOC)
  - `src/npm-resolve-facet.ts` (+46 LOC)
  - Total: 2 files, +87 LOC purely-additive ✓ matches retro charter (bestEffortNames Set)
- Anti-touched files: untouched ✓
- Merge commit SHA: `2f0ad00`
- Branch tip `7be65a1` reachable: ✓
- tsc post-merge: **2 baseline errors only** (byte-identical to pre-merge baseline)
- Strict ✅ recovery (per X5-drizzle retro TL;DR): drizzle-orm ⛔→✅ via bestEffortNames optional-peer subtree soft-skip; 0 W11 framework-detect regressions; framework-detect.ts NOT modified.

## Post-merge state

- Local main HEAD: `2f0ad00` (= post-roadmap commit will be the next one)
- Both branch tips reachable from main: ✓
  - `8108317` (x5t-tsjest) — `git merge-base --is-ancestor` exit 0
  - `7be65a1` (x5-drizzle) — `git merge-base --is-ancestor` exit 0
- File-region collisions across the two merges: **0** (per retros: x5t touches `src/node-shims.ts` only; x5-drizzle touches `src/npm-resolver.ts` + `src/npm-resolve-facet.ts` only — no overlap)
- tsc final: 2 baseline errors only, byte-identical to `9d4b61d` baseline
- Combined src/ delta vs `9d4b61d`: 3 files
  - `src/node-shims.ts` (+8 LOC, x5t)
  - `src/npm-resolver.ts` (+41 LOC, drizzle)
  - `src/npm-resolve-facet.ts` (+46 LOC, drizzle)

## Push

- Command: `git push origin main`
- Result: **200 OK** — `9d4b61d..cfdc651  main -> main` (push grant LIVE per dispatch)
- Final HEAD on `origin/main`: `cfdc651` (= local `main` HEAD, lockstep)
- Push range: 4 commits (`b0968fd` x5t merge → `2f0ad00` x5-drizzle merge → `cfdc651` roadmap-update audit commit, plus the 2 branch-tip commits already on origin via the merge transitives)
- Both x5t-tsjest tip `8108317` and x5-drizzle tip `7be65a1` reachable from `origin/main` HEAD ✓

