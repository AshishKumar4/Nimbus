# X.5-R — events / class-extends-undefined unification — PLAN

> Branch: `x5r-events-class` (forked from local main `a571079`).
> Mode: BUILD. P0 per `audit/sections/VERIFY-700420F.md` §4 #1.
> Predicted in dispatch: ~10-30 LOC, +2 ✅ → 25/33 strict.

## Self-review TL;DR

The dispatch framed Bucket R as a **single root cause** (events
EventEmitter inheritance) covering both **fastify** and **redis**.
Phase A reproduction at HEAD `a571079` shows the goalposts have
moved:

- **fastify is ALREADY GREEN** at `a571079`. X.5-Z5-build's
  EE-shim mixin lazy-init (`(this._e ??= {})` in EE.on/once/emit/…)
  in `src/node-shims.ts:694-710` already heals avvio's
  `Plugin.once('start', cb)` path. The `Plugin.on (runner.js:708:38)
  reading 'start'` failure at 700420f is gone.
- **redis is STILL RED** at `a571079`, with the same error shape
  (`Class extends value undefined` at runner.js:34:34, `eval anon:303:48`).
  The failing site is `@redis/client/dist/lib/client/cache.js:301`
  — `class ClientSideCacheProvider extends stream_1.EventEmitter`,
  where `stream_1 = require("stream")`. **Our `__streamMod` does
  not expose `.EventEmitter`** (real Node does, since `stream` and
  `events` co-export EE for legacy compat).

So: bucket R is a **divergent two-package issue** that already
resolved itself for fastify (via Z5-build) and now requires a
narrow stream-module surface fix for redis only.

**Predicted final delta:** +2 ✅ vs the 700420f baseline (fastify
was already +1 from Z5-build, this wave delivers redis +1). At
the a571079 baseline the +1 attributable to X5R is redis alone.

## 1. Investigation summary

See `audit/probes/x5r/investigation/REPRO-NOTES.md` for the full
forensic. Key facts:

1. **fastify@5.8.5** at `a571079`: smoke `const m=require('fastify');
   const a=m(); console.log('app title:', a.constructor && a.constructor.name)`
   → exits 0, prints `app title: Object`. ✅
2. **redis@5.x** at `a571079`: smoke `const m=require('redis');
   console.log('keys:', Object.keys(m).slice(0,8))` → exits 1 with
   ```
   TypeError: Class extends value undefined is not a constructor or null
       at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:303:48)
       at __loadModule (runner.js:2776:7)
       at __requireFrom (runner.js:2867:10)
       at scopedRequire (runner.js:2761:33)
       at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:17:17)
       at __loadModule (runner.js:2776:7)
       at __requireFrom (runner.js:2867:10)
       at scopedRequire (runner.js:2761:33)
       at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:44:16)
       at __loadModule (runner.js:2776:7)
   ```
3. Stack frame mapping (anon source line → file): the failing
   `<anonymous>:303:48` corresponds to `dist/lib/client/cache.js`
   line 301 (with a 2-line CJS prologue offset). The chain is
   `redis/dist/index.js` → `@redis/client/dist/index.js` →
   `@redis/client/dist/lib/client/index.js` →
   `@redis/client/dist/lib/client/cache.js`. The cache module does:
   ```js
   const stream_1 = require("stream");                      // line 4
   // ...
   class ClientSideCacheProvider extends stream_1.EventEmitter   // line 301
   ```
4. Real Node check (`node -e "console.log(require('stream').EventEmitter
   === require('events').EventEmitter)"` → `true`): `stream` re-exports
   `EventEmitter`. Our `__streamMod` doesn't.

## 2. Root cause final

`__streamMod` (returned from `src/streams.ts:generateStreamsCode`)
lacks an `EventEmitter` member. It currently exposes:

```js
const __streamMod = {
  Readable, Writable, Duplex, Transform, PassThrough,
  Stream: Readable,
  pipeline, finished,
  _Readable: Readable, _Writable: Writable, _Transform: Transform,
};
Object.defineProperty(__streamMod, 'prototype', {
  value: Readable.prototype, enumerable: false,
});
```

When `require('stream').EventEmitter` is read, the result is
`undefined`, and `class … extends undefined` throws.

This is **not an events-module bug**. The events shim already correctly
exposes `__eventsMod.EventEmitter = __eventsMod` (line 711 of
node-shims.ts) — and X.5-Z5-build's lazy-init makes inheritance via
`util.inherits(C, EventEmitter)` plus mixin-copy patterns safe. The
gap is solely that **the legacy `stream.EventEmitter` re-export
surface is not mirrored**.

This was masked at 700420f by (a) the express+fastify failures
landing earlier in the require graph and bailing the test, and (b)
no probe in any prior wave exercising `require('stream').EventEmitter`
explicitly.

## 3. Fix sketch

### 3.1 Source change

Single-locus addition in `src/node-shims.ts`, immediately after the
existing `builtins.stream = __streamMod;` registration (currently
line 1781):

```diff
 builtins.events = __eventsMod;
 builtins.stream = __streamMod;
+// X.5-R: real Node's `require('stream')` re-exports EventEmitter
+// (verified: stream.EventEmitter === events.EventEmitter).
+// Older CJS code (e.g., @redis/client/dist/lib/client/cache.js:301
+// — `class ClientSideCacheProvider extends stream_1.EventEmitter`)
+// reads it from the stream module rather than events. Mirror the
+// real-Node surface so that pattern works.
+// See audit/sections/X5R-plan.md §3 + audit/probes/x5r/investigation/REPRO-NOTES.md.
+if (!__streamMod.EventEmitter) __streamMod.EventEmitter = __eventsMod;
 builtins.buffer = { Buffer: __BufferMod };
```

LOC count: 5 lines (1 if-guard + comment).

### 3.2 Why an `if`-guard rather than unconditional assignment

`__streamMod` is built inside an IIFE in `src/streams.ts`'s template;
a future change there might add `EventEmitter` directly. The
`if (!…)` guard makes this fix idempotent if streams.ts is updated to
include EE itself (no second authority needed in `node-shims.ts`).

### 3.3 Why not in `src/streams.ts`

Streams template can't reference `__eventsMod` directly because the
IIFE body is read by humans as a self-contained "real Node streams"
module — entangling it with EE makes future maintenance noisier. The
streams.ts-level fix would also require either:
- importing `__eventsMod` (which is a free identifier in the
  generated runner — works, but conceptually leaks the shim's
  scoping into streams.ts), or
- wrapping returned object after IIFE.

Both work, but the post-IIFE approach in `node-shims.ts` is cleaner
because the EE↔stream binding is a Node API surface concern, not a
"how do streams work" concern.

### 3.4 Alternative fixes considered and rejected

| Option | Rationale | Verdict |
|---|---|---|
| Plant `EventEmitter` inside `__streamMod` IIFE | Cross-cuts streams.ts (which is conceptually self-contained) | Rejected (see 3.3) |
| Inject `EventEmitter` only into `node:stream`, not `stream` | Real Node aliases both, redis cache.js uses `require("stream")` (no node: prefix); also fails | Rejected |
| Patch redis source via wasm-swap-registry | Single-package band-aid; doesn't generalize | Rejected — the fix is a Node-surface gap, ought to be at the shim |
| Add EE re-export to ALL EE-extending modules (net.Server, http.Server, repl, etc.) | Real Node only re-exports EE on `stream` and `events` themselves | Rejected — over-scope |

### 3.5 File:line scope

`src/node-shims.ts` only. ~5 LOC near line 1781. No other src/ file
touched. **Hard anti-requirements respected:**
- ❌ NOT touching `src/require-resolver.ts`
- ❌ NOT touching `src/npm-resolver.ts`
- ❌ NOT touching `src/npm-resolve-facet.ts`

## 4. Regression matrix

The ≤5 LOC change in src/ MUST NOT regress any of the following.
Each row will have a probe in `audit/probes/x5r/regression/` that
either reuses an existing harness or directly asserts the invariant.

| Invariant | Source / probe | Why protected |
|---|---|---|
| Single-resolver invariant (W2.6a → X5F → X5J → X5L → X5NPQO) | `audit/probes/x5f/regression/single-resolver-source.mjs` | This wave touches no resolver; must hold by construction. |
| install-pipeline-coverage shim (X5F R1) | `audit/probes/x5f/regression/install-pipeline-coverage.mjs` | Stream-module surface change cannot affect install pipeline. |
| EE-shim mixin lazy-init (X5Z5-build) | new functional probe `r-ee-lazy-init-still-works.mjs` | The lazy-init guard already shipped; we add to `__streamMod`, not `__eventsMod`. |
| `__streamMod.prototype` plant (X5Z5 Defect-A) | new functional probe `r-stream-prototype-still-pointed.mjs` | Adding `.EventEmitter` cannot disturb `.prototype` (different keys). |
| `util.inherits` null-guard (X5Z5 Defect-B) | new functional probe `r-util-inherits-still-guarded.mjs` | Untouched. |
| Mossaic regression baseline | `audit/probes/run-mossaic-prod-w2.mjs` (existing, ts-driven) | Mossaic — large prod-style smoke; must remain green. |
| W1 regression baseline | `audit/probes/run-wave1-regression-w2.mjs` | W1 — original baseline; must remain green. |
| tsc clean (modulo 2 baseline) | `bunx tsc --noEmit` | The 2 baseline errors documented in VERIFY-700420F.md §2 must remain the only errors. |

## 5. Probe matrix

Files to author this wave (Phase C — RED before src/ change, Phase
D — flip GREEN as the src/ fix lands):

### `audit/probes/x5r/functional/`

1. **`r-stream-eventemitter-shape.mjs`** — synth a `__streamMod`
   built from the current source and assert `__streamMod.EventEmitter`
   is a function whose `.prototype` is the EE prototype, and that
   `class X extends __streamMod.EventEmitter {}` succeeds. RED at
   start (.EventEmitter is undefined). GREEN after the fix.

2. **`r-stream-prototype-still-pointed.mjs`** — assert that
   `Object.getOwnPropertyDescriptor(__streamMod, 'prototype')`
   still returns a non-enumerable descriptor whose `value ===
   __streamMod.Readable.prototype` (Z5 Defect-A invariant). Always
   GREEN — guards against the new fix accidentally clobbering
   `.prototype`.

3. **`r-ee-lazy-init-still-works.mjs`** — invoke `EE.on/once/emit/off`
   on a mixin-copied target (no constructor) and assert no throw,
   no NaN listeners, no leaked state. Always GREEN — guards Z5
   lazy-init.

### `audit/probes/x5r/regression/`

4. **`r-single-resolver-source.mjs`** — re-run the X5F regression
   probe shape (count exactly one `function resolveExports` decl
   in `src/_shared/exports-resolver.ts`).

5. **`r-install-pipeline-coverage.mjs`** — wrap-call the X5F
   install-pipeline-coverage probe to assert wave R didn't disturb
   it. Just delegates.

6. **`r-mossaic.mjs`** — wrap the Mossaic harness if it can run
   without prod credentials (else skip with a recorded SKIP).

7. **`r-w1.mjs`** — wrap the W1 regression harness similarly.

### `audit/probes/x5r/e2e/`

8. **`r-redis-loads.mjs`** — drive a fresh nimbus session via the
   `_driver.mjs` runProbe shape, install redis, attempt
   `require('redis')`, assert exit code 0 and stdout contains
   `keys:`. RED at start, GREEN after fix.

9. **`r-fastify-still-loads.mjs`** — same shape, fastify. Always
   GREEN at `a571079` — but we re-assert here so a future
   regression in EE-shim or stream-shim is caught at the bucket-R
   layer.

10. **`r-cache-class-extends.mjs`** — synth the redis failure mode
    in pure isolation (a 5-line CJS module that does
    `const stream = require("stream"); module.exports = class extends
    stream.EventEmitter {}`), drive the facet to load and assert
    `typeof exports === 'function'`. RED at start, GREEN after fix.
    This is the smallest-possible reproducer.

### Run-all driver

`audit/probes/x5r/run-all.mjs` — sequential invocation of probes
1-7 (functional + regression) by default; e2e probes 8-10 gated on
`NIMBUS_X5R_E2E=1` since they require a live wrangler dev. Output
to `audit/probes/x5r/run-all.txt`.

## 6. Phase boundaries

| Phase | Output | Commit gate |
|---|---|---|
| A — Investigate | `REPRO-NOTES.md`, repro outputs | committed (`06eab3e`) |
| B — Plan | this file | this commit |
| C — TDD RED | probes 1, 2, 3, 8, 9, 10 RED-asserting against current src/ | every probe authored before src/ edit |
| D — Build | `__streamMod.EventEmitter = __eventsMod` (~5 LOC), one commit per logical unit | each probe flipped GREEN with its own commit reference |
| E — Audit | `run-all.txt`, `bunx tsc --noEmit` baseline preserved, mossaic + W1 reruns | all PASS gate |
| F — Push | `git push origin x5r-events-class` (403 expected, log + continue) | best-effort |
| G — Retro | `X5R-retro.md` | final commit |

## 7. Hard anti-requirements (re-stated for safety)

- **NO** silent completion. Stuck → `audit/sessions/x5r-stuck.md` + exit.
- **NO** src/ change without a green-turning probe (TDD).
- **NO** files outside the worktree.
- **NO** push to main.
- **NO** unreviewed commits — each commit message references its
  triggering probe + plan §.
- **NO** pause for user input.
- **DO NOT** touch `src/require-resolver.ts`, `src/npm-resolver.ts`,
  `src/npm-resolve-facet.ts`.
- **DO NOT** prod-deploy.

## 8. Predicted ✅ count delta

Aginst the verify-700420f baseline (23/33):
- Bucket R unblocks fastify (already done, +1) and redis (this wave,
  +1). **Total: +2 → 25/33 (76%).**

Against the a571079 working baseline (presumed 23/33 still since
no full re-sweep has run since X5Z5-build merged — but X5Z5-build's
own retro recorded **+1 ✅ for express** and an in-passing **+1 ✅
for fastify** masquerading as a Z3 follow-on, so a571079 baseline
may already be 24/33 or 25/33):
- This wave adds redis: **+1**.

A full 33-package re-sweep at `a571079 + this fix` is **out of scope
for X5R** but recommended as a follow-on verify wave.

## 9. Cross-references

- `audit/sections/VERIFY-700420F.md` §4 #1 (this wave's dispatch)
- `audit/sections/X5Z5-build-retro.md` §3 (EE-shim mixin lazy-init —
  the change that already healed fastify)
- `audit/sections/X5NPQO-retro.md` "Bottom line" §295-300
  (predecessor's "next dispatch" that named items 1+2 (fastify,
  redis) which Bucket R unifies)
- `audit/probes/verify-700420f/packages-local/{fastify,redis}.out.txt`
  (canonical 700420f failure shapes; `a571079` reproductions in
  `audit/probes/x5r/investigation/`)
- `src/node-shims.ts:685-714` (EE shim, `EE.EventEmitter = EE`)
- `src/streams.ts:generateStreamsCode` (`__streamMod` factory)
- `src/node-shims.ts:1781` (intended fix-site)
