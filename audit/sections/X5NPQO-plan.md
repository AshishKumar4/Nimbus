# X.5-NPQO — Combined wave: P (parent-dir) + Q (util/types) + N/A.

> **Wave kind:** Combined three-bucket wave; all three buckets touch
> `src/node-shims.ts`, scheduled together to avoid file-collision merges.
> **Worktree:** `/workspace/worktrees/x5npqo-node-shims` on branch
> `x5npqo-node-shims`. Base: local main HEAD `90993b3`.
> **Charter:** flip ≥3/4 of {fastify, redis, jsdom, vite} from ⚠ → ✅ at the
> real-package install layer.
> **Reference:** VERIFY-90993B3.md §3 buckets P, Q, O (origin commit `e62cefc`).

---

## TL;DR

Three independent shim fixes, each in `src/node-shims.ts`, in non-conflicting
regions:

| Bucket | Region | Pkgs unblocked | LOC | Order |
|---|---|---|---:|---:|
| P — bare `.`/`..` parent-dir specifier | `__resolveFrom` ~line 2196-2218 | fastify, redis | ~5-10 | 1 |
| Q — util/types subpath + polyfill expansion | `util` shim + builtins reg ~line 707 + ~line 1882 | jsdom | ~15-20 | 2 |
| O — fs-URL composition (`file://` → POSIX) | fs `_resolve` ~line 159-163 | vite | ~5-10 | 3 |

**Predicted:** +4 ✅ flips → 27/33 (82%) strict healthy. Matches
VERIFY-90993B3.md §4 cumulative dispatch math.

## 0. Confirmed line numbers (re-measured at `90993b3` worktree HEAD)

```
src/node-shims.ts: 2258 lines total
  fs `_resolve` helper:               line 159-163  (Bucket O loci)
  util.types polyfill object:         line 707      (Bucket Q expand-here)
  M-2 dns/promises subpath reg:       line 1880-1881 (Bucket Q register-after-here)
  __resolveFrom relative-guard:       line 2196-2218 (Bucket P loci, line 2198)
```

All three regions are in different parts of the file — no sequencing
conflict, no merge-order dependency. Order chosen as P → Q → O for
narrative clarity (smallest first, investigation-required-bucket second,
fs-shim third).

---

## 1. Bucket P — bare `.` / `..` parent-dir specifier

### Failure shape (verify-evidence)

```
fastify: Cannot find module '..' (from .../ajv/dist/compile/jtd)
redis:   Cannot find module '.'  (from .../@redis/client/dist/lib/client)
```

### Root cause

`__resolveFrom` at `src/node-shims.ts:2196-2218` (current line numbers):

```ts
function __resolveFrom(id, fromDir) {
  if (id.startsWith("./") || id.startsWith("../") || id.startsWith("/")) {
    // … relative resolution
  }
  if (id.startsWith("#")) { … }
  return __resolveNodeModule(id, fromDir);   // ← FALLS THROUGH for "." / ".."
}
```

The literal 2-char identifiers `.` and `..` (NOT `./…` or `../…`) slip
past the relative guards (`startsWith("./")` requires at least 3 chars,
`startsWith("../")` requires at least 4) and fall into the bare-spec
branch, which queries `__resolveNodeModule(".")` for a package literally
named `.` — fails.

CommonJS spec for require: `require('.')` MUST resolve to the current
directory's `index.js` (or whatever `package.json#main` resolves to);
`require('..')` similarly resolves to the parent directory's index. Both
fastify (via ajv/dist/compile/jtd's internal layout) and redis (via
@redis/client/dist/lib/client/index.js) rely on this.

### Fix

At `src/node-shims.ts:2198`, normalize literal `.` and `..` into
`./index` and `../index` BEFORE the relative-resolve branch (so they
flow through `__resolveFile`'s package.json/index/extension probing):

```ts
function __resolveFrom(id, fromDir) {
  // X.5-P: literal `.` / `..` are CommonJS aliases for './' / '../'.
  // Normalize so they take the relative-resolve branch (which then
  // probes index.js / package.json#main via __resolveFile).
  let normalizedId = id;
  if (id === ".") normalizedId = "./";
  else if (id === "..") normalizedId = "../";

  if (normalizedId.startsWith("./") || normalizedId.startsWith("../") || normalizedId.startsWith("/")) {
    // … existing logic with `normalizedId` instead of `id`
  }
  // unchanged below
}
```

**LOC: ~5-7.**

### Probes

- **Functional** (`audit/probes/x5npqo/functional/p-parent-dir.mjs`) —
  synth fixture: a package whose internal file `lib/inner.js` does
  `require('.')` to load its own root index, and `require('..')` to load
  its parent dir's index. Drive through `__requireFrom` directly via the
  bundled facet runtime. RED before fix; GREEN after.
- **Regression** (`audit/probes/x5npqo/regression/p-relative-paths.mjs`)
  — sanity-check that `./foo`, `../bar/baz`, `/abs/path` still resolve
  identically post-fix.
- **E2E** (`audit/probes/x5npqo/e2e/fastify-install.mjs`) and
  (`audit/probes/x5npqo/e2e/redis-install.mjs`) — real `bun add fastify`
  and `bun add redis`, exercise via local wrangler dev install pipeline,
  verify the runtime require path goes deeper than the previous error.

### Charter expectation

`fastify` ⚠ → ✅, `redis` ⚠ → ✅. (If a deeper error surfaces, that's
charter-pass not strict-✅, and we log a follow-up bucket.)

---

## 2. Bucket Q — util/types subpath + polyfill expansion

### Failure shape (verify-evidence)

```
jsdom: Cannot find module 'node:util/types' (from .../undici/lib/web/fetch)
```

### Investigation outcome

See `audit/probes/x5npqo/investigate/Q-undici-types-survey.md`.

undici@7.25.0 (jsdom-bundled) and undici@8.2.0 both call:

- `isUint8Array` (in `lib/web/fetch/util.js`, `lib/web/fetch/body.js`)
- `isArrayBuffer` (in `lib/web/websocket/websocket.js`)
- `isProxy` (in `lib/web/fetch/headers.js` via parent `util.types.isProxy`)

The current 3-method polyfill (`isDate`, `isRegExp`, `isPromise` at
`src/node-shims.ts:707`) does NOT cover these symbols. A bare M-2-pattern
2-LOC subpath registration would still fail at first dereference.

**Verdict:** EXPAND polyfill to ~13 methods (the undici-required 3 + 10
defensive-mostly-instanceof additions to keep dependents from breaking),
THEN register the subpath via 2-LOC mirror of M-2.

### Fix

**Step 2a** — replace `src/node-shims.ts:707` (the single-line
`types: { isDate, isRegExp, isPromise }`) with a multi-line expanded
polyfill:

```ts
types: {
  isDate: (v) => v instanceof Date,
  isRegExp: (v) => v instanceof RegExp,
  isPromise: (v) => v instanceof Promise,
  isUint8Array: (v) => v instanceof Uint8Array,
  isArrayBuffer: (v) => v instanceof ArrayBuffer,
  isAnyArrayBuffer: (v) => v instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer),
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isMap: (v) => v instanceof Map,
  isSet: (v) => v instanceof Set,
  isWeakMap: (v) => v instanceof WeakMap,
  isWeakSet: (v) => v instanceof WeakSet,
  isNativeError: (v) => v instanceof Error,
  isAsyncFunction: (v) => v?.constructor?.name === 'AsyncFunction',
  isGeneratorFunction: (v) => v?.constructor?.name === 'GeneratorFunction',
  isProxy: (v) => false,  // no userland Proxy detection — undici treats false as fallthrough
  isBoxedPrimitive: (v) => v instanceof Boolean || v instanceof Number
    || v instanceof String || v instanceof Symbol || v instanceof BigInt,
},
```

**Step 2b** — append 2 LOC after `src/node-shims.ts:1881` mirroring M-2:

```ts
// X.5-Q: util/types subpath registration for undici (jsdom).
// Mirrors X.5-M M-2 (dns/promises) and the timers/promises pattern.
builtins["util/types"] = builtins.util.types;
builtins["node:util/types"] = builtins["util/types"];
```

**LOC: ~15-18 for polyfill + 4 for subpath reg + comments = ~22 total.**

### Probes

- **Functional** (`audit/probes/x5npqo/functional/q-util-types.mjs`) —
  drive `__requireFrom('node:util/types', '/home/user')` and
  `__requireFrom('util/types', '/home/user')`, verify all 13 keys are
  callable functions, verify `isUint8Array(new Uint8Array())===true`,
  `isArrayBuffer(new ArrayBuffer(8))===true`, `isProxy({})===false`.
- **Regression** (`audit/probes/x5npqo/regression/q-util-shape.mjs`) —
  verify the parent `util` module still exposes `format`, `inspect`,
  `promisify`, `inherits` etc. (no breakage from object-literal rewrite).
- **E2E** (`audit/probes/x5npqo/e2e/jsdom-install.mjs`) — real
  `bun add jsdom`, run a basic DOM construction script through the
  facet, verify the `Cannot find module 'node:util/types'` error is
  gone and jsdom executes.

### Charter expectation

`jsdom` ⚠ → ✅. (If a deeper undici-related error surfaces, that's
charter-pass; the verify §6 noted jsdom's ⛔→⚠ side-effect of X.5-J
indicates the install layer is healthy already.)

---

## 3. Bucket O — fs-URL composition gap

### Failure shape (verify-evidence)

```
vite: ENOENT: no such file or directory, open 'file:///package.json'
```

### Root cause

`src/node-shims.ts:159-163`:

```ts
function _resolve(p) {
  const s = String(p);
  if (s.startsWith("/")) return __pathMod.normalize(s);
  return __pathMod.resolve(cwd || "/home/user", s);
}
```

When vite's bundled CJS does `fs.readFileSync(new URL('./package.json',
import.meta.url))` (or passes a literal `file:///package.json` string),
`String(p)` produces `"file:///package.json"`, which fails the `/` guard
and gets misrouted via `path.resolve(cwd, "file:///package.json")` →
corrupt path → ENOENT.

### Fix

Strip `file://` prefix before the absolute-path check, AND handle URL
instance via duck-type (`URL` may not be in scope for all facets):

```ts
function _resolve(p) {
  // X.5-O: WHATWG-URL → POSIX path coercion.
  // Vite/rolldown-bundled CJS sometimes passes URL instances or
  // 'file://' strings to fs.readFileSync; String(URL) yields
  // 'file:///abs/path' which fails the '/' guard below and gets
  // misrouted via path.resolve(cwd, …). Strip the prefix first.
  let s;
  if (p && typeof p === "object" && p.protocol === "file:" && typeof p.pathname === "string") {
    // URL instance — pathname is already a POSIX path
    s = decodeURIComponent(p.pathname);
  } else {
    s = String(p);
    if (s.startsWith("file:///")) s = decodeURIComponent(s.slice(7));
    else if (s.startsWith("file://")) s = decodeURIComponent(s.slice(7));
  }
  if (s.startsWith("/")) return __pathMod.normalize(s);
  return __pathMod.resolve(cwd || "/home/user", s);
}
```

**LOC: ~10-12.**

### Probes

- **Functional** (`audit/probes/x5npqo/functional/o-fs-url.mjs`) — drive
  `__fsMod.readFileSync(new URL('file:///abs/path'))` AND
  `__fsMod.readFileSync('file:///abs/path')` against a VFS bundle entry,
  verify both succeed and return the same bytes as
  `__fsMod.readFileSync('/abs/path')`.
- **Regression** (`audit/probes/x5npqo/regression/o-fs-paths.mjs`) —
  verify plain absolute paths, plain relative paths, and the existing
  `_strip()` still work identically.
- **E2E** (`audit/probes/x5npqo/e2e/vite-install.mjs`) — real
  `bun add vite`, exercise the install pipeline, verify the previous
  `'file:///package.json'` ENOENT is gone.

### Charter expectation

`vite` ⚠ → ✅. (If a deeper error surfaces — likely vite's own resolver
chain — that's charter-pass and we log a follow-up bucket.)

---

## 4. Cross-cutting probes

- **Mossaic install-pipeline-coverage** (`audit/probes/x5f/regression/install-pipeline-coverage-shim.mjs`)
  must remain green post-fix — proves no regression in install pipeline.
- **W1 single-resolver-source** (`audit/probes/x5f/regression/single-resolver-source.mjs` and
  `audit/probes/x5j/regression/single-resolver-source.mjs`) must remain
  green.
- **tsc** must remain at the 2-error baseline (esbuild-wasm import +
  SqliteVFSProvider mismatch — both pre-existing per VERIFY-90993B3 §2).

## 5. Phases

| Phase | Goal | Output |
|---|---|---|
| A | Plan — confirm line numbers + Q investigation | `audit/sections/X5NPQO-plan.md` (this file) |
| B | TDD red — write all probes, confirm RED state | `audit/probes/x5npqo/{functional,regression,e2e}/` |
| C | Build — 3 commits in `src/node-shims.ts`, each referencing its probe | 3 commits on branch |
| D | Audit — all probes green + Mossaic + W1 + tsc | `audit/probes/x5npqo/.../*.out.txt` artifacts |
| E | Push best-effort — `git push origin x5npqo-node-shims` | log; 403 → continue |
| F | Retro — per-bucket verdict + util.types decision + nuxt status | `audit/sections/X5NPQO-retro.md` |

Progress logged at `audit/sessions/X5NPQO-progress.md` after each phase.

## 6. Anti-requirements (per dispatch)

- No silent completion — stuck → `audit/sessions/x5npqo-stuck.md` + exit
- No `src/` change without a green-turning test
- No file outside `/workspace/worktrees/x5npqo-node-shims/`
- No push to main, only the wave branch
- No `src/require-resolver.ts` or `src/npm-resolver.ts`/`npm-resolve-facet.ts` edits
- No prod deploy

## 7. Done criteria (mirrors dispatch)

- `audit/sections/X5NPQO-plan.md` (this file) committed
- `audit/sections/X5NPQO-retro.md` committed
- ≥3/4 of {fastify, redis, jsdom, vite} flip ✅ at real-package install layer
- `src/node-shims.ts` changes pushed (or stuck file written)
- `audit/sessions/X5NPQO-progress.md` shows all 6 phases ✓
- 0 regressions in any cross-cutting probe
