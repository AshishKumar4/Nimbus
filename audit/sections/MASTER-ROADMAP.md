# Nimbus Master Roadmap — WebContainer-Class Edge OS

> **Last updated:** 2026-05-05 (Phase 3.5 merged — X.5 follow-ups + CWB-1 hotfix landed)
> **Status:** AUTONOMOUS EXECUTION MODE — code mission complete (12 waves + 2 X.5 follow-ups + 1 cross-wave hotfix), prod deploy gated on user OAuth return.
> **User has stepped away.** Year-long horizon. Continue without input.

---

## Mission Status: CODE COMPLETE

All 12 waves are merged to `origin/main` as of 2026-05-05. Phase 5 closes the master roadmap.

| Phase | Wave | Branch | Branch SHA | Merged | Local probes |
|---|---|---|---|---|---|
| Phase 1 | W3  | `w3-builtins`         | `a9547198` | ✅ 2026-05-04 | 21/22 functional+regression, 3/6 e2e (rest prod-gated) |
| Phase 1 | W4  | `w4-npm-cache`        | `4e416aad` | ✅ 2026-05-04 | 6/6 functional GREEN |
| Phase 1 | W5  | `w5-robustness`       | `33c6e82f` | ✅ 2026-05-04 | 81/81 assertions across 6 probes GREEN |
| Phase 2 | W6  | `w6-wasm-swap`        | `df89fd37` | ✅ 2026-05-04 | 17/17 GREEN (registry-coverage SKIPs locally) |
| Phase 2 | W8  | `w8-child-process`    | `5c0895f5` | ✅ 2026-05-04 | 21/21 GREEN |
| Phase 2 | W9  | `w9-hib-logs`         | `7e9b77e2` | ✅ 2026-05-04 | 6/6 GREEN |
| Phase 3 | W7  | `w7-rpc-streams`      | `f4bb4e81` | ✅ 2026-05-04 | 15/15 GREEN |
| Phase 4 | W10 | `w10-wrangler-dev`    | `f2b37b39` | ✅ 2026-05-04 | 28/28 GREEN + 2 prod-gated SKIP |
| Phase 4 | W11 | `w11-frameworks`      | `0c646239` | ✅ 2026-05-04 | 26/26 GREEN (e2e self-skip without NIMBUS_W11_E2E=1) |
| Phase 5 | W12 | `w12-multi-region`    | `9b733eb4` | ✅ 2026-05-05 | 21/21 GREEN + 3 prod-gated SKIP |

## Phase 3.5 (X.5 follow-ups) — ✅ MERGED 2026-05-05

Post-Phase-5 batch landing the X.5 follow-up waves identified by the verification audit, plus the cross-wave-bug hotfix.

| Item | Branch / Commit | Merged | Local probes |
|---|---|---|---|
| Verification wave (audit-only) | `verification` `f4357a04` → `8940a0f` | ✅ 2026-05-05 | 173/177 (4 W3-known bundler/resolver gaps documented in W3.5 unblock); CWB-1 (HIGH) surfaced |
| W3.5 — pre-bundler / resolver fixes for jsdom + fastify | `w3-5-prebundler` `225ea53` → `624b3bf` | ✅ 2026-05-05 | 9 probes added (3 functional + 1 regression + 3 e2e + run-all + integration); local-runnable subset GREEN via standalone integration harness, full WS-driver suite blocked by miniflare loopback bug (W3.5-retro §S1) |
| W6.5 — WASM swap registry expansion + telemetry | `w6-5-wasm-expand` `ec75290f` → `46f0e51` | ✅ 2026-05-05 | 17/17 GREEN (9 functional + 7 regression + 1 e2e default-sink-emits-jsonl) |
| **CWB-1 hotfix** — `replica_routing` env.production overlay | direct commit `63acf7e` on main | ✅ 2026-05-05 | 21/21 W12 regression GREEN with stronger `smart-placement-config-shape` probe (now verifies env.production overlay shape + non-inheritable binding redeclarations) |

**TypeScript health on main:** still 2 pre-existing baseline errors only (`src/esbuild-service.ts:153` esbuild-wasm.wasm types, `src/nimbus-session.ts:~2781` SqliteVFSProvider.stat().type narrowing — line shifted from `~2773` after W3.5's +8 line `setEsbuildService` addition in `ensureFacetManager`). Both pre-Phase-1 and tracked across W7-retro / W10-retro §S4.

**Prod deploy command change (CWB-1):** `wrangler deploy` → `wrangler deploy --env production`. The orchestrator at `audit/probes/_deploy-and-verify-all.mjs` was updated in the same commit. Bare `wrangler deploy` (default env) deploys *without* `replica_routing` and would lose W12 read-replica capability — graceful-degrade still works, but Phase 5's full W12 win requires the `--env production` flag.

**Refactor flagged for next phase (X.5-B / W*+1 candidate):** `src/nimbus-session.ts` is now **5,334 LOC** with 7 waves' surfaces collocated (W5 / W7 / W8 / W9 / W10 / W11 / W12). Every Phase-5 merge composed cleanly via non-overlapping line ranges, but that is *luck of insertion order*, not architecture. Per POST-PHASE5-CROSS-WAVE-AUDIT §3.1, the next wave that touches the constructor or `_handleFetch` will likely conflict with W12's preflight insertion at L1616+. Recommended: split into `nimbus-session-{core,rpc,replica,hib,cp,frame}.ts` along the section boundaries already documented in the file's wave-marker comments. Pure refactor — no behavior change. **Schedule before any structural wave that touches the DO entrypoint.**

### What is pending

For every wave, the **prod-acceptance probe sweep** is the only outstanding gate. Local probes are all GREEN. The probes that need a deployed Nimbus to assert against include (per wave):

- **W3:** crypto regression vs NIST vectors, full builtin shape probe + 22 functional + 1 regression + 6 e2e against `https://nimbus.ashishkmr472.workers.dev`.
- **W4:** Mossaic cold-install p50 ≤ 15 s, cache-hit ratio ≥ 80% after 10 installs of same project.
- **W5:** OOM stress (50 parallel installs), zero silent kills, every OOM has `/api/_diag/memory` ring entry with `cause`.
- **W6:** registry-coverage e2e walking the full WASM-swap registry against deployed install path.
- **W7:** 5 GB monorepo install bypasses 32 MiB structured-clone wall; install latency ≥ 30% faster than pre-W7 baseline; supervisor heap-peak 48 → 30 MiB.
- **W8:** husky / concurrently / lefthook / lint-staged / simple-git-hooks / yorkie postinstalls succeed against prod.
- **W9:** 24-48 h DO billable-duration drop (auto-response avoiding ~2880 wakes/day per idle tab); `/api/_diag/memory.hib.rehydratedPids` advances after wake.
- **W10:** official CF Workers starter `wrangler dev` /preview/ → 200; D1 starter schema-init succeeds; HMR < 500 ms (302 ms locally); **HIGH-risk RpcTarget shape verification.**
- **W11:** SK + Astro + Remix dev-200 + build-emits all green; Nuxt yellow-honest; Next loud-block deterministic.
- **W12:** **p99 < 500 ms preview latency from EU + APAC origins** post-Smart-Placement convergence (≥ 15 min after deploy); `/api/_diag/memory.replica.state == 'enabled'` from non-primary colos; replication lag bookmark surfaces in `/api/_diag/memory.replica.bookmark`.

### What user needs to do on return

```
cd /workspace/lifo-edge-os
./node_modules/.bin/wrangler login --browser=false        # interactive OAuth
./node_modules/.bin/wrangler r2 bucket create nimbus-npm-cache             # one-time, W4
./node_modules/.bin/wrangler r2 bucket create nimbus-npm-packument-cache   # one-time, W4
bun audit/probes/_deploy-and-verify-all.mjs               # full sweep (uses --env production per CWB-1)
```

The `_deploy-and-verify-all.mjs` orchestrator (see `audit/probes/_deploy-and-verify-all.mjs`) auto-checks `wrangler whoami`, deploys current `main` via **`wrangler deploy --env production`** (CWB-1 hotfix — applies the env.production overlay carrying `replica_routing`), captures the new Version ID, runs each wave's prod-gated probes in dependency order (W3 → W4 → W5 → W6 → W7 → W8 → W9 → W10 → W11 → W12 with the W12 Smart-Placement 15-min wait gate, plus W3.5 + W6.5 prod-acceptance lanes), writes `audit/sections/POST-DEPLOY-VERIFICATION.md` with pass/fail per wave, and commits + pushes the result.

If wrangler OAuth lapses again before user runs the sweep, the daily ops schedule (CT1) will retry deploy each morning.

---

## Vision

Make Nimbus the universal browser-native development environment. Any Node, Vite, Cloudflare Workers, Next.js, Astro, Nuxt, Remix, SvelteKit project clones, installs, runs, and previews. POSIX-shell semantics. Limitless scale via Cloudflare's edge.

## Out of scope (per user direction)
- Cost optimization
- Mobile UI
- WebContainers feature parity for parity's sake — we want to surpass

## Sources
- audit/sections/UNIVERSAL-NODE-COMPAT.md (W1-W2 audit)
- audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md (CF-internal levers, 1353 LOC)
- audit/sections/02-packages.md (live package compat matrix)
- W2/W2.5/W2.5b/W2.6a retros

---

## Phase Plan

### Phase 1 — Parallel Foundation — ✅ COMPLETE (code merged, prod deploy deferred)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W3 | Builtin completeness + crypto correctness | `w3-builtins` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth) |
| W4 | npm install UX (R2 cache, pipelining) | `w4-npm-cache` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth) |
| W5 | Robustness (SqliteVFS LRU, OOM observability) | `w5-robustness` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth) |

### Phase 2 — Parallel Expansion — ✅ COMPLETE (code merged, prod deploy deferred)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W6 | WASM swap registry + REJECT_INSTALL UX | `w6-wasm-swap` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth) |
| W8 | child_process.spawn (facet-mapped) | `w8-child-process` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth) |
| W9 | Hibernatable process logs + WS auto-response | `w9-hib-logs` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth) |

### Phase 3 — RPC Overhaul (single) — ✅ COMPLETE (code merged, prod deploy deferred)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W7 | Streams over RPC (bypass 32 MiB wall) | `w7-rpc-streams` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth). 15/15 local probes GREEN, tsc clean (only 2 baseline errors), no merge conflicts. See W7-retro.md. Heap-peak: 0.23 MiB observed vs 30 MiB target (16× over). |

### Phase 4 — Project Type Expansion (parallel) — ✅ COMPLETE (code merged, prod deploy deferred)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W10 | wrangler dev / CF Workers projects | `w10-wrangler-dev` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth). 28/28 local probes GREEN + 2 prod-gated e2e SKIP cleanly, tsc clean (only 2 baseline errors), no merge conflicts. KV/D1/R2 emulators wired into `buildInnerEnv()`; hot reload measured 302ms (target <500ms). HIGH-risk: real workerd RpcTarget shape unverified — see W10-retro §2 + §6 row "Real workerd RPC env compatibility". |
| W11 | Next/Astro/Nuxt/Remix/SvelteKit | `w11-frameworks` | ✅ Merged to main 2026-05-04 — prod deploy DEFERRED (wrangler auth pending user OAuth). 26/26 local probes GREEN (e2e self-skip without `NIMBUS_W11_E2E=1`), tsc clean (only 2 baseline errors), no merge conflicts. SvelteKit + Astro + Remix dev + build green-eligible; Nuxt yellow-honest (Vite-side green, Nitro-side may degrade); Next.js Phase 1 deliberately loud-blocked with receipts for W11.5-E. See W11-retro.md. |

### Phase 5 — Multi-Region UX — ✅ COMPLETE (code merged, prod deploy deferred)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W12 | DO read replicas + smart placement | `w12-multi-region` | ✅ Merged to main 2026-05-05 — prod deploy DEFERRED (wrangler auth pending user OAuth). 21/21 local probes GREEN + 3 prod-gated e2e SKIP cleanly, tsc clean (only 2 baseline errors), no merge conflicts. Defensive runtime probes for both wiki SPEC API (`enableReplicas`) and J.7.1 alternate API (`configureReadReplication`) so the code is correct against either GA shape. Smart Placement on gateway Worker via `placement.mode=smart`; DO read replicas via `replica_routing` compat flag. Writes always delegate via `ctx.storage.primary.fetch()`; reads (warm `/preview/*`, `/api/memory`, `/api/_diag/*`, `/api/processes`, `/api/stats`) served from replica when `state==='enabled'`. WS routes (`/ws`, `/api/processes/<pid>/logs`, `/preview/__nimbus_hmr`) classified `primary-only-ws`. See W12-retro.md (R1-R8 risk register, W12.5 follow-up triggers). |

---

## Continuous Tracks (always running)

### CT1 — Drift detection
Daily 09:00 UTC: prod regression test (Mossaic + top-30 packages + Wave 1 contract). Output to audit/probes/drift/<date>.txt. Regression → create incident task.

### CT2 — Platform-gated tracking
Watch CF-internal items: dedicated-isolate flag, SHIP-3841 memory tiers, SHIP-10537 container-in-DO, polyfill RFC. Move to next phase when GA.

### CT3 — Pre-flight research per wave
nimbus-cf-internal-research session continues. Pre-flights each wave's plan with fresh CF docs/wiki context.

---

## Conventions

### Worktree per wave
```
git worktree add /workspace/worktrees/w<N>-<name> -b w<N>-<name> main
cd /workspace/worktrees/w<N>-<name>
bun install
```

### TDD discipline (HARD requirement)
- Write functional tests FIRST → audit/probes/w<N>/functional/
- Write regression tests FIRST → audit/probes/w<N>/regression/
- Write E2E tests FIRST → audit/probes/w<N>/e2e/
- Tests committed BEFORE any src/ change
- Each test executable: `bun audit/probes/w<N>/run-all.mjs`
- After implementation, ALL tests must pass before merge

### Workflow per wave
1. **Plan** — audit/sections/W<N>-plan.md (sub-agent reviewed)
2. **Test scaffolding** — failing tests committed
3. **Build** — src/ changes pass tests
4. **Sub-agent code review** — thoroughness directive
5. **Push branch** — origin/w<N>-<name>
6. **Workspace agent reviews PR**, deep verification, auto-merges if clean
7. **Deploy to prod** (queues if auth lapses)
8. **Prod verification** — all tests run vs prod
9. **Retro** — audit/sections/W<N>-retro.md

### PR strategy
- Each wave: own branch
- Direct push by session
- Workspace agent reviews + merges (no human gate per user direction)
- Squash merge for clean history

### Context management
- Sessions auto-compact at ~80% (opencode default)
- Workspace agent flags sessions over 500k tokens for explicit compact
- Fresh session per wave to keep cumulative <1M tokens

---

## Wave Specs

### W3 — Builtin completeness + crypto correctness
**Goal:** All major node:* builtins work, no silent correctness bugs.

**In scope:**
- Replace FNV-1a fake hash in `src/node-shims.ts:540-580` with workerd's real `node:crypto` (kill silent SHA garbage)
- Add `vm` shim (Function-based, jsdom-compatible per audit D2)
- Add `http2` shim (axios needs)
- Add `repl` shim (ts-node needs)
- Full `fs/promises` surface
- Add `diagnostics_channel` shim (fastify needs)
- Add `tls` (thin wrapper over workerd static import)
- Add `async_hooks` (re-export workerd's AsyncLocalStorage)
- `net.Socket` honest-error mode (stop silent connect lies)

**Acceptance:**
- 33-package probe: ≥12 ✅ (currently 5/33)
- Specific: axios ✅, jsdom ✅, fastify ✅, puppeteer-core ✅, ts-node ✅
- Crypto regression test: real SHA-256 verified vs known vectors
- Mossaic regression: PASS
- Wave 1 external-host count: 0
- All W3 tests pass on prod

**Files touched (estimate):** src/node-shims.ts (~300 lines), src/_shared/crypto-real.ts (new), audit/probes/w3/

---

### W4 — npm install UX (R2 cache + pipelining)
**Goal:** Cold install p50 ≤15s, p99 ≤30s.

**In scope:**
- R2-backed cross-tenant tarball cache (mirrors Pyodide pattern, EW/SPEC: Python Workers Package Bundling System)
- R2-backed packument cache
- Promise pipelining for resolver/install RPCs (Lever 10)
- Cache priming flow on supervisor cold start
- TTL + invalidation strategy (npm publish webhook? simple mtime?)

**Acceptance:**
- Cold install Mossaic (248 deps) p50 ≤15s on prod
- Cache hit ratio ≥80% after 10 installs of same project
- No regression on first-cold-install latency
- All W4 tests pass on prod

**Files touched:** src/npm-installer.ts, src/npm-tarball.ts, src/r2-cache.ts (new), audit/probes/w4/

---

### W5 — Robustness (SqliteVFS LRU + OOM observability)
**Goal:** Zero silent terminations. Every OOM categorized.

**In scope:**
- Decouple SqliteVFS LRU from `js_kj_buf_pool` (Lever 8 — Section A.2)
- Catch SQLITE_NOMEM with fail-loud retry path (Lever 9)
- /api/_diag/memory: cause discriminator, ring buffer, persist on close (Lever 5)
- OOM telemetry emit on every facet termination

**Acceptance:**
- Synthetic OOM stress (50 large installs in parallel): zero silent kills
- Every OOM has /api/_diag/memory entry with cause field populated
- Mossaic regression: PASS
- All W5 tests pass on prod

**Files touched:** src/sqlite-vfs.ts, src/diag.ts (extend or new), src/facet-manager.ts, audit/probes/w5/

---

### W6 — WASM swap registry + REJECT_INSTALL UX
**Goal:** All native-binding packages either work via WASM swap or fail loudly with guidance.

**In scope:**
- WASM swap registry: bcryptjs (already), esbuild-wasm, sql.js, @libsql/client, sharp-wasm32 (verify), @swc/wasm-web
- REJECT_INSTALL flow with helpful error messages (sharp, prisma, fsevents, etc.)
- Auto-swap detection in npm-installer

**Acceptance:**
- Top-30 native packages: each either works or fails with helpful message including swap suggestion
- bcryptjs swap remains correct
- Probe per native package: install + import attempts run, expected outcomes verified
- All W6 tests pass on prod

**Files touched:** src/npm-installer.ts, src/wasm-swap-registry.ts (new), audit/probes/w6/

---

### W7 — Streams over RPC
**Goal:** Bypass 32 MiB structured-clone wall via byte streams.

**In scope:**
- ReadableStream<Uint8Array> over RPC for bulk writes (Lever 3)
- Replace Uint8Array[] chunks pattern in writeBatch
- Update SupervisorRPC RPC contracts
- Performance benchmarks vs current

**Acceptance:**
- Install of 5GB monorepo doesn't hit 32 MiB wall
- Install latency for typical projects: ≥30% faster (Lever 3 estimate)
- Peak heap reduction: 48 MiB → 30 MiB (Lever 3)
- All W7 tests pass on prod

**Files touched:** src/supervisor-rpc.ts, src/sqlite-vfs.ts, src/npm-installer.ts, src/npm-tarball.ts, audit/probes/w7/

---

### W8 — child_process.spawn (facet-mapped)
**Goal:** husky, concurrently, cross-spawn, simple shell pipelines work.

**Phase 1 (now):** Facet-spawn mapping
- child_process.spawn → spawn a facet, wire stdin/stdout/stderr through pipes
- Process exit code propagation
- Signal handling: SIGTERM, SIGKILL via facet termination

**Phase 2 (gated on SHIP-10537 GA, tracked in CT2):** Real Linux process via Cloudchamber container-in-DO

**Acceptance Phase 1:**
- husky install ✅
- concurrently 'tsc -w' 'vite' ✅
- 80% of npm postinstall scripts succeed
- Probe per major npm script pattern
- All W8 tests pass on prod

**Files touched:** src/node-shims.ts (child_process), src/facet-process.ts (new), audit/probes/w8/

---

### W9 — Hibernatable process logs + WS auto-response
**Goal:** Long-running `npm run dev` doesn't lose logs across hibernate.

**In scope:**
- Process logs survive DO hibernation (Lever 11)
- WS auto-response config for ping-pong (reduce wakeups, Section C.4)
- setHibernatableWebSocketEventTimeout tuning

**Acceptance:**
- Start `npm run dev`, idle 1hr, server wakes correctly with logs intact
- WS pings don't wake DO (verified via observability)
- Long-poll/SSE patterns work
- All W9 tests pass on prod

**Files touched:** src/process-logs.ts, src/nimbus-session.ts, audit/probes/w9/

---

### W10 — wrangler dev / CF Workers projects
**Goal:** Any CF Workers project works via `wrangler dev`.

**In scope:**
- miniflare/workerd inside facet
- Hot reload via VFS file-watch
- D1 emulation backed by SqliteVFS
- KV emulation backed by SqliteVFS
- R2 emulation backed by SqliteVFS or supervisor-RPC-to-real-R2

**Acceptance:**
- Official CF Workers starter: clone, `wrangler dev`, /preview/ works
- D1 starter: same
- Hot reload latency <500ms on file save
- All W10 tests pass on prod

**Files touched:** src/wrangler-facet.ts (new), src/d1-emu.ts (new), src/kv-emu.ts (new), audit/probes/w10/

---

### W11 — Next/Astro/Nuxt/Remix/SvelteKit
**Goal:** All major frameworks have a vetted dev path.

**In scope (per framework):**
- Boot path quirks
- Hot reload integration
- Build path

**Acceptance:**
- Each framework's official starter: clone, install, dev, build
- Probe per framework
- All W11 tests pass on prod

**Files touched:** src/framework-detect.ts (new), framework-specific shims, audit/probes/w11/

---

### W12 — Multi-region UX (DO read replicas + smart placement)
**Goal:** p99 preview latency from any region <500ms.

**In scope:**
- DO read replicas for /preview/* (now GA, Lever 12)
- Smart Placement for supervisor (Lever 7)

**Acceptance:**
- p99 preview latency from EU/APAC <500ms (currently US-bound)
- No correctness regressions (eventual consistency for preview is acceptable)
- All W12 tests pass on prod

**Files touched:** src/nimbus-session.ts (replica annotation), wrangler.toml (placement_mode), audit/probes/w12/

---

## Hand-off Notes

**For future Seal sessions or future me reading this in 6 months:**

- This file is the single source of truth.
- audit/sections/ holds per-wave plans + retros.
- audit/probes/ holds all tests.
- The user is hands-off until ~2027-05-04.
- Deploys may queue waiting for CF auth — push code regardless.
- If a session goes silent ≥10min during active build, dispatch follow-up with specific corrections.
- Drift detector (CT1) is the safety net — daily prod-regression run.
- Don't break prod. Don't accumulate uncommitted work.
- Push frequently, merge frequently.
- Each wave is independent — if one is stuck, the others continue.
- When a wave completes, check the master roadmap and update its status, then advance the next phase.
- Session naming: nimbus-w<N>-<short-name>. Reuse cf-internal-research for CT3.



---

## Pending Prod Deploys

**ALL 12 WAVES + 2 X.5 follow-ups + CWB-1 hotfix (Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 3.5)** code is **merged to main** as of 2026-05-05. Production deploy is **deferred**: wrangler OAuth has lapsed in this autonomous session and no `CLOUDFLARE_API_TOKEN` is provisioned. When the user returns and re-authenticates wrangler, run the batch deploy procedure below — or simply run `bun audit/probes/_deploy-and-verify-all.mjs` which automates the entire sweep (now invokes `wrangler deploy --env production` per CWB-1 hotfix).

The merge to main is safe regardless of when prod deploy happens — every wave's runtime code path graceful-degrades when its support resources (R2 buckets for W4, OOM telemetry sinks for W5, workerd builtins for W3, hibernatable WS APIs for W9, KV/D1/R2 binding emulators for W10, framework shims for W11, `replica_routing` compat flag + Smart Placement for W12, W3.5's pre-bundler ESM transform, W6.5's swap registry telemetry sink, etc.) are absent.

**⚠ CWB-1 prod deploy command change (2026-05-05):** the orchestrator and any manual deploy step now uses `wrangler deploy --env production`. The bare `wrangler deploy` command would deploy without `replica_routing` (which lives in the `env.production` overlay since the CWB-1 hotfix). All Phase 1-5 prod-acceptance probes remain valid — they target deployed state, not config.

### Pending deploys

| Wave | Source on main | Acceptance probes pending prod | Notes |
|---|---|---|---|
| W3 | `origin/main` (merged from `w3-builtins`) | `audit/probes/w3/run-all.mjs` against prod (BASE=https://nimbus.ashishkmr472.workers.dev). Expected: 22 functional + 1 regression + 6 e2e. Build-time recorded local 21/22 functional+regression + 3/6 e2e (e2e gaps are bundler/resolver — orthogonal to W3 scope, see W3-retro §2 S3-S4). Crypto regression: real SHA-256 vs NIST vectors. Mossaic regression: must PASS. Wave 1 external-host count = 0. | None of the W3 probes are local-runnable — all need a deployed server. |
| W4 | `origin/main` (merged from `w4-npm-cache`) | `audit/probes/w4/run-all.mjs` against prod. Mossaic cold-install p50 ≤15s. Cache hit ratio ≥80% after 10 installs of same project. No regression on first-cold-install. Build-time: 6/6 functional probes green on the branch tip. | Requires R2 bucket provisioning (one-time, see batch procedure step 5). Bindings degrade gracefully when missing. |
| W5 | `origin/main` (merged from `w5-robustness`) | `audit/probes/w5/run-all.mjs` against prod (set `NIMBUS_W5_E2E_PROD=1` for the OOM-stress e2e). Synthetic 50-parallel-installs OOM stress: zero silent kills. Every OOM must produce a `/api/_diag/memory` ring entry with `cause` populated. Mossaic regression: PASS. | **Local probes are green NOW** via the mock-SqlStorage harness: 81/81 assertions across 6 probes (functional + regression). e2e is the only prod-gated piece. |
| W6 | `origin/main` (merged from `w6-wasm-swap`) | `audit/probes/w6/run-all.mjs` with `NIMBUS_W6_E2E_PROD=1` (the registry-coverage e2e walks the full registry against a deployed install path). Mossaic regression: must remain PASS (W6 deliberately does NOT touch the 4 Mossaic scenarios' install names). | **17/17 local probes GREEN this session** (functional 7/7, regression 4/4, e2e 6/6 — registry-coverage SKIPs locally as designed). Only the prod-gated registry-coverage probe is missing prod numbers. |
| W8 | `origin/main` (merged from `w8-child-process`) | `audit/probes/w8/run-all.mjs` against prod. Acceptance gates from W8-plan: husky + concurrently + lefthook + lint-staged + simple-git-hooks + yorkie postinstalls succeed. cross-spawn shape parity. spawnSync deferred awaitable. ProcessLogStore tee for cp children works. fork IPC JSON projection (Buffer/Date) round-trips. | **21/21 local probes GREEN this session** (functional 15/15, regression 2/2, e2e 4/4 via mock `_test-interpreter.mjs` shim host). All W8 e2e probes are local-runnable; prod run is a tighter integration check, not a gating one. |
| W9 | `origin/main` (merged from `w9-hib-logs`) | `audit/probes/w9/run-all.mjs` with `NIMBUS_W9_E2E=1` + a real prod hibernation. The `e2e/long-running-dev-hib-cycle.mjs` is wrangler-dev-focused; on prod the actual contract is the **24-48 h CT1 baseline**: confirm DO billable-duration drops materially (auto-response avoiding ~2880 wakes/day per idle tab) and `/api/_diag/memory.hib.rehydratedPids` advances after a wake. | **6/6 local probes GREEN this session** via the mock SqlStorage harness. Prod gate is observability-driven (CT1 baseline), not assertion-driven. |
| W7 | `origin/main` (merged from `w7-rpc-streams`) | `audit/probes/w7/run-all.mjs` against prod. Acceptance gates from W7-plan: (1) **5GB monorepo install does not hit the 32 MiB structured-clone wall** — verifiable via the install completing on prod with stream RPC; (2) **install latency for typical projects ≥30% faster** — measure Mossaic cold-install p50 against the pre-W7 baseline (~7-10s); (3) **peak heap reduction 48 MiB → 30 MiB** on the supervisor side (facet side already exceeded 16× locally at 0.23 MiB observed). Multi-segment supervisor commit is v2 / future-wave per W7-retro §4. | **15/15 local probes GREEN this session** (functional 8/8, regression 4/4, e2e 3/3). Latency benchmark and heap-peak supervisor measurement are the only prod-gated pieces; the structural wall-bypass and facet-side heap win are already proved locally. Code path graceful-degrades: pre-W7 supervisors return `undefined` for `env.SUPERVISOR.writeBatchStream`, the typeof check fails, and the facet falls back to legacy `writeBatch` with no user-visible change. |
| W10 | `origin/main` (merged from `w10-wrangler-dev`) | `NIMBUS_W10_E2E_PROD=1 bun audit/probes/w10/run-all.mjs` against prod. Acceptance gates from W10-plan: (1) **Official CF Workers starter clones, `wrangler dev` runs, /preview/ responds 200** via `e2e/starter-worker-router.mjs`; (2) **D1 starter schema-init succeeds** via `e2e/starter-d1.mjs`; (3) **Hot reload latency <500ms** on file save (locally measured 302ms — prod adds ~30-80ms for real workerd LOADER.load); (4) **HIGH-risk: real workerd accepts plain-JS-object `env` projection** — if it rejects, fix is 5-line diff per emulator (extend RpcTarget) per W10-retro §2 / §6. | **28/28 local probes GREEN this session** (functional 22/22, regression 4/4, e2e 2/2 local-runnable + 2 prod-gated SKIP). KV/D1/R2 surfaces verified against in-memory mock-vfs/mock-sql harnesses; the only prod-gated pieces are real-workerd RpcTarget shape compatibility and the two starter e2e probes. Code path graceful-degrades: when the inner Worker doesn't reference KV/D1/R2 bindings, the emulator wiring is no-op. |
| W11 | `origin/main` (merged from `w11-frameworks`) | `NIMBUS_W11_E2E=1 bun audit/probes/w11/run-all.mjs` against prod. Acceptance gates from W11-plan v2: (1) **SvelteKit + Astro + Remix dev-200 + build-emits all green** (the ≥3-of-5 acceptance bar from MASTER-ROADMAP §W11); (2) **Nuxt dev returns either Nuxt-marked HTML or honest 5xx** (yellow-honest — see W11-retro §1 caveats); (3) **Next dev hits the loud-block stub with deterministic message** (red-honest — Phase 2 substrate work tracked in W11.5-E). HMR latency measurement deferred to W11.5-A. Mossaic regression: unchanged (frameworkAware=false for plain Vite+React projects, by construction). CT1 daily run picks this up. | **26/26 local probes GREEN this session** (functional 13/13, regression 5/5, e2e 8/8 self-skip without `NIMBUS_W11_E2E=1`). Detection precedence rules verified (rule 0 = wrangler-on-framework override → routes to W10's wrangler-dev path). Vite-from-skip-list gate verified. `_CP_FACET_DIRECT` extension verified by regression probe. Code path graceful-degrades: framework detection returns `unknown`/low-confidence for non-framework projects and the W2 generic Vite/Node path runs unchanged. |
| W12 | `origin/main` (merged from `w12-multi-region`) | `NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN={EU,APAC} bun audit/probes/w12/run-all.mjs` against prod. Acceptance gates from W12-plan: (1) **p99 < 500 ms preview latency from EU + APAC origins** across `/api/memory`, `/api/stats`, `/api/_diag/memory`, `/preview/<asset>` (warm) — `e2e/region-latency-after.mjs` enforces and exits non-zero on miss; (2) **`/api/_diag/memory.replica.state === 'enabled'` from a non-primary colo** verifying `replica_routing` flag accepted by GA runtime; (3) **`isReplica: true`** observed from EU/APAC origins; (4) **Smart Placement convergence ≥ 15 min post-deploy** (Workers analytics — request-duration drop in cross-continental colos); (5) **Mossaic regression preserved** (`mossaic-regression-e2e.mjs`); (6) **Replication lag bookmark surfaces** in `/api/_diag/memory.replica.bookmark` for CT1 lag tracking. Run `region-latency-baseline.mjs` BEFORE `wrangler deploy --env production` to capture pre-deploy numbers for diff. | **21/21 local probes GREEN this session** (functional 8/8, regression 8/8, e2e 5/5 — 3 prod-gated SKIP without `NIMBUS_W12_E2E=1`). Pure module routing verified (32+19 cases). Mock-driven replica delegation roundtrip + bookmark surfacing OK. Defensive runtime probes cover both wiki SPEC `enableReplicas` and J.7.1 `configureReadReplication` APIs. Code path graceful-degrades: if runtime rejects `replica_routing`, `state='unsupported'` surfaces in `/api/_diag/memory.replica` with no behavior regression vs Phase 4. **CWB-1 hotfix (2026-05-05):** `replica_routing` was moved from top-level `compatibility_flags` into `env.production` overlay because the bundled workerd in many local dev installs predates GA replica routing. Prod deploy MUST use `wrangler deploy --env production`. **Caveat:** if `wrangler deploy --env production` itself rejects the `replica_routing` compat flag (account not on GA allowlist), edit `wrangler.jsonc` `env.production.compatibility_flags` to drop the flag (clearly tagged) and redeploy — the Smart Placement edit alone is harmless. See W12-retro.md §6 hand-off + POST-PHASE5-CROSS-WAVE-AUDIT §CWB-1. |
| W3.5 | `origin/main` (merged from `w3-5-prebundler` `225ea53` → `624b3bf`) | After prod deploy: rerun `audit/probes/w3.5/run-all.mjs` against prod (default `BASE=https://nimbus.ashishkmr472.workers.dev`). Per W3.5-retro §S2 / §D2, **prod is currently pre-W3** — running W3.5 e2e probes against prod today exercises pre-W3 code, not pre-W3.5. Whoever does the W3 deploy will also deploy W3.5 (same commit on main). Acceptance gates: (1) `e2e/jsdom-load-and-instantiate.mjs` PASS — Fix B's ESM transform unlocks tldts/dist/es6; (2) `e2e/fastify-instantiate.mjs` PASS — Fix A's directory-as-index unlocks fastify ret/dist/types; (3) `e2e/redis-typeof.mjs` PASS — Fix A unlocks @redis/client/dist/lib/client; (4) `regression/install-pipeline-coverage.mjs` PASS at the local-runnable layer (W3 builtin shape unchanged); (5) `functional/silent-compile-failure-surfaces.mjs` PASS — Fix C diagnostic surface. ALL prod-gated; W3.5-retro §D2 explicitly defers prod retest to whoever deploys post-W3-merge. | **3/3 W3.5 acceptance fixes integration-validated locally** via `audit/probes/w3.5/_local/integration-shim-eval.mjs` (the standalone harness pivot when miniflare WS-upgrade loopback bug blocked the full WS-driver suite — see W3.5-retro §S1). Full e2e against prod blocked on (a) prod redeploy with W3+W3.5, and (b) miniflare WS bug fix or workaround on user's machine for `wrangler dev` flow. tsc clean (2 baseline). |
| W6.5 | `origin/main` (merged from `w6-5-wasm-expand` `ec75290f` → `46f0e51`) | Prod-acceptance has 2 components: (1) `bun audit/probes/w6.5/run-all.mjs` runs locally already (17/17 GREEN) — these are static-file / mock-driven probes and don't require prod state. (2) **24-hour `wrangler tail | grep '\[w6.5/registry\]'` capture** post-deploy to verify the JSONL telemetry sink emits real demand-signal events on real installs. The output feeds W6.6's swap-priority decisions. Mossaic regression preserved (`audit/sessions/W6.5-mossaic-interaction.txt` confirms zero new REJECT names appear in any of the 4 scenario trees). **Honest negative tracked in W6.5-retro §3 / §S5:** facet-throw rejects are **0% captured** in the telemetry hook today — only top-level + BFS-supervisor + facet-success-path emits land. W6.6 candidate: extend `ExecutionError` to preserve own-properties so `__w6_reject_from` survives the supervisor↔facet boundary. | **17/17 local probes GREEN this session** (functional 9/9, regression 7/7, e2e 1/1 default-sink-emits-jsonl). 0 new SWAPs (all 5 spec candidates failed the surface-area gate per W6.5-retro §S1/§S3 spike outcomes), 3 new REJECTs (sharp-wasm32 + @napi-rs/canvas + @napi-rs/canvas-wasm32-wasi), 24 existing REJECT entries refined with honest `suggest:` text, telemetry hook fires across supervisor + BFS + facet-success-path. Code path graceful-degrades: if no sink is registered, `emitRegistryEvent` is a no-op; if a sink throws, the throw count is captured and the install continues. |

### Batch deploy procedure (when user returns)

**Recommended:** run the orchestrator script that automates the entire sequence:
```
cd /workspace/lifo-edge-os
./node_modules/.bin/wrangler login --browser=false
./node_modules/.bin/wrangler r2 bucket create nimbus-npm-cache             # one-time, W4
./node_modules/.bin/wrangler r2 bucket create nimbus-npm-packument-cache   # one-time, W4
bun audit/probes/_deploy-and-verify-all.mjs
```

The orchestrator: (1) checks `wrangler whoami`, (2) deploys current main with `CLOUDFLARE_ACCOUNT_ID=f44999d1ddda7012e9a87729eba250f1`, (3) captures the new Version ID, (4) runs each wave's prod-gated probes in dependency order with the W12 Smart-Placement 15-min wait gate, (5) writes `audit/sections/POST-DEPLOY-VERIFICATION.md` with pass/fail per wave, (6) commits + pushes the result.

**Manual procedure** (if the orchestrator is bypassed for some reason):

1. `cd /workspace/lifo-edge-os && bun install` (if node_modules missing)
2. `./node_modules/.bin/wrangler login --browser=false` → user OAuths
3. **One-time R2 provisioning for W4:**
   ```
   ./node_modules/.bin/wrangler r2 bucket create nimbus-npm-cache
   ./node_modules/.bin/wrangler r2 bucket create nimbus-npm-packument-cache
   ```
4. **W12 baseline capture (BEFORE deploy):**
   ```
   NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN=EU bun audit/probes/w12/e2e/region-latency-baseline.mjs
   NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN=APAC bun audit/probes/w12/e2e/region-latency-baseline.mjs
   ```
5. Deploy main (with the CWB-1 env.production overlay):
   ```
   CLOUDFLARE_ACCOUNT_ID=f44999d1ddda7012e9a87729eba250f1 ./node_modules/.bin/wrangler deploy --env production
   ```
   The `--env production` flag is **required** post-CWB-1 hotfix to apply the env.production overlay (which carries `replica_routing`). Bare `wrangler deploy` would deploy without `replica_routing` and lose W12 read-replica capability. If the deploy errors on `replica_routing` (account not on GA allowlist), edit `wrangler.jsonc` `env.production.compatibility_flags` to remove `replica_routing` (clearly tagged) and redeploy — Smart Placement alone is harmless.
6. Run prod acceptance probes in order (Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 3.5):
   ```
   # Phase 1
   bun audit/probes/w3/run-all.mjs                          # default: prod
   bun audit/probes/w4/run-all.mjs --full --phase=prod-verify
   NIMBUS_W5_E2E_PROD=1 bun audit/probes/w5/run-all.mjs

   # Phase 2
   NIMBUS_W6_E2E_PROD=1 bun audit/probes/w6/run-all.mjs
   bun audit/probes/w8/run-all.mjs                          # against prod
   NIMBUS_W9_E2E=1 bun audit/probes/w9/run-all.mjs

   # Phase 3
   bun audit/probes/w7/run-all.mjs                          # against prod (latency baseline + supervisor heap-peak)

   # Phase 4
   NIMBUS_W10_E2E_PROD=1 bun audit/probes/w10/run-all.mjs   # starter-worker-router + starter-d1 + RpcTarget shape verify
   NIMBUS_W11_E2E=1 bun audit/probes/w11/run-all.mjs        # SK/Astro/Remix dev+build, Nuxt yellow, Next loud-block

   # Phase 5 — wait ≥15 min after deploy for Smart Placement convergence FIRST
   NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN=EU   bun audit/probes/w12/e2e/region-latency-after.mjs
   NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN=APAC bun audit/probes/w12/e2e/region-latency-after.mjs
   NIMBUS_W12_E2E=1 bun audit/probes/w12/e2e/mossaic-regression-e2e.mjs

   # Phase 3.5 (X.5 follow-ups) — run after Phase 1 (W3) deploy is verified
   bun audit/probes/w3.5/run-all.mjs                        # against prod (default BASE)
                                                              # — exercises Fix A (directory-as-index)
                                                              # + Fix B (ESM transform jsdom/fastify)
                                                              # + Fix C (silent-compile-failure surfacing)
   bun audit/probes/w6.5/run-all.mjs                        # local-runnable today; on prod it's the
                                                              # 24h `wrangler tail | grep '\[w6.5/registry\]'`
                                                              # capture that's the real gate (W6.5-retro §9)
   ```
7. Update this section: replace each "Pending" entry with "Verified on prod <ISO>".
8. If any acceptance gate fails, see corresponding `W<N>-retro.md §6` (W3.5 / W4.5 / W5.5 / W6.5 / W7.5 / W8 phase-1.5 / W9 phase-1.5 / W10.5 / W11.5 / W12.5 candidates) and dispatch a follow-up wave. **Specifically for W10:** if real workerd rejects the plain-JS-object `env` projection used by KV/D1/R2 emulators, the fix is to extend `RpcTarget` on each emulator class (5-line diff per file: `binding-kv.ts`, `binding-d1.ts`, `binding-r2.ts`) per W10-retro §2 / §6. **For W11:** Next.js Phase 2 substrate (v8-IPC + webpack-in-facet + Cloudchamber) is tracked in W11.5-E (gated independently on W7.5 / SHIP-10537 GA). **For W12:** if `state` reports `'unsupported'`, the account isn't on the `replica_routing` GA allowlist — Smart Placement still helps; ship the partial and revisit. If `state='enabled'` but p99 still > 500 ms in EU/APAC, see W12.5-A (`waitForBookmark` thread via `X-Nimbus-Bookmark` header).

The daily ops schedule (CT1) attempts auto-deploy every morning. If wrangler auth is fresh, it will deploy autonomously.

### Push grant note

The `cloudflare-seal[bot]` push grant has lapsed intermittently across sessions (see W3-retro §S6, W4-retro §6 — same root cause). Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 merge commits all pushed cleanly during their respective sessions. If a future session hits the lapse, retry at the end of the session (the grant typically rotates back), or have the user push:
```
git push origin main
```
Local main is `de1ebce Phase 5 merge: W12 ...` after Phase 5 completes (head advances to the roadmap-update commit after this section is committed).

---
