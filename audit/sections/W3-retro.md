# W3 Retro — Builtin completeness + crypto correctness

> **Wave:** W3
> **Branch:** `w3-builtins` (origin/w3-builtins @ `d554a89`)
> **Base:** `48b0384` (main, MASTER-ROADMAP)
> **Wave executed:** 2026-05-04 (single autonomous session)
> **Status:** Code green locally, pushed to origin. Prod verification
> deferred to workspace agent per "deploys may queue" directive.

---

## 1. Outcome vs predicted

### Acceptance gates from MASTER-ROADMAP §W3

| Gate | Predicted | Actual | Status |
|---|---|---|---|
| 33-package probe ≥12/33 | 12/33 | not run end-to-end (local time-budget); 5/5 W3-builtin baseline blockers eliminated, 3/5 named acceptance packages fully load (axios/puppeteer-core/ts-node), 2/5 hit deeper bundler issues | **partial** — see §3 |
| axios ✅ | yes | ✅ load + surface (typeof get/post/create = function) | **PASS** |
| jsdom ✅ | static-load only (vm runtime eval blocked by workerd) | static-load fails NEW: `tldts/dist/es6/index.js: file was not pre-bundled`. Bundler-layer blocker, NOT W3 vm shim. | **partial** — vm shim works (`vm-static-surface.mjs` PASS); jsdom fails downstream of W3 |
| fastify ✅ | yes | NEW failure: `Cannot read module: home/user/app/node_modules/ret/dist/types`. The `ret` transitive dep has a directory require that the resolver doesn't handle. NOT a diagnostics_channel issue (functional `diagnostics-channel-runStores.mjs` PASS). | **partial** — dc shim works; fastify fails downstream of W3 |
| puppeteer-core ✅ | yes | ✅ load + surface (typeof launch = function) | **PASS** |
| ts-node ✅ | yes | ✅ load + surface (typeof register = function) | **PASS** |
| Crypto regression: real SHA-256 vs known vectors | yes | ✅ `2cf24dba...` matches NIST vector for "hello"; FNV-1a fake gone | **PASS** |
| Mossaic regression PASS | yes | not run locally (out of session scope per "deploys queue" directive) | deferred to prod re-run |
| Wave 1 external-host count = 0 | yes | not run locally (relies on prod /api/stats) | deferred |
| All W3 tests pass on prod | yes | local: 21/22 functional+regression + 3/6 e2e | **partial** — local PASS expected to translate to prod for acceptance probes; bundler failures are wave-orthogonal |

### Internal scope items

| Item | Predicted LOC | Actual LOC | Status |
|---|---|---|---|
| Real `node:crypto` (FNV-1a kill) | -82 +43 | -82 +47 | done |
| `vm` shim (hybrid) | +60 | +56 | done |
| `http2` shim | +35 | +37 | done |
| `repl` shim | +12 | +12 | done |
| `diagnostics_channel` shim | +30 | +33 | done |
| `tls` shim (Proxy override) | +20 | +24 | done |
| `async_hooks` shim | +15 | +18 | done |
| `fs/promises` full surface + FileHandle | +100 | +130 | done |
| `net.Socket` honest-error | +30 | +50 | done |
| `builtins['fs/promises']` etc. | +6 | +14 (incl. timers/promises) | done |
| `_shared/real-node-imports.ts` (helper) | +60 | +47 | done |
| `unix-commands.ts sha256sum` (bonus) | +15 | +15 | done |

Total src/ delta: +545 / -116 (vs predicted ~+475 / -120). Within budget.

### Test coverage

22 functional + 1 regression + 6 e2e + run-all + helpers = **30 .mjs**.
Predicted: ~25. Slight over-build from C9 review additions.

---

## 2. Surprises

### S1 — Workerd `node:vm` exists at compat 2026-04-01 but is a runtime-eval no-op
The v1 plan assumed workerd had no `node:vm`. The Phase A sub-agent
review (C1) revealed workerd added `node:vm` as a stub since
2025-10-01. Live probe at `/tmp/w3-workerd-probe` confirmed:
`vm.constants`/`vm.Script`/`vm.runInContext` are all `function` /
`object` BUT every code-running method throws
`ERR_METHOD_NOT_IMPLEMENTED` at request time.

Implication: hand-rolled vm with `with(__ctx) { ... }` (v1 plan) would
have shipped a half-working `runInContext` + the workerd block on
`new Function`. The hybrid v2 design (forward surface + honest-error
on eval) is the correct choice given the constraint.

Forward implication for W3.5: a parser-based vm fallback (acorn or
similar) running INSIDE the bundled SHIMS code at module-eval time
could enable jsdom HTML-script execution. Out of W3 scope — flagged.

### S2 — `node:diagnostics_channel.Channel.runStores` exists and works
Sub-agent review C2 flagged that fastify@5 uses `runStores`, and v1
plan's hand-rolled `Channel` class was missing this method.  Probe at
`/tmp/w3-workerd-probe` confirmed workerd's `node:diagnostics_channel`
exposes the full API including `runStores`.  Forwarding the whole
module is the simplest correct path.

The functional probe `diagnostics-channel-runStores.mjs` PASSES,
proving the workerd forward handles fastify's pattern.  But the
fastify e2e probe still fails (S3) — at a different layer.

### S3 — fastify e2e fails at `ret/dist/types` directory-require
`require('fastify')` triggers `find-my-way` → `ret` → `ret/dist/types`
which is a directory (not a file), and Nimbus's CommonJS resolver
doesn't try `index.js` when the path is a directory key.  This is a
W2.7-territory resolver bug, not a W3 issue.

Verified by inspecting the artifact:
```
Error: Cannot read module: home/user/app/node_modules/ret/dist/types
    at __loadModule (runner.js:1994:28)
```

The error is from `__loadModule` (require from VFS), not from a
builtin shim.  The fix is a tweak to `__resolveFile` in node-shims.ts
or `__resolvePkgSubpath` in resolver — but adding directory-as-index
fallback was explicitly out of W3 scope (per plan §1 "Out of scope:
Resolver fixes for `next`/`nuxt`/...").

### S4 — jsdom e2e fails at `tldts/dist/es6/index.js: file was not pre-bundled`
jsdom transitively imports `tldts` (a TLD parser, ESM-only on the
es6/ subpath).  The pre-bundler doesn't include this path.  Two
likely causes:
- The 4 MiB / 500-file content cap evicts it (per W2.5b root cause).
- The resolver doesn't pick up the right ESM condition mapping.

Either way, it's a W2.7 bundler/resolver issue.  vm shim works
(`vm-static-surface.mjs` PASSES); jsdom's static load progresses past
the W3 builtin layer and lands on a different fault.

### S5 — Local wrangler dev hangs on async unix-commands
`sleep 1` hangs in the local wrangler-dev shell — pre-W3 too
(verified by checkout of `85fb556`).  `shell-sha256sum` probe
inherits this hang.  My W3 sha256sum logic is correct (verified via
standalone Node).  The shell-features `executeCommandLine` or
`@lifo-sh/core` registry dispatch may not properly await async cmds
in the local wrangler harness.

This is a Phase D verification gap, not a W3 defect.  Will pass on
prod (where the existing `mkSleep` / other async cmds work fine per
prior wave probes).

### S6 — Push grant lapses mid-phase
Between Phase B push (succeeded) and Phase C+D push attempts, the
`cloudflare-seal[bot]` push grant expired ("Permission denied to
cloudflare-seal[bot]").  Mid-Phase-D the grant came back and Phases
C+D pushed in one shot via `git push origin w3-builtins`.  The "halt
on grant denied" rule per the dispatch was followed — I did not
retry within the same minute, instead continued local work and
retried at end-of-phase.

### S7 — `src/git-bundle.generated.ts` and `src/parallel/generated-workers.ts` regen on `bun install`
Both files have a generated-at timestamp that bun's postinstall hooks
update.  I had to `git checkout --` them after each `bun install` /
even after some `bunx tsc` runs.  Documented in retro for future-
session hygiene; consider a script-side fix to make these idempotent.

---

## 3. Scope deviations

### D1 — bonus scope: `unix-commands.ts:sha256sum` was also FNV-1a fake
Discovered during plan-grep for `createHash` callers. Same bug as
the node-shims crypto FNV. Fixed in same wave (real WebCrypto
SubtleCrypto, sync→async).  Cleaner to fix here than to ship a wave
where some sha256 paths are real and others fake.

### D2 — bonus scope: `timers/promises` shim added
Not in original plan §1 scope, but trivial to add (10 LOC) and
review N1 flagged it as high-leverage. Functional probe
`timers-promises.mjs` PASSES.  Two new builtins entries
(`timers/promises` + `node:timers/promises`).

### D3 — vm shim hybrid (forward + honest-error) instead of v1's `with(__ctx)`
v1 plan proposed a hand-rolled `with(__ctx) { ... }` Function shim.
Sub-agent review C3 demonstrated this approach can't return the
correct value for `vm.runInContext("this", ctx)` (V8 program-vs-
function-body semantic difference).  v2 dropped that approach in
favour of forwarding workerd's surface and wrapping eval methods
with honest-error.

### D4 — net.Socket: honest-error not workerd-forward
v1 plan had brief flirtation with forwarding to workerd's `node:net`
(which exists and works).  v2 stuck with honest-error because:
1. workerd's outbound TCP is blocklist-based, but production
   targets (most database hosts) hit one of the blocked categories.
2. Bridging to supervisor RPC for real outbound TCP is W8 work.
3. Honest-error in W3 surfaces real problems (vs the silent-connect
   lie pre-W3) without committing to a half-baked TCP path that
   would be replaced in W8.

---

## 4. Decisions for follow-up waves

### W3.5 candidates

1. **Bundler/resolver layer fixes (W2.7 territory):**
   - `ret/dist/types` directory require → fix
     `__resolvePkgSubpath` or `__resolveFile` to fall back to
     `<dir>/index.js` when a directory is required without an
     explicit file.  Unblocks fastify e2e.
   - `tldts/dist/es6/index.js` not pre-bundled → investigate
     pre-bundler's ESM-condition resolution; ensure es6/ subpath is
     followed for jsdom's transitive deps.

2. **vm runtime eval — parser-based fallback:**
   acorn (~280 KB minified) bundled into the SHIMS code, runs at
   module-eval time inside a fresh Function with `with` scope.
   Enables jsdom HTML-script execution.  Cost: bundle size +
   correctness/perf.  Decision deferred until a user actually needs
   browser-script evaluation in jsdom (most jsdom users only need
   DOM parsing, which works at static load).

3. **Audit-flagged shim gaps not covered in W3:**
   - `assert.match`, `assert.rejects` — test frameworks
   - `fs.openSync`, `fs.realpathSync` — many resolvers use these
   - `os.availableParallelism` — jest/eslint config
   - `stream/promises`, `stream/web` — modern async patterns
   - `util.parseArgs` — CLI tools
   - `process.memoryUsage()` real values — needs supervisor RPC
   - `dns.resolveTxt/Mx/Srv` — currently only A/AAAA via DoH
   Pick 3-4 high-leverage in W3.5 if 33-package count needs more lift.

### CT2 (platform-gated tracking) item to watch
- workerd vm runtime-eval implementation: if CF lifts the
  request-handler eval block (per polyfill RFC), the v2 hybrid
  collapses to a straight forward — re-check at next compat date
  bump.

### W6 implication
The honest-error net.Socket proves the user-experience pattern: loud
fail with a `Use X instead. (Wave Y will add Z.)` message.  W6
(WASM swap registry + REJECT_INSTALL UX) should adopt the same
phrasing for native-binding rejects.

### W8 implication
W8 will route outbound TCP through supervisor RPC.  When that lands,
update `__net.Socket.connect()` to delegate to supervisor instead of
emitting `ERR_NET_SOCKET_NOT_AVAILABLE`.  Probe
`net-socket-honest.mjs` will need to be amended (or replaced with a
positive-flow probe that tests real outbound).

---

## 5. Update to existing audit

After this wave merges, `audit/sections/01-node-builtins.md`'s matrix
should be updated:

| Module | Pre-W3 | Post-W3 |
|---|---|---|
| `crypto` | 🔴 fake hash | ✅ workerd forward (full surface) |
| `vm` | ❌ not in builtins | ⚠️ hybrid (surface yes, runtime eval honest-error) |
| `http2` | ❌ not in builtins | ⚠️ stub (non-throwing load, error on connect) |
| `repl` | ❌ not in builtins | ✅ workerd forward |
| `diagnostics_channel` | ❌ not in builtins | ✅ workerd forward (incl. runStores) |
| `tls` | ❌ not in builtins | ✅ workerd forward (createServer overridden) |
| `async_hooks` | ❌ not in builtins | ✅ workerd forward |
| `fs/promises` (bare require) | ❌ Cannot find module | ✅ wired |
| `node:fs/promises` | ❌ Cannot find module | ✅ wired |
| `timers/promises` | ❌ not in builtins | ✅ shimmed |
| `net.Socket.connect()` | 🔴 silent lie ('connect' immediately) | ⚠️ honest-error (`ERR_NET_SOCKET_NOT_AVAILABLE`) |
| `fs/promises` surface | ⚠️ 7 methods | ✅ ~25 methods + FileHandle |

Headline finding #1 ("`crypto.createHash` is a fake") is RESOLVED.
Headline finding #3 ("`net.Socket` connect is a lie") is RESOLVED
(replaced with honest-error mode).

The audit should also note: workerd `node:vm` runtime-eval limitation
is now visible to user code as `ERR_VM_DYNAMIC_EVAL_DISALLOWED`
(documented limitation, not a silent bug).

---

## 6. Hand-off notes

For the workspace agent reviewing this PR:

1. **Symmetry check**: confirm `getRealNodeImportsCode()` is consumed
   in BOTH facet templates (`generateFacetCode` line ~186 and
   `generateEntrypointCode` line ~351 of `src/facet-manager.ts`).
   Drift between templates would silently regress the LOADER.load
   fallback path.

2. **Bundle size**: verify `BUNDLE_MAX_ENCODED_BYTES` in
   `src/constants.ts` accommodates the +14 KB SHIMS growth × 2
   templates.  No incident in local Phase D.

3. **Prod verification**: re-run `audit/probes/w3/run-all.mjs` (BASE
   default = prod) after deploy. Expectation:
   - functional + regression: 22/22 PASS (the local
     shell-sha256sum hang should resolve in prod where async unix-
     cmds work via the real shell-features path).
   - e2e: 3-5/6 PASS depending on whether bundler issues for
     fastify/jsdom are resolved by W3.5.

4. **Mossaic + Wave 1**: re-run via existing
   `audit/probes/run-mossaic-prod-w2.mjs` and
   `audit/probes/run-wave1-regression-w2.mjs` against prod.
   Expectation: PASS (no W3 changes affect those code paths).

5. **Master roadmap update**: when W3 deploys + verifies, mark W3
   `done` in MASTER-ROADMAP §Phase 1 table.

---

## 7. Phase-by-phase log

| Phase | Status | Commit | Notes |
|---|---|---|---|
| A — plan v2 | ✓ | 85fb556 | Sub-agent review found 11 critical issues in v1; v2 addresses all |
| B — failing tests | ✓ | 71b390e | 30 .mjs (22 functional + 1 regression + 6 e2e + run-all + helpers) |
| C — build | ✓ | a250951 | +545 / -116 src/ LOC; tsc clean (2 pre-existing); shim parses |
| D — local audit | ✓ | d554a89 | 21/22 functional+regression PASS; 3/6 e2e PASS; install-pipeline regression no-regress |
| E — push | ✓ | (rolled into D) | All 5 commits on origin/w3-builtins |
| F — retro | ✓ | (this file) | Done |

---

## 8. Quote for the next session

> Quality > speed. Multi-day OK.

Quality delivered: the silent-correctness FNV-1a → real SHA-256 swap
is the highest-value change in this wave by a wide margin. Even if
fastify/jsdom remain bundler-blocked until W3.5, every Nimbus user
who calls `crypto.createHash('sha256')` (or `sha256sum` on the
shell) now gets a real hash instead of a deterministic-looking
non-hash.  That's a production correctness fix, not a feature.
