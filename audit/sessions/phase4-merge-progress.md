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

## W10 merge — `7c55d2a`

**Command:** `git merge --no-ff origin/w10-wrangler-dev -m "Phase 4 merge: W10 ..."`

**Conflicts:** none. Clean 3-way merge — W10's merge base was `8b9ac44` (Phase 3 merge commit, already on main), so the merge surface was just the 10 W10 commits applied on top of the W11 merge.

**Files added:** 4 src/ (`binding-kv.ts`, `binding-d1.ts`, `binding-r2.ts`, `project-detect.ts`), 36 W10 probes/fixtures, plan + retro + progress.
**Files modified:** `src/nimbus-session.ts` (trim WRANGLER_UNSUPPORTED_CONFIG_FIELDS + re-export detectCloudflareWorkersProject), `src/nimbus-wrangler.ts` (extend buildInnerEnv with KV/D1/R2 categories + .nimbus/ skip + test seams), `audit/sections/MASTER-ROADMAP.md`.

The two cross-section concerns from pre-merge analysis resolved cleanly:
- **`src/nimbus-session.ts` non-overlap confirmed:** W11 edited `_CP_FACET_DIRECT` and added a MOTD line in `initSession`. W10 trimmed `WRANGLER_UNSUPPORTED_CONFIG_FIELDS` and added `export { detectCloudflareWorkersProject }`. Different sections of the file. Git's 3-way merge resolved without textual conflict.
- **MASTER-ROADMAP collision:** Both branches modified §W10/W11 status lines and Pending Prod Deploys table. The W11 merge already absorbed those edits; W10's merge then layered its own status line on top without conflict (W11 only flipped its own row; W10 only flipped its own row).

**tsc post-merge:** 2 errors (baseline only). Line drift on `src/nimbus-session.ts` (2641→2646, expected — W10 added export at the top of the file). NO new errors.

**Local probes post-merge:**
- `audit/probes/w10/run-all.mjs` — 28/28 GREEN + 2 prod-gated e2e SKIP cleanly (`starter-worker-router`, `starter-d1`).
- `audit/probes/w11/run-all.mjs` — 26/26 still GREEN (re-verified post-W10).
- `audit/probes/w7/run-all.mjs` — 15/15 still GREEN (re-verified post-W10; the W10 changes are emulator-additive and don't touch the streams-over-RPC contract).

**Push:** `c521135..7c55d2a  main -> main` — clean.

---

## Final state

- **main HEAD:** `7c55d2a` (Phase 4 merge: W10) after this section is committed; will become `<roadmap-commit>` after roadmap update.
- **tsc:** 2 baseline errors — `src/esbuild-service.ts:153` (esbuild-wasm.wasm types) and `src/nimbus-session.ts:2646` (SqliteVFSProvider.stat().type narrowing). Both pre-Phase 4 and documented across W7-retro / W10-retro §S4.
- **Merge surface health:** 0 conflicts across W11 + W10 merges. 3-way merge correctly preserved Phase 3 artifacts (W7 probes, W7 plan/retro, phase3-merge-progress.md, src/_shared/w7-frame.ts) that W11's diff stat misleadingly showed as "deleted" because W11's branch base predated Phase 3.
- **Wave probe status (local):**
  - W7: 15/15 GREEN
  - W10: 28/28 GREEN + 2 prod-gated SKIP
  - W11: 26/26 GREEN (e2e self-skip without `NIMBUS_W11_E2E=1`)
- **Pending prod deploys (deferred per spec — wrangler OAuth lapsed):** W3 + W4 + W5 + W6 + W7 + W8 + W9 (Phases 1-3) + W10 + W11 (Phase 4). All listed in MASTER-ROADMAP "Pending Prod Deploys" table after roadmap update.
- **Anti-requirements honored:** no wave-branch source modification, no worktree deletion, every push gated on tsc-clean (only 2 baseline errors), no wrangler login or deploy attempted.

## What's ready for prod deploy (when user re-OAuths wrangler)

When the user runs `./node_modules/.bin/wrangler login --browser=false` and re-authenticates, the batch deploy procedure in MASTER-ROADMAP "Pending Prod Deploys §" runs the prod e2e suites for all 9 waves. W10 specifically needs the **HIGH-risk RpcTarget verification** flagged in W10-retro §2 — if real workerd rejects the plain-JS-object pattern on `env`, the fix is a 5-line diff per emulator (extend `RpcTarget`). The W10 prod e2e probes (`starter-worker-router`, `starter-d1`) are the safety net for that. W11 needs `NIMBUS_W11_E2E=1` against a deployed Nimbus to capture HMR latency numbers and cement the SK/Astro/Remix green; Nuxt is yellow-honest, Next is loud-blocked by design.

