# Phase 3.5 Merge Progress — Autonomous Orchestrator

> **Session:** 2026-05-05 (autonomous, build-mode).
> **Base:** `d948457` on main (Phase 5 merged).
> **Mission:** merge X.5 follow-ups (`verification`, `w3-5-prebundler`, `w6-5-wasm-expand`) + apply the CWB-1 hotfix (replica_routing → env.production overlay) + update the master roadmap.
> **Constraints:** no src/ edits in wave branches; tsc must remain ≤ 2 baseline errors; W12 regression probes + `install-pipeline-coverage` must pass before each push; no prod deploy attempted.

## Baseline (pre-merges)

- `git rev-parse HEAD`: `d948457` (Phase 5 merge commit).
- `bun x tsc --noEmit`: 2 expected baseline errors (`src/esbuild-service.ts:153` esbuild-wasm decl + `src/nimbus-session.ts:2773` SqliteVFSProvider mount type narrowing). No new errors.
- Branches to merge: `origin/verification` `f4357a04`, `origin/w3-5-prebundler` `225ea53`, `origin/w6-5-wasm-expand` `ec75290f`.

## Merge log

### Merge 1 — `origin/verification` @ `f4357a04` → main

- **Pre-merge survey:** verification branch touches `wrangler.jsonc` (10-line mitigation) plus 87 audit/ files. No src/ edits. Verified by `git diff --name-only d948457...origin/verification | grep -v '^audit/'` returning only `wrangler.jsonc`.
- **Merge command:** `git merge --no-ff origin/verification -m "Phase 3.5 merge: verification wave …"`. **Conflicts:** none.
- **Wrangler revert + amend:** `git checkout d948457 -- wrangler.jsonc && git commit --amend --no-edit`. Verification's CWB-1 mitigation (`replica_routing` removed from `compatibility_flags`) was deliberately NOT landed on main — proper env-overlay fix queued for the CWB-1 hotfix commit later in this batch.
- **Verification:** `git diff d948457 HEAD -- wrangler.jsonc` empty (byte-identical to pre-merge state).
- **tsc:** 2 baseline errors only (esbuild-wasm decl + SqliteVFSProvider mount type). No new.
- **W12 regression suite:** 21/21 GREEN (8 functional + 8 regression + 5 e2e — 3 prod-gated SKIP cleanly).
- **install-pipeline-coverage:** 3/4 (fastify, express, redis PASS; ts-jest FAIL: missing typescript — **pre-existing baseline at `d948457`**, verified by detached-HEAD checkout-and-rerun. Documented in POST-PHASE5-VERIFICATION §1 Phase D resolve-miss bucket. Not introduced by this merge).
- **HEAD after merge+amend:** `8940a0f Phase 3.5 merge: verification wave (post-phase5 audit + cross-wave findings)`.
- **Push:** `git push origin main` → `d948457..8940a0f main -> main` clean.

### Merge 2 — `origin/w3-5-prebundler` @ `225ea53` → main

- **Pre-merge survey:** W3.5 touches 3 src/ files: `src/facet-manager.ts` (+184), `src/nimbus-session.ts` (+8), `src/node-shims.ts` (+41/-3). All additive, all at non-overlapping line ranges with the prior 12 waves (verified by grep marker review against POST-PHASE5-CROSS-WAVE-AUDIT §1 collision matrix). +9 audit/probes/w3.5/ files.
- **Merge command:** `git merge --no-ff origin/w3-5-prebundler -m "Phase 3.5 merge: W3.5 …"`. **Conflicts:** none.
- **tsc:** 2 baseline errors only. Note: `src/nimbus-session.ts` baseline error line shifted from `2773` → `2781` due to W3.5's +8 line `setEsbuildService` addition in `ensureFacetManager` — same SqliteVFSProvider mount-type narrowing, same root cause, just renumbered.
- **W12 regression suite:** 21/21 GREEN. All prior-wave surface-presence probes (`w5-diag-memory-shape`, `w7-stream-rpc-still-present`, `w9-hib-config-still-present`, `w10-bindings-still-injected`, `w11-frameworks-detect-unchanged`, `wrangler-jsonc-still-valid`) confirm W3.5 didn't undo any prior wave.
- **install-pipeline-coverage:** 3/4 (same pre-existing baseline ts-jest FAIL — not a W3.5 regression).
- **HEAD:** `624b3bf Phase 3.5 merge: W3.5 (pre-bundler / resolver fixes for jsdom + fastify)`.
- **Push:** `git push origin main` → `8940a0f..624b3bf main -> main` clean.

### Merge 3 — `origin/w6-5-wasm-expand` @ `ec75290f` → main

- **Pre-merge survey:** W6.5 touches 6 src/ files: `src/index.ts` (+19 default sink), `src/npm-installer.ts` (+23 import + facet-events drain at L588 + supervisor swap/reject emit at L968), `src/npm-resolve-facet.ts` (+41 facet-side emit), `src/npm-resolver.ts` (+11 BFS emit), `src/parallel/npm-resolve-preamble.ts` (+76 `__pendingEvents` + `__EMIT_EVENT` helper), `src/wasm-swap-registry.ts` (+184 RegistryEvent type, sink, emitRegistryEvent). All hunks are additive at non-overlapping ranges per POST-PHASE5-CROSS-WAVE-AUDIT §1's predicted insertion points.
- **Anticipated conflict (per orchestrator brief):** "Conflicts expected with W3.5 in npm-installer.ts." **Actual:** none — W3.5 did not touch `npm-installer.ts` (W3.5-retro §1 confirms only `facet-manager.ts`, `nimbus-session.ts`, `node-shims.ts` were modified). The brief over-anticipated; W3.5's surface is fully orthogonal to W6.5's. Merge composed cleanly with no `<<<<<<<` markers.
- **Merge command:** `git merge --no-ff origin/w6-5-wasm-expand -m "Phase 3.5 merge: W6.5 …"`. **Conflicts:** none.
- **tsc:** 2 baseline errors only. Same shape (`src/nimbus-session.ts:2781` SqliteVFSProvider mount-type narrowing).
- **W12 regression suite:** 21/21 GREEN. All prior-wave surface-presence regressions hold post-W6.5.
- **W6.5 own probe suite:** 17/17 GREEN (9 functional + 7 regression + 1 e2e default-sink-emits-jsonl).
- **install-pipeline-coverage:** 3/4 (same pre-existing baseline ts-jest FAIL — W6.5 does not regress it).
- **W3.5 own probe suite:** runs against `BASE=https://nimbus.ashishkmr472.workers.dev` and reports failures because prod is pre-W3 (per W3.5-retro §S2 / §D2 — prod has not been deployed since W3 merged). This is the documented expected behavior, NOT a W6.5-introduced regression. Will be resolved by the next prod deploy. The orchestrator's gate is W12 regression + install-pipeline-coverage; both green.
- **HEAD:** `46f0e51 Phase 3.5 merge: W6.5 (WASM swap registry expansion + transitive policy + telemetry)`.
- **Push:** initial attempt returned `Permission denied to cloudflare-seal[bot]` (known intermittent push-grant lapse, see W3-retro §S6 / W3.5-retro §S6). Will retry at end of session per the established pattern.

### Commit 4 — CWB-1 hotfix: env.production overlay for replica_routing

- **Trigger:** `audit/sections/POST-PHASE5-CROSS-WAVE-AUDIT.md` §CWB-1 — `replica_routing` in top-level `compatibility_flags` breaks every local `wrangler dev` (no `--env`) whose bundled workerd predates GA replica routing. Workerd rejects the flag at config-time before the DO can even be constructed; the runtime probe in `tryEnableReplicas()` never runs.
- **Design (env-overlay shape used):**
  - **Top-level `compatibility_flags`:** `["nodejs_compat", "experimental"]` — works for `wrangler dev` (default env path).
  - **New `env.production` block** with the full superset `["nodejs_compat", "experimental", "replica_routing"]` plus `name: "nimbus"` (so the deployed Worker stays named `nimbus`, not `nimbus-production`), and re-declarations of non-inheritable bindings: `vars`, `durable_objects`, `r2_buckets`. Inheritable keys (`placement`, `assets`, `alias`, `worker_loaders`, `compatibility_date`, `main`) inherit from top level. `migrations` is top-level-only per wrangler docs and shared across all envs.
  - **`audit/probes/_deploy-and-verify-all.mjs`:** orchestrator updated to invoke `wrangler deploy --env production` (was: bare `wrangler deploy`). Error guidance updated to point at the env-overlay shape if a binding goes missing.
  - **`audit/probes/w12/functional/smart-placement-config-shape.mjs`:** updated to verify (a) top-level does NOT include `replica_routing`, (b) `env.production.compatibility_flags` includes the full superset, (c) `env.production` redeclares the 3 non-inheritable bindings (`durable_objects`, `r2_buckets`, `vars`) and overrides `name` to `nimbus`.
- **Graceful-degrade verification:** local `wrangler dev` (top-level config, no `replica_routing`) → `replica.state='unsupported'` per `src/replica-routing.ts`'s `tryEnableReplicas` defensive runtime probe. Pre-W12 single-primary fallback path active. No behaviour regression for non-W12 features.
- **tsc:** 2 baseline errors only.
- **W12 regression suite:** 21/21 GREEN — including the now-stronger `smart-placement-config-shape` and `wrangler-jsonc-still-valid`.
- **W6.5 own probe suite:** 17/17 GREEN.
- **install-pipeline-coverage:** 3/4 (same pre-existing baseline).
- **wrangler.jsonc round-trip parse:** OK via Node `JSON.parse(strip-comments(raw))`. Top-level: `nodejs_compat, experimental`. `env.production.compatibility_flags`: `nodejs_compat, experimental, replica_routing`.
- **HEAD:** `63acf7e fix(cwb-1): move replica_routing to env.production overlay`.



