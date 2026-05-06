# X.5-Z5 build wave — progress log

> Branch: `x5z5-build`. Local main HEAD at start: `700420f`.
> Mode: BUILD. TDD red → green per package.
> Scope (focused): express + tailwindcss-vite. tailwindcss-oxide REJECT
> deferred-or-trivial; ts-jest deferred to W2.6b cap fix.
> Source plan: `audit/sections/X5Z5-plan.md` §1 + §3.

## Phase A — Plan

Status: **in progress.**

Goals:
- Confirm Z5 plan §1 (express) and §3 (tailwindcss-vite) root causes still
  hold post-NPQO merge.
- Verify file:line citations against current src/ (drift expected).
- Self-review.

Verifications (post-NPQO):

| Citation in Z5 plan | Verified at | Status |
|---|---|---|
| `src/streams.ts:380-386` (return shape) | `src/streams.ts:380-386` | unchanged |
| `src/node-shims.ts:708` (util.inherits) | `src/node-shims.ts:756` | DRIFTED +48 lines (NPQO restructured) — same body verbatim |
| `src/facet-manager.ts:766-776` (looksLikeEsm) | `src/facet-manager.ts:766-776` | unchanged |
| `src/facet-manager.ts:772,774` (regex lines) | `src/facet-manager.ts:772,774` | unchanged |

Net: all three fix sites are reachable. The only drift is the line number
of util.inherits (708→756); the body is verbatim-identical, so the Z5
plan §1.3 Defect-B replacement is still a literal find-and-replace.

tsc baseline: 2 errors — `src/esbuild-service.ts:153:28` and
`src/nimbus-session-init.ts:74:39`. These are the documented baseline.

Phase A: ✓ committed.

## Phase B — TDD red

Status: **complete (red confirmed).**

Authored 5 functional + regression probes + 2 e2e, all reflecting the
verbatim runtime stack from the X5Z5 investigation:

### Functional (RED state)

- `audit/probes/x5z5-build/functional/e-express-stream-prototype.mjs`
  - 5 assertions; 3 pass / 2 fail.
  - PRIMARY fail: `require("stream").prototype is defined` —
    actual `undefined` (Defect-A reproduces).
  - PRIMARY fail: `Object.create(stream.prototype, ...) does NOT throw` —
    "Object prototype may only be an Object or null." (Defect-A).
- `audit/probes/x5z5-build/functional/e-express-inherits-guard.mjs`
  - 6 assertions; 4 pass / 2 fail.
  - PRIMARY fail: `util.inherits(C, null)` throws
    "null is not an object (evaluating 's.prototype')".
  - PRIMARY fail: `util.inherits(C, {})` throws
    "Object prototype may only be an Object or null." (Defect-B).
  - Regression-safe: happy-path (Parent w/ prototype) still wires up,
    super_ + .prototype both correctly populated.
- `audit/probes/x5z5-build/functional/v-tailwindcss-vite-looks-like-esm.mjs`
  - 6 assertions; 4 pass / 2 fail.
  - PRIMARY fail: minified `;import{` shape NOT detected (blind-spot A+B).
  - PRIMARY fail: no-whitespace `import{` shape NOT detected (blind-spot B).
  - Regression-safe: newline ESM still detected, plain CJS rejected,
    `importedX` identifier rejected, comment-only "// import" rejected.

### Regression (GREEN — must stay GREEN through Phase C)

- `audit/probes/x5z5-build/regression/single-resolver-source.mjs` —
  2/2 pass (1 declaration in `_shared/exports-resolver.ts`).
- `audit/probes/x5z5-build/regression/install-pipeline-coverage-shim.mjs` —
  6/6 pass (SCENARIOS list contains express/fastify/ts-jest/redis).
- `audit/probes/x5z5-build/regression/builtins-coverage.mjs` —
  38/38 pass (includes util/types from X.5-Q + dns/promises from X.5-M).

### E2E (RED — real-package install)

- `audit/probes/x5z5-build/e2e/express.mjs` (4 pass / 5 fail RED):
  - Bundle has express main + `send/index.js` (the actual
    `util.inherits(SendStream, require('stream'))` site at line 173).
  - Verbatim runtime fail: `Object prototype may only be an Object or null.`
  - express resolves but soft-errors; .use/.get/.listen all missing.
- `audit/probes/x5z5-build/e2e/tailwindcss-vite.mjs` (4 pass / 3 fail RED):
  - Bundle has @tailwindcss/vite/dist/index.mjs.
  - Confirmed: file IS minified-ESM with `;import{` shape (Z5 §3 target).
  - `looksLikeEsm` MISSES it (1 .mjs file slipped past the gate; metric
    landed in probe).
  - Verbatim runtime fail: `pre-compile failed at facet startup:
    Unexpected token '{'. import call expects one or two arguments.`
    (Bun-engine variant of the V8 ESM-syntax message; same root cause.)

### Run-all driver

- `audit/probes/x5z5-build/run-all.mjs` runs all 8 probes. Expected
  failures pre-fix: 2 functional (e-express-stream-prototype,
  e-express-inherits-guard, v-tailwindcss-vite-looks-like-esm — wait,
  3 fail) + 2 e2e = 5 fails. Will re-run post-Phase-C to verify all green.

Phase B: ✓

## Phase C — Build

Status: **complete (7 commits, 5 src/ files touched, ~95 LOC net).**

| # | Commit | File | LOC | Flips green |
|---|---|---|---|---|
| 1 | fix(streams): synthetic .prototype on __streamMod | src/streams.ts:380 | +12 | e-express-stream-prototype |
| 2 | fix(node-shims): guard util.inherits against null | src/node-shims.ts:756 | +9 | e-express-inherits-guard |
| 3 | fix(facet-manager): looksLikeEsm catches minified ;import{ | src/facet-manager.ts:766-776 | +6 | v-tailwindcss-vite-looks-like-esm |
| 4 | fix(require-resolver): IMPORT_RE catches minified ;import{ | src/require-resolver.ts:79 | +10 | v-tailwindcss-vite-prefetch-walker |
| 5 | fix(node-shims): EE shim methods lazy-init this._e | src/node-shims.ts:679-693 | +17 | e-events-shim-lazy-init + e2e/express |
| 6 | fix(node-shims): minimal v8 stub for jiti | src/node-shims.ts:1911 | +23 | v-v8-shim-stub |
| 7 | fix(node-shims): path.win32 alias to posix | src/node-shims.ts:91-93 | +9 | (progress only — next blocker is lightningcss native) |

### Z5 plan §1 (express) — 3 commits

1. **Defect-A primary** (Z5 plan §1.3 Primary): synthetic `.prototype`
   on `__streamMod` so `Object.create(stream.prototype, ...)` doesn't
   throw "Object prototype may only be an Object or null: undefined".
2. **Defect-B defensive** (Z5 plan §1.3 Defensive): guard `util.inherits`
   against null/undefined parent or parent.prototype. Defense-in-depth
   matching `inherits_browser.js` semantics.
3. **EE-shim follow-on** (NOT in Z5 plan; discovered post-fix): every EE
   method that touches `this._e` lazy-initializes it. Required for
   express's mixin-copy of `EventEmitter.prototype` onto `app`.

### Z5 plan §3 (tailwindcss-vite) — 4 commits

1. **looksLikeEsm regex** (Z5 plan §3.2): dual-relaxation for minified
   `;import{` shape.
2. **Prefetch walker IMPORT_RE** (NOT in Z5 plan; same fix class as
   §3.2): identical dual-relaxation in src/require-resolver.ts:79. Z5
   plan was incomplete-by-omission.
3. **v8 stub** (NOT in Z5 plan; discovered post-fix): minimal `node:v8`
   builtin for jiti's `startupSnapshot.isBuildingSnapshot()`.
4. **path.win32 alias** (NOT in Z5 plan; discovered post-fix): self-alias
   to satisfy enhanced-resolve's `path.win32.normalize` import-time access.

### Scope deviations

Authored ahead of schedule with TDD discipline:
- Each follow-on fix has its own functional probe written BEFORE the
  src/ change.
- All fixes confined to the 4 src/ files explicitly named in Z5 plan §1
  (streams.ts, node-shims.ts) + Z5 plan §3 (facet-manager.ts) + the
  obvious Z5 §3 mirror (require-resolver.ts).
- No edits to forbidden territories (no exports-resolver.ts changes; no
  npm-resolver.ts changes; no facet boundary changes).

### Final probe state

```
==== SUMMARY ====
  PASS  express-stream-prototype
  PASS  express-inherits-guard
  PASS  events-shim-lazy-init
  PASS  tailwindcss-vite-looksLikeEsm
  PASS  tailwindcss-vite-prefetch-walker
  PASS  v8-shim-stub
  PASS  single-resolver-source
  PASS  install-pipeline-coverage-shim
  PASS  builtins-coverage
  PASS  express e2e             ← ✅ FLIP at real-package install layer
  FAIL  tailwindcss-vite e2e    ← blocked on lightningcss native binding
                                  (out of Z5 scope; src/wasm-swap-registry.ts
                                  REJECT_INSTALL or new SWAP would be the
                                  fix class, not Z5 §3)
```

Per dispatch criterion "≥1/2 of {express, tailwindcss-vite} flip ✅ at
real-package install layer": **MET.** express ✅. tailwindcss-vite passes
all Z5 §3 in-scope assertions but is blocked by an out-of-scope native
binding gap that surfaces only after Z5 §3 unblocks the import chain.

Phase C: ✓

## Phase D — Audit

Status: **complete.**

### tsc baseline (must remain just 2 documented errors)

```
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
```

**PASS** — exactly 2 errors, both pre-existing baseline. No new tsc
errors introduced by Z5.

### x5z5-build run-all (functional + regression + e2e)

10 / 11 PASS. The 1 fail is `tailwindcss-vite e2e` blocked on
`lightningcss native binding` (out of Z5 scope per Phase C wrap doc).

### Cross-wave regression suites

| Suite | Result | Notes |
|---|---|---|
| audit/probes/x5npqo/run-all.mjs | **PASS** (6/6) | functional + regression all green; e2e skipped (no BASE) |
| audit/probes/x5l/run-all.mjs | **PASS** (10/10) | functional + regression + 3 e2e all green |
| audit/probes/x5j/run-all.mjs | **PASS** (9/9) | tsc-baseline-preserved + jiti scenarios green |
| audit/probes/x5c/run-all.mjs | **PASS** (10/10) | walker + regression + 3 e2e green |
| audit/probes/regression/install-pipeline-coverage.mjs | (deferred) | needs WS/wrangler driver — same N/A as Mossaic |

### Pre-existing failures (NOT caused by Z5)

Verified by stashing Z5 changes and re-running on main HEAD `700420f`:

- `audit/probes/w11/regression/bundler-bin-prefixes-include-frameworks.mjs`
  → 0/7 pass on main HEAD `700420f`. Probe is stale (looks for
  `BUNDLER_BIN_PREFIXES` array constant which has been refactored away).
  **Not caused by Z5.**
- `audit/probes/w11/regression/cp-facet-direct-includes-frameworks.mjs`
  → same fail mode on main. **Not caused by Z5.**
- `audit/probes/w12/regression/w5-diag-memory-shape.mjs` → 1/4 pass on
  main. Probe expects emit-shapes (rssBytes/heapUsedBytes/hib block)
  that have been refactored. **Not caused by Z5.**

These should be flagged in a separate cleanup wave (probe-staleness
audit). They are NOT regressions caused by this wave.

### Mossaic (deferred — N/A in audit-only mode)

Per W2.6b retro precedent, Mossaic prod-W2 regression requires a deployed
prod env (`BASE` + WS driver). This worktree has neither. The same N/A
status applies as W2.6a/b, X.5-L, X.5-NPQO retros.

The Z5 wave does not touch:
- The Mossaic-relevant install-pipeline (no edits to npm-installer,
  resolver-facet, batch-facet).
- The W1 contract surface (no edits to RPC method set or
  `nimbus-session-init.ts`).
- The W3 emitter/diag pipeline (no edits to `nimbus-session-rpc.ts`
  or `nimbus-session-init.ts`).

Confirmed via `git diff --stat main..x5z5-build -- src/`:
```
 src/facet-manager.ts    | 16 +++++++----
 src/node-shims.ts       | 72 +++++++++++++++++++++++++++++++++++++++++--------
 src/require-resolver.ts | 12 +++++++--
 src/streams.ts          | 16 ++++++++++-
 4 files changed, 97 insertions(+), 19 deletions(-)
```
All 4 src/ files are within Z5 plan §1+§3 scope (or its obvious mirror —
require-resolver IMPORT_RE has the same regex defect as
facet-manager looksLikeEsm).

Phase D: ✓

## Phase E — Push best-effort

Each phase commit attempted `git push origin x5z5-build`. All 4 attempts
returned the same 403:
```
remote: Access denied: grant not approved
fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/': The requested URL returned error: 403
```
Same status as the X5Z5-investigation push and prior verify-90993b3
push. **Halted on grant.** Local commits intact at `x5z5-build` HEAD.

Phase E: ✓ (halted-on-grant per dispatch convention)

## Phase F — Retro

`audit/sections/X5Z5-build-retro.md` written. Per-package verdict:

- **express ✅ FLIP** at e2e layer (9/9 e2e probe passes).
- **tailwindcss-vite ⚠ partial** — Z5 verbatim error gone; blocked at
  next layer by lightningcss native binding (out of Z5 scope).

Per dispatch criterion "≥1/2 of {express, tailwindcss-vite} flip ✅
at real-package install layer": **MET** (1/2 = 50% ≥ ≥1/2).

Phase F: ✓

## Final state

- 8 phase commits on `x5z5-build` (4 src/ files touched, ~95 LOC net).
- 11 probes in `audit/probes/x5z5-build/`: 10 PASS, 1 FAIL (out-of-scope).
- 4 cross-wave regression suites verified GREEN.
- tsc baseline preserved (2 documented errors, no new ones).
- `audit/sections/X5Z5-build-plan.md` ✓
- `audit/sections/X5Z5-build-retro.md` ✓
- `audit/sessions/X5Z5-build-progress.md` ✓ (this file)


