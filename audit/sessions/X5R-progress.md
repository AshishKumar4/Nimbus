# X.5-R — Build wave progress

> Branch: `x5r-events-class`. Local main HEAD at start: `a571079`.
> Mode: BUILD. Mission per `audit/sections/VERIFY-700420F.md` §4 #1:
> events / class-extends-undefined unification — fix fastify + redis,
> minimal diff in `src/node-shims.ts`. Predicted: ~10-30 LOC,
> +2 ✅ → 25/33 strict.

## Phase log


### Phase A — Investigate (DONE)

- Worktree `/workspace/worktrees/x5r-events-class` at branch `x5r-events-class`, base `a571079`. `bun install` clean (184 packages, 9s).
- Started wrangler dev on 0.0.0.0:8787 (PID 880239 bun → 880907 node wrangler).
- Reproduced fastify probe on current HEAD: **fastify already PASSES (exit 0, `app title: Object`)**. Goalposts moved — X.5-Z5-build's EE-shim mixin lazy-init (`(this._e ??= {})` in EE.on/once/etc.) already healed fastify's `Plugin.on` path.
- Reproduced redis probe on current HEAD: **redis still FAILS with same error shape** (`Class extends value undefined`, runner.js:34:34, eval anon:303:48).
- Pulled @redis/client@5.12.1 source. Located the failing line: `dist/lib/client/cache.js:301` — `class ClientSideCacheProvider extends stream_1.EventEmitter` where `stream_1 = require("stream")`.
- Verified Node behavior: `require('stream').EventEmitter === require('events').EventEmitter` (true in real Node).
- Inspected our `__streamMod` (src/streams.ts `generateStreamsCode`): returned object lacks `.EventEmitter` — confirmed root cause.
- Investigation artifacts saved to `audit/probes/x5r/investigation/` (REPRO-NOTES.md, fastify-on-a571079.out.txt, redis-on-a571079.out.txt, build-runner.mjs).
- Verify-700420f probe artifacts restored to original state via `git checkout --`.
- Hypothesis verdict: **DIVERGED from VERIFY-700420F §4 #1's "single bucket, EE inheritance" framing**. The redis defect is a stream-module surface gap, not an events-module shape gap. Fastify defect was already healed by Z5. Bucket R reduces to a 1-2 LOC stream re-export.


### Phase B — Plan (DONE)

- Authored `audit/sections/X5R-plan.md` (251 lines).
- Self-review TL;DR captures the goalposts shift: bucket R is divergent (fastify already green, redis remains).
- Root cause finalized: `__streamMod` lacks `.EventEmitter`. Real Node has `stream.EventEmitter === events.EventEmitter`.
- Fix sketch: ≤5 LOC at `src/node-shims.ts:1781` post `builtins.stream =` registration: `if (!__streamMod.EventEmitter) __streamMod.EventEmitter = __eventsMod;`
- Regression matrix: 7 invariants protected (single-resolver, install-pipeline-coverage, EE lazy-init, stream prototype plant, util.inherits guard, mossaic, W1, tsc baseline).
- Probe matrix: 3 functional + 4 regression + 3 e2e + 1 run-all driver.
- Phase boundaries documented; commit gates explicit.
- Anti-requirements re-stated. Predicted +2 ✅ (fastify already +1 from Z5, redis +1 here).


### Phase C — TDD RED (DONE)

Authored:
- `audit/probes/x5r/functional/r-stream-eventemitter-shape.mjs` — RED at a571079 (5/6 fail). Synth fixture uses `makeFacet` from `audit/probes/x5c/_helpers.mjs` to materialize the SHIMS scope, then exercises `require("stream").EventEmitter` against the redis cache.js shape (`class CSCP extends stream.EventEmitter`).
- `audit/probes/x5r/functional/r-stream-prototype-still-pointed.mjs` — GREEN at a571079 (Z5 invariant guard).
- `audit/probes/x5r/functional/r-ee-lazy-init-still-works.mjs` — GREEN at a571079 (Z5-build invariant guard).
- `audit/probes/x5r/regression/r-single-resolver-source.mjs` — GREEN; delegates to X5F + X5J + X5NPQO probes.
- `audit/probes/x5r/regression/r-install-pipeline-coverage.mjs` — GREEN; delegates to X5F probe.
- `audit/probes/x5r/regression/r-mossaic.mjs` — heavy; SKIPs cleanly when BASE unreachable.
- `audit/probes/x5r/regression/r-w1.mjs` — heavy; SKIPs cleanly.
- `audit/probes/x5r/e2e/r-cache-class-extends.mjs` — RED at a571079 (smallest possible e2e reproducer).
- `audit/probes/x5r/e2e/r-redis-loads.mjs` — RED at a571079 (full redis package smoke).
- `audit/probes/x5r/e2e/r-fastify-still-loads.mjs` — GREEN at a571079 (Z5-build effect; regression-guard).
- `audit/probes/x5r/run-all.mjs` — sequential driver. Default tier = functional + light regression. Heavy regression behind `NIMBUS_X5R_HEAVY=1`. E2E behind `NIMBUS_X5R_E2E=1`.

Run-all RED baseline (BASE=http://127.0.0.1:8787 NIMBUS_X5R_E2E=1):
```
x5r run-all: 5 passed, 3 failed of 8 probes
Failures:
  - functional/r-stream-eventemitter-shape.mjs
  - e2e/r-cache-class-extends.mjs
  - e2e/r-redis-loads.mjs
```
Saved as `audit/probes/x5r/run-all-RED-pre-fix.txt`.


### Phase D — Build (DONE)

Fix applied at `src/node-shims.ts:1782` (immediately after `builtins.stream = __streamMod;`):

```ts
// X.5-R: real Node's `require('stream')` re-exports EventEmitter
// (verified: `require('stream').EventEmitter === require('events').EventEmitter`
// in Node 20). Older CJS code reads EE off the stream module instead of
// events — e.g., @redis/client/dist/lib/client/cache.js:301:
// `class ClientSideCacheProvider extends stream_1.EventEmitter {}` where
// `stream_1 = require("stream")`. Without this re-export, `stream_1.EventEmitter`
// is undefined and `class … extends undefined` throws "Class extends value
// undefined is not a constructor or null". See audit/sections/X5R-plan.md §3
// + audit/probes/x5r/functional/r-stream-eventemitter-shape.mjs.
// Idempotent guard so a future streams.ts revision that already exposes
// EventEmitter doesn't get clobbered.
if (!__streamMod.EventEmitter) __streamMod.EventEmitter = __eventsMod;
```

Diff stat: 1 logic line + 11 comment lines = 12 LOC. Single-file, single-region change.

E2E follow-up: regex match for `r_redis_` artifact filename in `r-redis-loads.mjs` (was matching legacy `pkgsmoke_` prefix from the verify-700420f harness) — corrected to match the X5R-prefix used by this probe.

Verification:
- `r-stream-eventemitter-shape.mjs`: 6/6 PASS (was 1/6 RED).
- `r-cache-class-extends.mjs`: 3/3 PASS (was 0/3 RED).
- `r-redis-loads.mjs`: 3/3 PASS (was 0/3 RED).
- `r-fastify-still-loads.mjs`: 3/3 PASS (still GREEN).
- All regression guards (Z5 prototype, EE lazy-init, single-resolver, install-pipeline-coverage): still GREEN.
- `bun x tsc --noEmit`: 2 baseline errors (esbuild-wasm/esbuild.wasm + nimbus-session-init Sqlite type), **byte-identical to verify-700420f baseline** (no new errors from X5R).
- run-all (functional + light regression + e2e): **8/8 PASS**.

Snapshots:
- `audit/probes/x5r/run-all-RED-pre-fix.txt` (5/8, before src/ change)
- `audit/probes/x5r/run-all-GREEN-post-fix.txt` (8/8, after src/ change)


### Phase E — Audit (DONE)

See `audit/probes/x5r/AUDIT-SUMMARY.md`.

Bottom line:
- **X5R run-all:** 8/8 PASS (functional 3/3, regression 2/2, e2e 3/3 with NIMBUS_X5R_E2E=1).
- **Cross-wave:** all 7 prior waves' probe suites still GREEN at HEAD ea88891. X.5-Z5-build's 1 fail (tailwindcss-vite e2e) confirmed pre-existing (verified by stash+re-run on 4dd336e).
- **External redis validation:** X5M e2e/redis.mjs flips ⚠→✅; X5NPQO e2e/redis.mjs PASS.
- **W1 regression:** PASS (external=0, twOk=true).
- **Mossaic regression:** FAIL — pre-existing (playwright REJECT_INSTALL); verified pre-X5R by stash+re-run.
- **tsc:** 2 baseline errors, byte-identical to verify-700420f baseline.


### Phase F — Push (DONE — best-effort)

```
$ git push origin x5r-events-class
remote: Access denied: grant not approved
fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/': The requested URL returned error: 403
```

Logged. Continued per dispatch.

### Phase G — Retro (DONE)

Authored `audit/sections/X5R-retro.md`. Summary:
- 1/2 dispatch packages flipped ✅ by X5R (redis); the other (fastify) was already ✅ at a571079 due to X5Z5-build's EE-shim mixin lazy-init side effect.
- Single root cause: `__streamMod.EventEmitter` was undefined; real Node re-exports it.
- 12 LOC fix in src/node-shims.ts:1782.
- 0 regressions across 7 prior X.5 wave probe suites + W1 + Mossaic (Mossaic + tailwindcss-vite e2e are pre-existing fails verified by stash+re-run on pre-X5R src/).
- tsc baseline preserved (2 errors byte-identical).
- 8/8 X5R run-all GREEN.
- All commits referenced their triggering probe + plan §.
- 7 phases ✓ (A: 06eab3e, B: 64beb8c, C: 4dd336e, D: ea88891, E: cc8e68c + 8a1408a refresh, F: 403 logged, G: this commit).

