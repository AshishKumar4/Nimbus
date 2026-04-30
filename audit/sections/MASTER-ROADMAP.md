# Nimbus Master Roadmap — WebContainer-Class Edge OS

> **Last updated:** 2026-05-04
> **Status:** AUTONOMOUS EXECUTION MODE
> **User has stepped away.** Year-long horizon. Continue without input.

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

### Phase 1 — Parallel Foundation
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W3 | Builtin completeness + crypto correctness | `w3-builtins` | dispatching |
| W4 | npm install UX (R2 cache, pipelining) | `w4-npm-cache` | dispatching |
| W5 | Robustness (SqliteVFS LRU, OOM observability) | `w5-robustness` | dispatching |

### Phase 2 — Parallel Expansion (after Phase 1)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W6 | WASM swap registry + REJECT_INSTALL UX | `w6-native-swap` | pending |
| W8 | child_process.spawn (facet-mapped) | `w8-child-process` | pending |
| W9 | Hibernatable process logs + WS auto-response | `w9-hib-logs` | pending |

### Phase 3 — RPC Overhaul (single)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W7 | Streams over RPC (bypass 32 MiB wall) | `w7-rpc-streams` | pending |

### Phase 4 — Project Type Expansion (parallel)
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W10 | wrangler dev / CF Workers projects | `w10-wrangler-dev` | pending |
| W11 | Next/Astro/Nuxt/Remix/SvelteKit | `w11-frameworks` | pending |

### Phase 5 — Multi-Region UX
| Wave | Topic | Branch | Status |
|---|---|---|---|
| W12 | DO read replicas + smart placement | `w12-multi-region` | pending |

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

## Queued Deploys (auth-gated)

Sessions cannot deploy autonomously when wrangler OAuth lapses. Code lands on origin/<branch>; deploy is queued. When user returns + wrangler auth restored:

| Wave | Branch | Ready since | Functional tests | Acceptance gates pending prod |
|---|---|---|---|---|
| W4 | `origin/w4-npm-cache` | 2026-05-04T20:00Z | 6/6 ✅ | Mossaic cold-install p50 ≤15s, cache hit ratio ≥80% after 10 installs |
| W5 | `origin/w5-robustness` | 2026-05-04T20:06Z | tbd from retro | OOM stress on prod: zero silent kills, /api/_diag/memory v2 schema check |

**Batch deploy procedure (when user returns):**
1. `cd /workspace/lifo-edge-os && bun install` (if node_modules missing)
2. `./node_modules/.bin/wrangler login --browser=false` → user OAuths
3. For each queued branch: deploy + run e2e probes + merge to main if green
4. Update this section as each deploys
5. `./node_modules/.bin/wrangler r2 bucket create nimbus-npm-cache` and `nimbus-npm-packument-cache` if W4 batch (one-time)

The daily ops schedule (CT1) attempts auto-deploy every morning. If wrangler auth is fresh from a previous user session, it will deploy autonomously.

---
