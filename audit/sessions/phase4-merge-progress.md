# Phase 4 Merge — Progress Log

> Autonomous orchestrator session, 2026-05-04. User stepped away.
> Goal: merge `origin/w10-wrangler-dev` + `origin/w11-frameworks` to main, push, update MASTER-ROADMAP. Production deploy DEFERRED (wrangler OAuth pending user return).

---

## Pre-merge state

- main HEAD: `f88665d` (audit: Phase 3 merged to main + master roadmap updated)
- `origin/w10-wrangler-dev` HEAD: `f2b37b3` (10 commits past `f88665d`; merge-base `8b9ac44` = Phase 3 merge commit)
- `origin/w11-frameworks` HEAD: `0c64623` (4 commits past `f88665d`; merge-base `7a835ed` = pre-Phase 3)
- Baseline tsc errors: 2 (esbuild-wasm.wasm module resolution + SqliteVFSProvider FileType narrowing). Both pre-existing, documented in W10-retro §S4 and W7-retro/Phase 3.

W11's diff stat against `f88665d` showed `D` lines for the entire `audit/probes/w7/` tree, `audit/sections/W7-{plan,retro}.md`, `audit/sessions/{W7,phase3-merge}-progress.md`, and `src/_shared/w7-frame.ts`. These are diff-only artifacts — W11's merge base is pre-Phase 3, so the 3-way merge correctly sees those files as "added on main, untouched on W11" and **keeps them**. Verified post-merge.

## Merge order rationale

Per user spec: W11 first (smaller surface, mostly new files). W10 second (touches `nimbus-wrangler.ts`, `nimbus-session.ts`, `project-detect.ts`).

Risk surface for collisions: both modify `src/nimbus-session.ts`. W11's edits are confined to `_CP_FACET_DIRECT` (line ~413) and a MOTD line in `initSession`. W10 trims `WRANGLER_UNSUPPORTED_CONFIG_FIELDS` and re-exports `detectCloudflareWorkersProject` from `src/project-detect.ts`. Different sections — no logical overlap expected.

---

## W11 merge — `c521135`

**Command:** `git merge --no-ff origin/w11-frameworks -m "Phase 4 merge: W11 ..."`

**Conflicts:** none. Clean 3-way merge.

**Files added by merge:** 57 (5 src/, 26 probes, 5 fixture trees, plan + retro + progress).
**Files modified:** `src/nimbus-session.ts`, `src/npm-install-batch-facet.ts`, `src/npm-installer.ts`, `src/npm-resolve-facet.ts`, `src/npm-resolver.ts`, `src/parallel/generated-workers.ts`, `src/parallel/npm-resolve-preamble.ts`, `src/seed-project.ts`, `src/sqlite-vfs.ts`, `src/supervisor-rpc.ts`, `scripts/bundle-facet-workers.mjs`, `audit/sections/MASTER-ROADMAP.md`.

**tsc post-merge:** 2 errors (baseline only). Identical errors, line number drift on nimbus-session.ts (2637→2641, expected — W11 added _CP_FACET_DIRECT entries above). NO new errors.

**Local probes post-merge:**
- `audit/probes/w11/run-all.mjs` — 26/26 GREEN (all functional + regression + e2e local-skip-eligible probes pass).
- `audit/probes/w7/run-all.mjs` — 15/15 GREEN (W7 regression suite intact; the W11 changes to npm-installer.ts and supervisor-rpc.ts didn't break the streams-over-RPC contract).

**Push:** `f88665d..c521135  main -> main` — clean.

---

## W10 merge — pending

(written after W10 merge completes)

---

## Final state

(written after MASTER-ROADMAP commit)
