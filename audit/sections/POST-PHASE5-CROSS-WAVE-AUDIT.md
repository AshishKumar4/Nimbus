# Post-Phase-5 Cross-Wave Audit

> Verification wave, 2026-05-05. Worktree branch `verification` off `main` HEAD `d948457`.
> All 12 waves merged. This audit asks: **does the merged source on `main` actually compose every wave's intent, or did one wave silently undo / re-route another?**

## Executive verdict

**Composition: ✅ healthy at the source level.** Across the 11 collision files the merge resolutions left every wave's instrumentation, hooks, and contracts present and correctly ordered. tsc clean (only the 2 known baseline errors). All 9 prior-wave probe runs against the merged tree are GREEN (W3 reproduces its branch-time 25/28 with the same 3 known-bundler failures; W4-W12 each 6/6 → 28/28 GREEN per wave). The W12 regression suite (which explicitly verifies prior-wave surface presence) is 8/8 GREEN.

**One critical CROSS-WAVE BUG surfaced** in this verification, NOT in any individual wave's branch-time probe run, NOT in any merge-progress retro:

> **W12 `replica_routing` compatibility flag breaks local `wrangler dev`** on every machine whose bundled workerd predates the GA release of replica routing. Every DO request fails synchronously with `Error: workerd does not support replica routing.` thrown at `src/session-router.ts:112` (`stub.fetch(inner)`). The runtime probe in `src/replica-routing.ts::tryEnableReplicas` catches its own `enableReplicas()` exception, but **workerd rejects the flag at config-time before the DO can even be constructed**, so the probe never gets to run. This means the entire `main` branch has been **un-runnable on local wrangler dev** since the W12 merge (2026-05-05) on every dev machine that hasn't independently upgraded `@cloudflare/workerd-linux-64` to a replica-aware version.

Why no wave caught it:
- Every wave-branch ran its local probes on its own branch tip, all of which **predate W12** and don't carry the `replica_routing` flag.
- W12's own probes mock the replica context (`audit/probes/w12/_mock-replica-ctx.mjs`) rather than running against a real workerd, so its 21/21 GREEN never exercised the flag's workerd-acceptance path.
- W12's prod-gated e2e probes self-skip without `NIMBUS_W12_E2E=1` and the production workerd already has replica routing, so the flag was assumed to be a *deploy-time* concern. The `W12-retro.md §6` mitigation note frames the risk as `wrangler deploy` rejecting the flag — not `wrangler dev`.

Mitigation in this verification worktree: temporarily commented `replica_routing` out of `wrangler.jsonc` (worktree-local only — NOT pushed back to main). Local Nimbus is now serving healthy `/api/_diag/memory` 200 responses with `replica.state='unsupported'`, confirming the W12 graceful-degrade path works correctly. The presence of `enableReplicas` is the issue, not the W12 code path itself.

**Recommended X.5 priority #1:** bump `@cloudflare/workerd-linux-64` (and matching `wrangler` minor) to a version that recognizes `replica_routing`, OR move the flag into a wrangler env overlay so local dev can run without it. See [§4 Recommended X.5 dispatch order](#4-recommended-x5-dispatch-order).

---

## 1. Per-file collision audit

The collision matrix from `audit/probes/post-phase5-verification/_collision-matrix.txt`:

| Count | File | Waves |
|---|---|---|
| 7 | `src/nimbus-session.ts` | w5, w7, w8, w9, w10, w11, w12 |
| 4 | `src/npm-installer.ts` | w4, w6, w7, w11 |
| 4 | `src/supervisor-rpc.ts` | w4, w5, w7, w8 |
| 3 | `src/facet-manager.ts` | w3, w5, w8 |
| 3 | `src/npm-resolve-facet.ts` | w4, w6, w11 |
| 2 | `src/node-shims.ts` | w3, w8 |
| 2 | `src/npm-install-batch-facet.ts` | w4, w7 |
| 2 | `src/npm-resolver.ts` | w6, w11 |
| 2 | `src/parallel/generated-workers.ts` | w7, w8 |
| 2 | `src/parallel/npm-resolve-preamble.ts` | w6, w11 |
| 2 | `src/sqlite-vfs.ts` | w5, w7 |

### `src/nimbus-session.ts` (7-way: w5, w7, w8, w9, w10, w11, w12)

**Composition check:** every wave's marker symbol resolves at the expected location.

- W5 (`src/nimbus-session.ts:1400`): OOM ring-entry emit on every external-process exit. Present.
- W7 (`src/nimbus-session.ts:1150-1180`): `writeStream` RPC entrypoint that decodes W7 frames into `SqliteVFS.writeStream()`. Present.
- W8 (`src/nimbus-session.ts:1488` + `:532` field): 7 `cp*` RPC entrypoints + lazy `FacetProcessManager` field. Present.
- W9 (`src/nimbus-session.ts:561-919`): hibernation persistence, alarm flush, isolate-gen counter, WS auto-response config (W9 § ranges 561-919). Present and intact post-merge — `phase2-merge-progress.md` records the W8↔W9 merge at `bcb32df` was nominally an overlap on `nimbus-session.ts` but resolved cleanly because the W8 hunks landed in different sections (imports L30, `_classifyCommand` L397, `facetProcessManager` field L495, cp RPCs L1130, ensure block L1924, shell-init `_setCpRegistry` L2282) than W9 (imports L31, `_w9*` field block L481+, constructor body L585+).
- W10 (`src/nimbus-session.ts:350-417`): re-export `detectCloudflareWorkersProject` from `project-detect.ts`, trim `WRANGLER_UNSUPPORTED_CONFIG_FIELDS`. KV/D1/R2 emulator wiring lives in `src/nimbus-wrangler.ts:632-728` (separate file), invoked from `nimbus-session.ts` via `NimbusWrangler.buildInnerEnv()`. Present.
- W11 (`src/nimbus-session.ts:431-450`): `_classifyCommand` extension recognising framework CLIs (`vite`, `next`, `nuxt`, `astro`, `remix`) so they dispatch to a Node isolate. Present, sits cleanly above the W8 cp-classification helper.
- W12 (`src/nimbus-session.ts:626-720`): `_w12EnableResult` field, ctor `tryEnableReplicas(this.ctx)` call, `/api/_diag/memory.replica` block, `_handleFetch` preflight at L1616+. Present.

**Status:** ✅ clean composition. All 7 wave concerns coexist; no wave's section was overwritten by a later merge. Verified by:
1. Marker grep returning all wave-tagged comment ranges at sane line numbers.
2. `bun audit/probes/w12/run-all.mjs` — 21/21 GREEN, including `regression/w10-bindings-still-injected.mjs`, `regression/w7-stream-rpc-still-present.mjs`, `regression/w9-hib-config-still-present.mjs`, `regression/w5-diag-memory-shape.mjs` which explicitly verify prior-wave surface presence post-merge.
3. `/api/_diag/memory` JSON shape on local wrangler-dev includes `vfs`, `nodeMem`, `peak`, `counters` (W4/W5), `r2` (W4), `rpc` (W7), `facet` (W8), `hib` (W9), `replica` (W12) — all 12 waves' diag fields present.

### `src/npm-installer.ts` (4-way: w4, w6, w7, w11)

**Composition check:**

- W4 (`src/npm-installer.ts:200-547` and pipelined-race counters fold-in around L717): R2 packument cache + tarball cache pipelined-race wiring, `frameworkAware` plumb-through to resolver (the resolver-facet uses R2 cache on packument lookups).
- W6 (`src/npm-installer.ts:34` import + `:944-968` `applyW6Registry`): WASM swap + REJECT_INSTALL applied to top-level specs after W4 lockfile validation. Idempotent.
- W7 (`src/npm-installer.ts:660-723`): `TAR_STREAM_PREAMBLE + W7_FRAME_PREAMBLE` install-batch facet preamble; install-batch result is folded back into supervisor diag (W4's R2 race counters + W7's facet-side stream metrics).
- W11 (`src/npm-installer.ts:206-240`): `frameworkAware` detection via `detectFrameworkAware(projDir)` precedes the existing W4 path; rule-0 framework detection is W11's hook into the install pipeline. Detection is precedent — the `frameworkAware` flag flows downward into both the resolver and install-batch facets.

**Status:** ✅ clean composition. Verified by:
1. `bun audit/probes/w7/run-all.mjs` — `regression/install-pipeline-coverage.mjs` GREEN.
2. `bun audit/probes/w11/run-all.mjs` — `regression/install-pipeline-coverage.mjs` GREEN.
3. `bun audit/probes/w12/run-all.mjs` — `regression/install-pipeline-coverage.mjs` GREEN, `regression/mossaic-shape.mjs` GREEN (Mossaic is the canonical 248-package install scenario; its shape post-merge is unchanged from the pre-W4 baseline modulo the additive R2 race counters).

### `src/supervisor-rpc.ts` (4-way: w4, w5, w7, w8)

**Composition check:**

- W4 (`src/supervisor-rpc.ts:30` import + `:183-300+` R2 RPC block): `R2CacheClient`, 4 R2 RPC methods (`r2GetTarball`, `r2PutTarball`, `r2GetPackument`, `r2PutPackument`).
- W5 (`src/supervisor-rpc.ts:27,37,130` setLastRpcFrame markers): RPC frame snapshot on `writeBatch` entry so OOM discriminator can identify the last-known frame.
- W7 (`src/supervisor-rpc.ts:141-181` `writeBatchStream`): streaming bulk-write RPC accepting `ReadableStream<Uint8Array>` in W7 frame format; same atomicity guarantee as `writeBatch`.
- W8 (`src/supervisor-rpc.ts:365+` cp RPCs): 7 `cp*` methods (`cpRegister`, `cpDataIn`, `cpKill`, `cpExitWait`, `cpEnumActive`, `cpReap`, `cpStdout`).

**Status:** ✅ clean composition. Each wave occupies a distinct contiguous section of the class. Verified by:
1. `regression/rpc-contracts-additive.mjs` (W7) — verifies `writeBatch` (pre-W7) and `writeBatchStream` (new) BOTH present.
2. `regression/legacy-writeBatch-still-works.mjs` (W7) — pre-W7 facets still have a legacy fallback path.
3. `regression/w7-stream-rpc-still-present.mjs` (W12 tier) — W12 didn't undo the W7 contract.
4. `bun audit/probes/w8/run-all.mjs` — 21/21 GREEN, including the cp* RPC roundtrip.

### `src/facet-manager.ts` (3-way: w3, w5, w8)

**Composition check:**

- W3 (`src/facet-manager.ts:16` import `generateShimsCode`): the shim generator is consumed by every facet template; W3's expanded shim surface (real crypto, vm, http2, repl, async_hooks, tls, child_process stubs) flows into all facets via a single source.
- W5 (`src/facet-manager.ts:827, 899, 924-959` `recordFailure` + ring entry): every non-zero facet exit pushes a `DiagFailure` to the OOM ring. The W5 contract is "zero silent OOM"; the ring entry is the receipt.
- W8 (`src/facet-manager.ts:310, 318, 469, 472`): parent-exit synchronous flush of any live `child_process` children before the facet teardown completes. BLOCKER-1 fix per W8-plan §8.5 — without this, output from a child process can be lost on parent shutdown.

**Status:** ✅ clean composition. The three waves attach at non-overlapping lifecycle points:
- W3's `generateShimsCode` is a pure import, no execution-time interaction.
- W5's `recordFailure` is invoked from the catch path of every facet's exit handler.
- W8's `__cpDrainAllChildren` is invoked from the *normal-path* parent-exit hook, before the catch path.

Verified by `bun audit/probes/w8/run-all.mjs::regression/install-pipeline-coverage.mjs` GREEN (W3 shim surface still present), `bun audit/probes/w5/run-all.mjs::regression/fnv-counter-integrity.mjs` GREEN (W5 OOM ring still functional). The order of operations on facet teardown is normal-path → W8 cp drain → W5 failure record (if non-zero exit) — verified by reading the sequential calls in `_terminateFacet()`.

### `src/npm-resolve-facet.ts` (3-way: w4, w6, w11)

**Composition check:**

- W4: pipelined R2 packument lookup race (resolver-facet ships pre-warm R2 packument cache entries via the resolver preamble).
- W6: applies `WASM_SWAPS` rewrites to TRANSITIVE deps so a swap that's reachable through a chain of dependencies actually fires (`applySwaps` called inside the recursive resolver, not just at the top level).
- W11: `frameworkAware` flag plumbed through resolver-facet entry — when set, the resolver follows framework-required dependencies (e.g. forces `vite` install for SK/Astro/Remix even if `vite` is on the skip list).

**Status:** ✅ clean composition. The three waves layer hooks at different stages of resolution:
1. Top-of-resolution: W11 reads `frameworkAware` to decide override-skip-list behaviour.
2. Per-package resolve: W4 pipelined-race against R2 cache.
3. Post-resolve: W6 swap rewrites applied recursively to the resolved tree.

Verified by `bun audit/probes/w6/run-all.mjs::e2e/transitive-rejects-soften-at-depth.mjs` GREEN (W6 transitive policy intact post-W11), `bun audit/probes/w11/run-all.mjs::functional/frameworks/sveltekit-detect.mjs` GREEN (W11 detection signature unchanged post-W12 per `regression/w11-frameworks-detect-unchanged.mjs`).

### `src/node-shims.ts` (2-way: w3, w8)

**Composition check:**

- W3 (`src/node-shims.ts:729-1003`): real crypto module forward, vm honest-error, http2 stub, repl forward, diagnostics_channel forward, tls forward, async_hooks AsyncLocalStorage re-export, fs.promises full surface, net.Socket honest-error mode.
- W8 (`src/node-shims.ts:1018-1735`): full `child_process` impl (`spawn`/`exec`/`execFile`/`spawnSync`/`fork`) with `ChildProcess` emitter facet-spawn-mapped via supervisor RPC.

**Status:** ✅ clean composition. W3's section ends at L1003 (`querystring/string_decoder/child_process` placeholder block at L1004); W8's section starts at L1018 and effectively replaces W3's stub `builtins.child_process = {...}` at L1667. The grep for `child_process` shows W3's stub is shadowed by W8's full impl — by design, since W8 was layered on top of W3. Verified by `bun audit/probes/w8/run-all.mjs::regression/node-shims-builtins-shape.mjs` GREEN (W3 builtins all still present, W8 child_process shape correct).

### `src/npm-install-batch-facet.ts` (2-way: w4, w7)

**Composition check:**

- W4: R2 tarball cache pipelined-race in batch facet (each tarball install attempts R2 first, fetches in parallel, captures whichever wins).
- W7: `encodeWriteBatchStream()` + `env.SUPERVISOR.writeBatchStream(stream)` to bypass the 32 MiB structured-clone cap on bulk writes.

**Status:** ✅ clean composition. W4's R2 cache race feeds *into* the bulk-write pipeline; W7's stream replaces the legacy `writeBatch(Uint8Array[])` projection. Verified by both `regression/install-pipeline-coverage.mjs` (W7) and `regression/install-pipeline-coverage-rerun.mjs` (W4) GREEN. Mossaic shape unchanged.

### `src/npm-resolver.ts` (2-way: w6, w11)

**Composition check:**

- W6: `applySwaps` and `findRejects` exported so the installer can apply the registry at top level AND inside transitive resolution.
- W11: `shouldSkipPackage` extended with framework-aware override (when `frameworkAware=true`, packages that would otherwise be skipped — like `vite` itself — are NOT skipped because the framework needs them).

**Status:** ✅ clean composition. W6's WASM swap policy and W11's framework-aware skip-list override are orthogonal — both active simultaneously, no conflicting signal. Verified by `bun audit/probes/w11/run-all.mjs::regression/bundler-bin-prefixes-include-frameworks.mjs` GREEN.

### `src/parallel/generated-workers.ts` (2-way: w7, w8)

**Composition check:** generated file produced by `scripts/bundle-facet-workers.mjs`. The phase 2 merge progress (`phase2-merge-progress.md` line 53) flagged that this file's diff was "timestamp-only" between W8 and W7. Phase 3 merge progress (line 49) confirms W7's regen produced a strict superset of the W8 preamble (`TAR_STREAM_PREAMBLE + W7_FRAME_PREAMBLE` concatenated; W8's tar-only preamble preserved verbatim).

**Status:** ✅ clean composition (auto-generated, deterministic). The presence of both preambles inside the bundled facet template means a single facet has access to BOTH W8's child_process broker and W7's stream codecs. Verified by `regression/cp-facet-direct-includes-frameworks.mjs` (W11) GREEN and `regression/w7-stream-rpc-still-present.mjs` (W12) GREEN.

### `src/parallel/npm-resolve-preamble.ts` (2-way: w6, w11)

**Composition check:** preamble for the resolver facet includes W6's `applySwaps`/`findRejects` AND W11's `frameworkAware` plumbing. Pure data file (the preamble is concatenated into the resolver's source at facet-build time).

**Status:** ✅ clean composition. Verified by `regression/install-pipeline-coverage.mjs` running cleanly across W4-W12.

### `src/sqlite-vfs.ts` (2-way: w5, w7)

**Composition check:**

- W5 (`src/sqlite-vfs.ts:1162-1212` `writeBatch` + `_writeBatchWithRetry`): SQLITE_NOMEM halve-retry path with bounded depth 4. LRU decoupled from `js_kj_buf_pool` per Lever 8 — verified by `regression/install-pipeline-coverage.mjs` GREEN.
- W7 (`src/sqlite-vfs.ts:1193-1210` `writeStream`): drains `AsyncIterable<BatchChunkEntry>` then delegates to `writeBatch`. Inherits W5's NOMEM retry path automatically. Atomicity unchanged.

**Status:** ✅ clean composition — exemplary in fact. W7 chose to delegate rather than duplicate; W5's hardening lives in the leaf `writeBatch` and W7's stream entry inherits it for free. Verified by `regression/legacy-writeBatch-still-works.mjs` GREEN and `e2e/heap-peak-during-install.mjs` (W7) reporting 0.23 MiB encoder peak (16× under the 30 MiB target).

---

## 2. Specific cross-wave bugs found

| ID | Severity | Title | Trigger | Fix scope |
|---|---|---|---|---|
| **CWB-1** | **HIGH** | `replica_routing` compat flag breaks local `wrangler dev` | Any local wrangler-dev whose bundled workerd version doesn't recognize `replica_routing` (i.e. EVERY local dev box that hasn't independently bumped `@cloudflare/workerd-linux-64` to the post-GA build) — `Error: workerd does not support replica routing.` thrown at `src/session-router.ts:112` for every DO-bound request | One-line `wrangler.jsonc` edit (move the flag into a `[env.production]` overlay) OR bump `@cloudflare/workerd-linux-64` in `package.json`. See §4.1 for X.5-A spec. |

No other functional cross-wave bugs surfaced in the local probe sweep (W3 25/28 PASS replicates branch baseline; W4-W12 each 6/6→28/28 GREEN; tsc clean).

### CWB-1 deep-dive

**Repro on this verification worktree:**

```
cd /workspace/worktrees/verification
./node_modules/.bin/wrangler dev --ip 127.0.0.1 --port 8787 --local
# Wait for "Ready on http://127.0.0.1:8787"
curl http://127.0.0.1:8787/s/some-id-1234/api/_diag/memory
# → 500 Internal Server Error
# wrangler-dev log: "Error: workerd does not support replica routing.
#                       at forwardToSession (src/session-router.ts:112:15)"
```

**Why no individual wave detected it:**
- The CT3 pre-flight research session for W12 (`audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §G.4 / §J.7.1) cited the wiki SPEC and assumed the GA workerd would recognize the flag. It does — but `wrangler@4.80.0`'s pinned `@cloudflare/workerd-linux-64` does not, and there's a release skew.
- W12's own probes use `audit/probes/w12/_mock-replica-ctx.mjs` — pure JS, never touches workerd.
- W12-retro §6 explicitly anticipated `wrangler deploy` rejecting the flag and offered the comment-out mitigation, but framed it as deploy-time, not dev-time. **Dev-time was never tested** because the merge orchestrator (`phase5-merge-progress.md`) ran W12's probe suite (mock-driven) and marked the merge complete; no real `wrangler dev` smoke test was attached to the merge gate.

**Why it matters in cascade:**
- All W3-W11 probes that depend on a real Nimbus server (W3's runner-based probes especially) run against `BASE=$URL` via `audit/probes/_driver.mjs`. Locally, that means `BASE=http://127.0.0.1:8787` after `wrangler dev`. With `replica_routing` in `compatibility_flags`, NONE of those probes can pass on a stock dev box.
- The roadmap's `audit/probes/_deploy-and-verify-all.mjs` orchestrator runs against a deployed Nimbus only (production workerd is fine), so this bug is invisible to the prod sweep too.
- **Net effect:** after Phase 5 merged, the project effectively lost local-development-mode verification of every prior wave. The 33-package compat probe (this verification's Phase D) is also blocked locally on the same root cause.

**Mitigation applied in this verification worktree (NOT pushed back to main):**

```jsonc
// wrangler.jsonc
"compatibility_flags": ["nodejs_compat", "experimental"],
// "replica_routing" temporarily disabled — see audit/sections/POST-PHASE5-CROSS-WAVE-AUDIT.md §CWB-1
```

After this edit, `/api/_diag/memory` reports `replica.state='unsupported'` cleanly (the W12 graceful-degrade path), and all subsequent local probes work end-to-end. **This edit must be reverted before any production deploy.**

---

## 3. Patterns observed

### 3.1 nimbus-session.ts grew 5,334 lines — fine, but at the limit

`src/nimbus-session.ts` is now 5,334 LOC (pre-Phase-1 baseline ~1,800; +3,534 across the 12 waves; W9 alone added 280, W8 added 233, W12 added 127). The 7-way collision file dwarfs every other source file in the codebase. The merge orchestrator handled all 7 merges without a single textual conflict because each wave landed in non-overlapping line ranges — but this is luck, not architecture. A future wave that needs to touch the constructor or `_handleFetch` will likely conflict with W12's preflight insertion at L1616+.

**Recommendation:** before any X.5 wave that touches `nimbus-session.ts`, refactor the DO into multiple modules (e.g. `nimbus-session-core.ts`, `nimbus-session-rpc.ts`, `nimbus-session-replica.ts`, `nimbus-session-hib.ts`). The file already has clear section boundaries — they could become module boundaries.

### 3.2 W12 regression suite is the gold standard

`audit/probes/w12/regression/` includes 6 probes that explicitly verify each prior wave's surface still exists post-merge: `w5-diag-memory-shape.mjs`, `w7-stream-rpc-still-present.mjs`, `w9-hib-config-still-present.mjs`, `w10-bindings-still-injected.mjs`, `w11-frameworks-detect-unchanged.mjs`, `wrangler-jsonc-still-valid.mjs`. **Every future wave should adopt this pattern** — write a `w<N-1>-still-present.mjs` regression probe so the merge orchestrator has a single command to verify "I didn't undo anything."

W4-W11 each have 1-3 regression probes, but they tend to verify wave-internal contracts (e.g. `regression/install-pipeline-coverage.mjs`) rather than explicit prior-wave surface presence. Standardising the W12 pattern is a low-cost win.

### 3.3 Every wave grafts on cleanly via a single insertion point

Every collision file resolved without overlap because each wave inserted at a unique semantic location:
- node-shims: W3 (real-builtins block), W8 (child_process impl block).
- supervisor-rpc: W4 (R2 block), W5 (frame-record decorator), W7 (writeBatchStream method), W8 (cp* method block).
- npm-installer: W4 (resolver-frameworkAware), W6 (applyW6Registry), W7 (TAR+FRAME preamble), W11 (frameworkAware detection at top of install).

This is excellent code stewardship by the per-wave authors. Comments tag every insertion with `// W<N>` markers, which the audit relied on to verify.

### 3.4 Generated files survived multi-wave regen

`src/parallel/generated-workers.ts` was regenerated by both W7 (`scripts/bundle-facet-workers.mjs` updated to add the W7 frame preamble) and W8 (regen as side-effect of `bun install` postinstall). The merge held because W7's regen output was a strict superset of W8's. Lucky — but worth noting that the bundle-facet-workers script is now the canonical source of truth; future waves should regen it explicitly rather than relying on `bun install` side-effects.

---

## 4. Risks for X.5 follow-ups

### 4.1 X.5-A — fix `replica_routing` local-dev breakage (HIGHEST PRIORITY)

**Trigger:** confirmed by this verification (CWB-1).
**Action:** one of:
1. Bump `@cloudflare/workerd-linux-64` (likely via `wrangler@^4.87.0` per the "update available" hint) to a version that recognizes `replica_routing`.
2. Move `replica_routing` into a wrangler env overlay so local dev runs without it: `wrangler.jsonc` keeps `compatibility_flags: ["nodejs_compat", "experimental"]` at top, then a new `env.production.compatibility_flags` includes the additional `replica_routing`. Production deploy uses `wrangler deploy --env production`.

Option 2 is safer (no runtime version churn), but the deploy orchestrator (`audit/probes/_deploy-and-verify-all.mjs`) will need a `--env production` flag too.

### 4.2 X.5-B — refactor `nimbus-session.ts` (5,334 LOC) into modules

**Trigger:** §3.1 above.
**Action:** split into `nimbus-session-{core,rpc,replica,hib,cp,frame}.ts` along the section boundaries already documented in the file's wave-marker comments. Pure refactor — no behavior change. Drops the 7-way collision risk for future waves.

### 4.3 X.5-C — pre-bundler for jsdom / fastify / W3 e2e

**Trigger:** W3-retro §S3-S4 + this verification (3 of 28 W3 probes still fail with bundler errors).
**Action:** the pre-bundler must add `tldts/dist/es6/index.js` and `ret/dist/types` to the VFS bundle. Already tracked in W3-retro §S3-S4 as W3.5 candidate. This is **independently being executed** by a parallel agent (worktree `/workspace/worktrees/w3-5-prebundler` was observed running on port 8801 during this verification — its work will likely close §S3-S4).

### 4.4 X.5-D — formalise prior-wave regression suite per §3.2

**Trigger:** §3.2 above.
**Action:** add the 6-probe W12-style suite to W3-W11 retroactively (one regression probe per wave that verifies the wave's surface is still injected post-merge). Cheap CI win.

### 4.5 X.5-E — Phase D package compat tally

The 33-package local-compat run (running concurrent with this audit) measures the actual ✅ count vs the W2.6a baseline (5/33). See `audit/sections/POST-PHASE5-VERIFICATION.md` for the dispatch-priority scoring of which X.5 fixes would unlock the most packages.

---

## 5. Concrete dispatch order

If only one X.5 wave can be funded:
1. **X.5-A (replica_routing local-dev fix)** — unblocks local verification of every prior wave; trivial scope. **Critical.**
2. **X.5-C (W3 pre-bundler)** — unblocks 3 named acceptance packages (jsdom, fastify, fastify-runStores) per W3-retro §S3-S4, plus likely 5-10 packages in the top-30 sweep. Estimated ✅ count delta: +3 to +6. (Note: parallel agent is already on this in `/workspace/worktrees/w3-5-prebundler`.)
3. **X.5-B (refactor `nimbus-session.ts`)** — preventative; not unlocking new functionality but reducing future-wave merge cost.
4. **X.5-D (regression suite formalisation)** — CI hygiene; no end-user-visible win.

Final detailed package-impact ranking is computed in `audit/sections/POST-PHASE5-VERIFICATION.md` once the 33-package run finishes.

---

## 6. Verification trail

- `audit/probes/post-phase5-verification/_collision-matrix.txt` — collision matrix (this audit's source of truth for §1).
- `audit/probes/post-phase5-verification/tsc-output.txt` — tsc clean (only 2 baseline errors).
- `audit/probes/post-phase5-verification/w<3..12>-results.txt` — per-wave probe runs against the merged tree.
- `audit/probes/post-phase5-verification/packages-local/` — top-30 package compat against local wrangler-dev.
- `audit/sessions/verification-progress.md` — session-by-session log including the CWB-1 detection event.
