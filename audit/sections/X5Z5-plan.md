# X.5-Z5 plan — scope each Bucket-Z5 package and rank for dispatch

> **Mode:** PLAN-ONLY investigation. No `src/` edits. All claims
> cite file:line evidence.
> **Source bucket:** `audit/sections/VERIFY-90993B3.md` §3 Bucket Z5
> (4 packages: express, tailwindcss-oxide, tailwindcss-vite, ts-jest).
> **Branch:** `x5z5-investigation` (audit-only).
> **Local main HEAD at investigation start:** `90993b3`.

## TL;DR

The four Bucket-Z5 packages are **four independent root causes**,
not a single fix-class. Three are concrete-fix-ready
(express, ts-jest, tailwindcss-vite) with small src/ deltas
(combined ≤30 LOC). The fourth (tailwindcss-oxide) is upstream-blocked
by workerd's `node:wasi` stub; the honest action is REJECT not SWAP.

| Pkg | Root-cause class | Fix LOC | Dispatchable now? | Predicted ✅ delta |
|---|---|---|---|---|
| **ts-jest** | missing `fs.realpathSync.native` shim | ~3 LOC | yes | +1 |
| **tailwindcss-vite** | `looksLikeEsm` regex misses minified ESM | ~2 LOC | yes | +1 (possibly more) |
| **express** | `__streamMod` namespace has no `.prototype` + unguarded `util.inherits` | ~7 LOC | yes — *after* X.5-NPQO merges | +1 |
| **tailwindcss-oxide** | workerd `node:wasi` stub (upstream) | ~6 LOC (REJECT entry) | yes | 0 ✅ but +1 ⛔ healthy |

**Recommended dispatch order: tailwindcss-vite → ts-jest →
tailwindcss-oxide → express.** See §6.

---

## §1. express — `Object prototype may only be an Object or null: undefined`

### 1.1 Root cause (file:line)

Two stacked defects, both in our shim layer:

**Defect A** — `__streamMod` is a plain namespace object, no `.prototype`.

`src/streams.ts:380-386` returns:
```ts
return {
  Readable, Writable, Duplex, Transform, PassThrough,
  Stream: Readable,
  pipeline, finished,
  // Aliases for compatibility
  _Readable: Readable, _Writable: Writable, _Transform: Transform,
};
```

Bound at `src/node-shims.ts:1706`: `builtins.stream = __streamMod`.
So `require('stream')` returns this object → `.prototype` is `undefined`.

In real Node.js, `require('stream')` returns the legacy `Stream`
class (a function) WITH `Readable`/`Writable`/etc. attached as
own properties. Its `.prototype` resolves to `Stream.prototype`.

**Defect B** — `util.inherits` shim doesn't guard against undefined parent.

`src/node-shims.ts:708`:
```ts
inherits: (c, s) => { c.super_ = s; c.prototype = Object.create(s.prototype, { constructor: { value: c } }); },
```

No `s == null` / `s.prototype == null` check. Compare the canonical
pure-JS `inherits` package's browser fallback at
`/tmp/ts-probe/inh/package/inherits_browser.js`:
```js
module.exports = function inherits(ctor, superCtor) {
  if (superCtor) {  // ← guard
    ctor.super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, {...});
  }
};
```

### 1.2 Reproduction trail

express → body-parser@1 → raw-body → http-errors → readable-stream@2.
`readable-stream@2/lib/_stream_writable.js:67-96` (verbatim, downloaded
2026-05-05):

```js
67: var util = Object.create(require('core-util-is'));
68: util.inherits = require('inherits');
78: var Stream = require('./internal/streams/stream');   // → require('stream')
96: util.inherits(Writable, Stream);                     // ← throws
```

Verbatim runtime stack (`audit/probes/verify-90993b3/packages-local/express.out.txt:44-48`):
```
TypeError: Object prototype may only be an Object or null: undefined
    at Object.create (<anonymous>)
    at Object.inherits (runner.js:1110:60)
```

Reproduced locally in `audit/probes/x5z5-investigation/run-checks.cjs`
test 1 — verbatim error message match.

### 1.3 Fix architecture (recommended)

**Primary** (Defect A): synthetic `.prototype` on `__streamMod`.

`src/streams.ts:380-386`, replace the return object literal with:
```ts
const __streamMod = { Readable, Writable, Duplex, Transform, PassThrough,
  Stream: Readable, pipeline, finished,
  _Readable: Readable, _Writable: Writable, _Transform: Transform };
Object.defineProperty(__streamMod, 'prototype', {
  value: Readable.prototype, enumerable: false,
});
return __streamMod;
```

`Stream.prototype = Readable.prototype` matches the legacy semantics
(`stream.Stream` IS the legacy Stream class which inherits from
EventEmitter; Nimbus's `Readable` already extends `__eventsMod`, so
`Readable.prototype` is a superset of what callers expect on
`Stream.prototype`). Verified locally in `run-checks.cjs` test 2.

**Defensive** (Defect B): guard `util.inherits`.

`src/node-shims.ts:708`, replace with:
```ts
inherits: (c, s) => {
  if (s == null || s.prototype == null) return;
  c.super_ = s;
  c.prototype = Object.create(s.prototype, { constructor: { value: c, enumerable: false, writable: true, configurable: true } });
},
```

The `enumerable: false, writable: true, configurable: true` mirrors
real Node and the `inherits` browser fallback.

LOC: ~3 in `src/streams.ts` + ~4 in `src/node-shims.ts` = **~7 total**.

### 1.4 Predicted delta

- **+1 ✅** for express.
- Possibly +0-2 elsewhere (any package that pulls readable-stream@2
  AND calls `util.inherits(X, require('stream'))`). Verify-90993b3
  cohort has no other named flips.

### 1.5 Risks

- **Stream API surface compatibility.** Code that does
  `require('stream') instanceof Function` (rare) would change behaviour.
  Object-vs-function distinction is unreachable from typical
  `Stream.Readable` access patterns.
- **B-fix swallowing legitimate bugs.** Returning early when `s` is
  null silently no-ops the inheritance, masking real "I forgot to
  pass superCtor" bugs in user code. That matches the canonical
  `inherits_browser.js` semantics, so we're aligned with userland
  expectations.

### 1.6 Dependencies / sequencing

- **Blocker: X.5-NPQO is currently RUNNING and owns
  `src/node-shims.ts`.** Defect B's diff is at line 708 — which
  X.5-NPQO may have rewritten by merge time. **This wave must land
  AFTER X.5-NPQO merges** to avoid conflict thrash.
- Defect A is in `src/streams.ts` (separate file from the X.5-NPQO
  lock zone) — could in principle land independently, but the two
  fixes are paired and we want them in one wave for atomicity.
- No dependency on W2.6b cap or any other Z5 package.

---

## §2. tailwindcss-oxide — `Cannot find native binding. npm has a bug related to optional dependencies (#4828)`

### 2.1 Root cause (file:line)

The error is **emitted by oxide itself** at
`@tailwindcss/oxide@4.2.4/index.js:557-569` (verbatim, downloaded
2026-05-05) when both:

1. The platform-native `.node` requires fail (correct: workerd has
   no .node loader).
2. The `require('@tailwindcss/oxide-wasm32-wasi')` fallback fails.

Path 2 fails for two reasons (one immediate, one structural):

**Immediate** — the wasm32-wasi shard is silent-skipped at install
by `isOptionalNativeBinding` at `src/wasm-swap-registry.ts:637-655`:
- Line 640: `cpu: ["wasm32"]` matches the "non-empty `cpu` array"
  predicate.
- Line 611: `'@tailwindcss/oxide-'` matches the
  `NATIVE_SHARD_PREFIXES` check.

So `@tailwindcss/oxide-wasm32-wasi` never reaches node_modules.
Probe log `audit/probes/verify-90993b3/packages-local/tailwindcss-oxide.out.txt:28`:
```
[skip] @tailwindcss/oxide-wasm32-wasi — optional native binding (os=*, cpu=wasm32, libc=*, main=tailwindcss-oxide.wasi.cjs)
```

**Structural** — even with the shard installed, it would still fail.
From `audit/sections/04-native-mitigation.md:41,47-56`:

> `@tailwindcss/oxide-wasm32-wasi` requires `node:wasi`. … workerd's
> `node:wasi` constructor throws `ERR_METHOD_NOT_IMPLEMENTED('WASI')`
> — verified at https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/wasi.ts

This is upstream-blocked. We cannot ship a `node:wasi` shim that's
both workerd-correct AND functional, because workerd's own native
implementation deliberately throws.

### 2.2 Fix architecture (recommended: REJECT)

Add to `REJECT_INSTALL` at `src/wasm-swap-registry.ts:108`:

```ts
{
  from: '@tailwindcss/oxide',
  reason: 'NAPI Rust binding. The wasm32-wasi fallback (@tailwindcss/oxide-wasm32-wasi) requires node:wasi, which workerd implements as a throwing stub. See audit/sections/04-native-mitigation.md §F1.',
  suggest: 'No drop-in. Use Tailwind CSS v3 (pure-JS, works in Workers) or run Tailwind v4 in a build-time step outside the Worker and ship the resulting CSS.',
  transitive: 'warn',
},
```

`transitive: 'warn'` (not `'fail'`) is deliberate:
- `@tailwindcss/vite`, `@tailwindcss/postcss` legitimately depend
  transitively on oxide.
- Auto-failing those installs over-blocks users who don't actually
  invoke oxide at runtime (e.g., they pre-build CSS server-side and
  ship the CSS asset).
- The `'warn'` mode lets the install proceed, prints a clear
  message at install time, and the runtime error is the same as
  today (oxide's own throw — out of our reach).

LOC: **~6 lines** (one entry).

### 2.3 Why we can't SWAP it

There is no Workers-loadable WASM build of tailwindcss-oxide. The
upstream `wasm32-wasi` build is the closest thing, and it's
unreachable behind workerd's `node:wasi` throw. We tracked this in
W6.5 retro §S2 (a similar non-existent target for napi-rs/canvas):
"asking for a swap to a non-existent target is not satisfiable".

### 2.4 Predicted delta

- **0 ✅ flips** (this is not a fix — oxide will continue to fail at runtime).
- **+1 ⛔ healthy** (loud-reject at install replaces silent runtime crash).
- Per VERIFY-90993B3.md §"Healthy total (✅+⛔)", this counts as a
  health improvement.

### 2.5 Risks

- A future workerd release could ship a real `node:wasi`. At that
  point the REJECT could be flipped to a SWAP. This is a
  reversible decision — REJECT_INSTALL entries are easy to flip.
- Users who DO need Tailwind v4 with the oxide JIT path
  (e.g., they want at-runtime CSS generation in the Worker) will
  see the new install warning. The reason+suggest text steers them
  to Tailwind v3 or build-time generation, both of which are
  documented working paths.

### 2.6 Dependencies / sequencing

- Independent of all other Z5 packages and X.5-NPQO.
- Independent of any current X.5 cohort. Could land standalone any
  time.

---

## §3. tailwindcss-vite — `pre-compile failed at facet startup: Cannot use import statement outside a module`

### 3.1 Root cause (file:line)

`src/facet-manager.ts:766-776` `looksLikeEsm` regex has TWO blind spots
that compound to miss minified ESM output.

```ts
766: function looksLikeEsm(src: string): boolean {
769:   const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
772:   const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
774:   const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
775:   return importStmt.test(stripped) || exportStmt.test(stripped);
776: }
```

**Blind-spot A** — leading anchor `(^|\n)`. Minified ESM frequently
puts the first `import`/`export` AFTER a `;` on the same line:
`var X=...; var Y=...; import{...}from"..."`. None of `^`, `\n`
matches `;`.

**Blind-spot B** — required whitespace `\s+`. Minified ESM uses
`import{` with no space: `import{compile as M}from"@tailwindcss/node"`.
The `\s+` requires at least one whitespace char.

`@tailwindcss/vite/dist/index.mjs` (verbatim head, downloaded
2026-05-05):
```js
var C=(r,e)=>...,D=r=>{...};...;import{compile as M,env as _,...}from"@tailwindcss/node";...;export{O as default};
```

First `import` at byte 792, char before is `;` (verified by
`audit/probes/x5z5-investigation/run-checks.cjs` test 5).

`looksLikeEsm` returns false → `transformEsmInBundle` skips the
file → ships as-is → `new Function(...)` rejects ESM → recorded
in `__compileFailures` → `__loadModule` surfaces the SyntaxError
at `src/node-shims.ts:2170-2174`.

### 3.2 Fix architecture

`src/facet-manager.ts:772,774` → replace both regexes:

```ts
const importStmt = /(^|[\n;}])\s*import[\s{]/;
const exportStmt = /(^|[\n;}])\s*export[\s{*]/;
```

Both relaxations are needed:
- Adding `[\n;}]` alone won't catch `;import{` because `\s+` still
  rejects the no-whitespace import.
- Replacing `\s+` with `[\s{]` alone won't help because the leading
  anchor still requires a newline.

False-positive guard verified in `run-checks.cjs` test 6:
`var importedX = 1; var exportable = {};` does NOT match (the next
char after `import` is `e`, not `[\s{]`).

LOC: **2 lines** at `src/facet-manager.ts:772,774`.

### 3.3 Predicted delta

- **+1 ✅** for `@tailwindcss/vite`.
- **possibly more** in the broader cohort — any package shipping a
  minified `.mjs` with `;import` or `import{`. Re-running the
  verify-90993b3 sweep post-fix would quantify. Conservative
  estimate: **+1, optimistic +2-3.**

### 3.4 Risks

- False positives where a CJS file happens to contain `;import{`
  inside a string literal (e.g. a test fixture asserting on import
  syntax). The cost is one wasted esbuild-transform call (esbuild
  on already-CJS input is a no-op). Not a correctness regression.
- The previous `\s+` was likely added to avoid false-positives on
  identifiers like `imports`, `exporting`. Our `[\s{]` after
  `import` keeps that property — `importedX` doesn't match because
  `e` ∉ `[\s{]`.

### 3.5 Dependencies / sequencing

- Independent of all other Z5 packages.
- Independent of X.5-NPQO (diff is in `src/facet-manager.ts`, not
  `src/node-shims.ts`).
- Could land **today**.

---

## §4. ts-jest — `Cannot read properties of undefined (reading 'native')`

### 4.1 Root cause (file:line)

`src/node-shims.ts:580-638` defines `__fsMod`'s return object. The
key set is:

```
readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
readdirSync, mkdirSync, unlinkSync, rmdirSync, renameSync, copyFileSync,
readFile, writeFile, stat, readdir, exists, mkdir, unlink, access,
promises, constants, createReadStream, createWriteStream,
watch, watchFile, unwatchFile
```

**No `realpathSync`.** Only the async `promises.realpath` at
`src/node-shims.ts:520`.

TypeScript's `getNodeSystem` evaluates `_fs.realpathSync.native` as
part of bootstrap.

`/tmp/ts-probe/package/lib/typescript.js:8247` (typescript-5.6.3, verbatim):
```js
const fsRealpath = !!_fs.realpathSync.native ? process.platform === "win32" ? fsRealPathHandlingLongPath : _fs.realpathSync.native : _fs.realpathSync;
```

The `!!_fs.realpathSync.native` access reads `.native` of `undefined`
→ exact error message `Cannot read properties of undefined (reading 'native')`.

Verified the same expression in TS 6.0.3 (latest, 2026-05-05) at
`/tmp/ts-probe/ts60/package/lib/typescript.js:8289`. Pattern is
structural to TypeScript's getNodeSystem; doesn't depend on minor
version.

### 4.2 Hypothesis correction

Prior retros (X5F-retro line 147, X5G-retro line 210, X5C-plan §"out of
charter" line 100) speculated that **typescript.js was being evicted
by the W2.6b 22 MiB JSON-encoded cap**. That hypothesis is wrong:

- The cap-eviction failure surface is `Cannot read module: <path>`
  at `src/node-shims.ts:2129`.
- The verbatim runtime stack
  (`audit/probes/verify-90993b3/packages-local/ts-jest.out.txt:64-72`)
  shows `getNodeSystem ... <anonymous>:8291:43` — INSIDE the
  loaded typescript module body. typescript.js IS in the bundle.

So the W2.6b cap MAY also be a problem (typescript.js raw is 9 MiB; we have a 22 MiB JSON-encoded budget which fits but with little headroom), but it's not the current Z5 blocker.

### 4.3 Fix architecture

Add to `__fsMod`:

```ts
function realpathSync(p, opts) { return _resolve(String(p)); }
realpathSync.native = realpathSync;
```

…and add `realpathSync` to the return object literal at
`src/node-shims.ts:581`.

The body is a no-op symlink resolver (we have no symlinks in VFS).
TypeScript only uses the `.native` static for truthiness gating —
both the `_fs.realpathSync.native` and `_fs.realpathSync` branches
of the ternary are functionally equivalent when bound to the same
function.

Verified locally in `run-checks.cjs` tests 3 & 4.

LOC: **~3 lines** in `src/node-shims.ts` (function defn + truthy
binding + return-object word).

### 4.4 Predicted delta

- **+1 ✅** for ts-jest.
- **possibly +1** if `typescript` itself is in the verify cohort
  and has the same blocker (need to check; `bare require('typescript')`
  hits the same getNodeSystem path).
- Possible positive interaction with `ts-node` (X.5-J's regression
  fix may have addressed a different part of the same chain;
  worth a re-probe).

### 4.5 Risks

Negligible. `path.resolve(p)` is a strict superset of "no-op
symlink resolution" for VFS paths. Zero callers in the verify cohort
depend on realpathSync producing a TRULY canonical path
(symlink-resolved); if any do, they fail as today.

### 4.6 Dependencies / sequencing

- Independent of other Z5 packages.
- **Same X.5-NPQO sequencing concern as express** — the diff is in
  `src/node-shims.ts`. Land after X.5-NPQO merges to avoid rebase
  thrash.
- Independent of W2.6b (the prior hypothesis was wrong).

---

## §5. Cross-cutting decisions

### 5.1 Are any of these the same root cause?

**No.** Despite superficial resemblance (express + ts-jest both
"undefined property access in shim layer"), the structural defects
are distinct:

- **express**: `__streamMod` exports the wrong SHAPE
  (object instead of callable Stream class with namespace properties).
- **ts-jest**: `__fsMod` is missing a SYMBOL (`realpathSync` and
  its `.native` static).

Bundling them into one wave is possible but adds no leverage —
each fix is independently verifiable and independently testable
with a different package smoke-test.

**tailwindcss-vite** is in `src/facet-manager.ts` (compile-time
ESM detection). Different file, different abstraction.

**tailwindcss-oxide** is upstream-blocked; no src/ logic fix
applies.

### 5.2 Does any package depend on a parent enabler?

| Pkg | Depends on a parent enabler? |
|---|---|
| express | **No.** Stream-shape fix is self-contained. |
| ts-jest | **No.** realpathSync addition is self-contained. (Prior W2.6b dependency hypothesis was wrong.) |
| tailwindcss-vite | **No.** looksLikeEsm regex fix is self-contained. |
| tailwindcss-oxide | **Yes** — workerd `node:wasi`. Upstream block, not a Nimbus enabler. |

So 3 of 4 are dispatchable independently. The 4th (oxide) is
dispatchable as REJECT but doesn't unblock the runtime — it
upgrades a silent ⚠ to an honest ⛔.

### 5.3 Are any pair of these worth bundling into one wave?

Two pairs to consider:

**(express, ts-jest)** — both touch `src/node-shims.ts`. Bundling
saves one rebase against X.5-NPQO. Both are ~7 LOC and ~3 LOC
respectively. **Recommended bundle as one wave** ("X.5-Z5a:
shim-shape gaps") to amortise the X.5-NPQO conflict resolution
cost.

**(tailwindcss-vite, tailwindcss-oxide)** — same prefix, same
upstream project. But the fixes are in completely different files
(`src/facet-manager.ts` vs `src/wasm-swap-registry.ts`), independent
test surfaces, independent risk profiles. **Do not bundle.**

### 5.4 What's NOT in scope

- W2.6b ROI re-evaluation. The X5G-retro / X5F-retro / W2.6a-retro
  cap-eviction speculation around ts-jest was wrong; ts-jest's
  blocker is realpathSync, not the cap. But that doesn't update
  the W2.6b ROI math elsewhere — there are still real cap
  pressures (typescript.js squeezes us close to 22 MiB encoded;
  any future +1-2 MiB packages would push us over). W2.6b stays
  on its existing trajectory per W2.6a-retro §5.
- A general-purpose `cpu: ["wasm32"]` carve-out from
  `isOptionalNativeBinding`. The oxide REJECT punts that decision
  until we identify a wasm32-wasi package that doesn't
  transitively touch `node:wasi`. None in the current verify
  cohort.

---

## §6. Dispatch order — package-count-unblocked / effort

Three concrete fixes + one REJECT. Ranked by ROI (✅+⛔ delta /
effort) AND scheduling constraints (X.5-NPQO write-lock on
node-shims.ts).

### Rank 1: tailwindcss-vite — DISPATCH NOW

- **Effort:** 0.25 day. 2 LOC + 1 functional probe + e2e re-probe.
- **Delta:** +1 ✅ guaranteed; possibly +1-3 more from minified-ESM
  packages elsewhere in the cohort.
- **No conflict with X.5-NPQO** (diff in `src/facet-manager.ts`).
- **No upstream dependency.**
- **Why first:** highest leverage, lowest risk, fastest to land. The
  e2e re-probe sweep alone may turn up extra ✅ flips that change
  Phase-7 prioritisation.

### Rank 2: ts-jest — DISPATCH AFTER X.5-NPQO merges

- **Effort:** 0.25 day. 3 LOC + functional probe (verify
  `_fs.realpathSync.native` is callable post-fix) + e2e re-probe.
- **Delta:** +1 ✅ guaranteed; possibly typescript / ts-node bonus.
- **Conflict:** `src/node-shims.ts` write-lock owned by X.5-NPQO.
- **No upstream dependency.**
- **Why second:** small, safe, but waits for the lock.

### Rank 3: tailwindcss-oxide — DISPATCH ANY TIME (independent)

- **Effort:** 0.25 day. ~6 LOC (one REJECT entry) + a `npm install
  @tailwindcss/oxide` install-warning probe.
- **Delta:** 0 ✅, +1 ⛔ healthy.
- **No conflict with anything.**
- **Why third (not first):** the delta is honest reject not flip.
  Lower ROI on the verify cohort's ✅ count, but valuable for
  install-time clarity. Could parallel-dispatch with rank 1 since
  the files don't overlap.

### Rank 4 (bundled with rank 2): express — DISPATCH AFTER X.5-NPQO merges

- **Effort:** 0.5 day. ~7 LOC + `streams` test + e2e re-probe.
  Slightly more work than ts-jest because the streams.ts diff is
  more thoughtful and has a wider blast radius.
- **Delta:** +1 ✅.
- **Conflict:** `src/node-shims.ts` write-lock owned by X.5-NPQO
  (defect B at line 708).
- **Why fourth, bundled with ts-jest:** both fixes touch
  node-shims.ts. Bundling saves one rebase cycle. Combined wave
  is "X.5-Z5a — shim-shape gaps (express + ts-jest)", ~10 LOC,
  ~0.5 day.

### Recommended schedule

```
Day 1  (parallel)
  ├── X.5-Z5b: tailwindcss-vite              [src/facet-manager.ts]
  └── X.5-Z5c: tailwindcss-oxide REJECT      [src/wasm-swap-registry.ts]

After X.5-NPQO merges
  └── X.5-Z5a: shim-shape gaps               [src/streams.ts + src/node-shims.ts]
              (express + ts-jest, bundled — one rebase, two flips)
```

Total: 3 waves, ~1 day cumulative effort, predicted **+3 ✅ +1 ⛔**
healthy delta on the verify-90993b3 cohort (33 → 36 ✅ +1 ⛔ = 37/33
healthy = 112%? No — "healthy" denominator stays the same 33.
**Cumulative healthy: 25/33 (76%) → 28/33 ✅ + 1/33 ⛔ = 29/33 (88%)**).

The actual numbers depend on how the post-X.5-NPQO baseline shifts;
we should re-baseline before dispatch.

---

## §7. References

- `audit/sections/VERIFY-90993B3.md:301-309` — Bucket Z5 source.
- `audit/sections/04-native-mitigation.md:41,47-56,145` —
  `node:wasi` upstream block (oxide).
- `audit/sections/W2.6a-retro.md:80-112` — W2.6b ROI / "skip for
  now, monitor". Updated by this plan: ts-jest is NOT in W2.6b's
  scope.
- `audit/probes/x5z5-investigation/*.probe.md` — per-package
  static-analysis probes.
- `audit/probes/x5z5-investigation/run-checks.cjs` — 7-test
  reproduction script (all ok).
- `audit/probes/x5z5-investigation/run-checks.out.txt` — captured
  output.
- `audit/probes/verify-90993b3/packages-local/{express,tailwindcss-oxide,tailwindcss-vite,ts-jest}.out.txt` — runtime evidence.
