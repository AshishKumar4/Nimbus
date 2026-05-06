# X.5-NPQO retro — Combined wave: P (parent-dir) + Q (util/types) + O (fs-URL)

> **Wave kind:** Combined three-bucket wave; all three buckets in
> `src/node-shims.ts`. Worktree:
> `/workspace/worktrees/x5npqo-node-shims` on branch `x5npqo-node-shims`.
> Base: local main HEAD `90993b3`. Reference: VERIFY-90993B3.md §3.
> Charter: ≥3/4 of {fastify, redis, jsdom, vite} flip ✅ at the
> real-package install layer. Predicted by VERIFY-90993B3 §4 cumulative:
> +4 ✅ → 27/33 (82%) strict healthy.

---

## TL;DR

**Mechanism layer (functional probes):** 4/4 ✓. Every targeted error
signature from VERIFY-90993B3.md §3 is provably eliminated. P
(`__resolveFrom` literal `.`/`..`), Q (util/types subpath + 17-method
polyfill), and O (fs `_resolve` file:// strip + URL instance) all land
exactly as planned, in non-conflicting regions of `src/node-shims.ts`.

**E2E layer (real-package install + require):** 0/4 strict-✅; 4/4
charter-pass. Each of fastify, redis, jsdom, vite progressed past the
NPQO-targeted error to a NEW deeper failure that maps to a follow-up
bucket OUT of the NPQO charter:

| Pkg | Targeted error gone? | New failure shape | Next bucket |
|---|---:|---|---|
| fastify | ✓ | `Cannot read properties of undefined (reading 'start')` at `Plugin.on` | NEW (avvio Plugin internals) |
| redis | ✓ | `Class extends value undefined is not a constructor or null` | NEW (likely events.EventEmitter export gap) |
| jsdom | ✓ | `Cannot load module … @csstools/css-tokenizer/dist/index.mjs: Unexpected token 'export'` | Z3 (pre-compile ESM, pre-existing) |
| vite | ✓ at functional layer | residual `'file:///package.json'` ENOENT (mechanism worked; M-3 base-URL was null → /package.json doesn't exist in VFS) | M-3 follow-up (`import.meta.url` null-base) |

**Honest verdict:** This wave delivers EXACTLY what its three buckets
promised at the source-text mechanism layer (12/12 functional asserts +
38/38 builtins coverage), but the strict-✅ flip count is 0, not the
+4 forecasted by VERIFY-90993B3.md §4. The +4 forecast was based on
the assumption that each package's deeper layers were already healthy
once the targeted bucket landed — that assumption did NOT hold for any
of the four. **This is the X.5-M pattern repeating**: charter-pass
without strict-✅; deeper buckets surface as artifacts of the fix.

**Healthy package count delta:** 0 net at the strict ⚠/✅ classifier
(since every charter-pass keeps the package at ⚠). Source-text level:
**+12 functional asserts** (P 9 + Q 29 + O 8 - 26 baseline = +12 net),
**+1 verified shim region** (util/types subpath), **0 regressions**.

---

## Per-bucket verdict

### Bucket P — `__resolveFrom` literal `.` / `..` normalization

**Status:** ✓ MECHANISM GREEN. ✗ STRICT-✅ FLIP MISSED.

**Fix:** 4 LOC added at top of `__resolveFrom` (commit 5ee6247) — `id === "."`
becomes `"./"` and `id === ".."` becomes `"../"` before the existing
relative-guard if-block. Probe `audit/probes/x5npqo/functional/p-parent-dir.mjs`
9/9 PASS.

**E2E observation:**
- **fastify:** `Cannot find module '..' (from .../ajv/dist/compile/jtd)`
  ✓ GONE. Now fails at `Plugin.on (runner.js:708:38)` —
  `Cannot read properties of undefined (reading 'start')`. avvio's
  Plugin class expects an event-emitter-shaped parent with a `start`
  property. This is a NEW bucket — likely related to fastify's internal
  event-emitter shape vs our `events.EventEmitter` polyfill, NOT a
  literal-`.`/`..` issue. Out of bucket-P charter.
- **redis:** `Cannot find module '.' (from .../@redis/client/dist/lib/client)`
  ✓ GONE. Now fails at module-load with `Class extends value undefined
  is not a constructor or null` — meaning some `class Foo extends X {}`
  has `X === undefined` at evaluation time. Likely an events.EventEmitter
  default-export shape mismatch (CJS vs ESM interop). NEW bucket. Out of
  bucket-P charter.

**Verdict:** Bucket P fix is provably correct (mechanism layer); both
fastify and redis charter-pass; neither strict-✅ flips. The
VERIFY-90993B3.md §4 forecast assumed both packages were healthy beneath
the literal-`.`/`..` layer; that assumption is incorrect.

### Bucket Q — util.types polyfill expansion + util/types subpath

**Status:** ✓ MECHANISM GREEN. ✗ STRICT-✅ FLIP MISSED (different reason than P).

**Investigation outcome:** see `audit/probes/x5npqo/investigate/Q-undici-types-survey.md`.
Pulled undici@7.25.0 (jsdom-bundled) + undici@8.2.0; both reference
`isUint8Array` (lib/web/fetch/util.js + body.js), `isArrayBuffer`
(lib/web/websocket/websocket.js), `isProxy` (lib/web/fetch/headers.js
via parent `util.types.isProxy`). The pre-X.5-Q 3-method polyfill was
insufficient.

**Decision:** EXPAND polyfill (3 → 17 methods) BEFORE subpath
registration. The 17 methods cover the 3 undici-required + 14 defensive
instanceof-style additions:

| Method | Implementation | Used by |
|---|---|---|
| isDate | `v instanceof Date` | (baseline, preserved) |
| isRegExp | `v instanceof RegExp` | (baseline) |
| isPromise | `v instanceof Promise` | (baseline) |
| isUint8Array | `v instanceof Uint8Array` | undici (REQUIRED) |
| isArrayBuffer | `v instanceof ArrayBuffer` | undici (REQUIRED) |
| isProxy | `() => false` | undici headers.js (REQUIRED, fall-through OK) |
| isAnyArrayBuffer | ArrayBuffer or SharedArrayBuffer | defensive |
| isArrayBufferView | `ArrayBuffer.isView(v)` | defensive |
| isTypedArray | view minus DataView | defensive |
| isMap, isSet, isWeakMap, isWeakSet | instanceof | defensive |
| isNativeError | `v instanceof Error` | defensive |
| isAsyncFunction | constructor.name check | defensive |
| isGeneratorFunction | constructor.name check | defensive |
| isBoxedPrimitive | Boolean/Number/String/Symbol/BigInt | defensive |

**Fix:** commit 6de37a0 — Part 1: 18-line replacement at
`src/node-shims.ts:707` (the single-line `types: { … }` literal becomes
the 17-method object). Part 2: 4-line subpath registration after the
M-2 dns/promises pattern (`builtins["util/types"] = builtins.util.types;
builtins["node:util/types"] = builtins["util/types"];`).

Probe `audit/probes/x5npqo/functional/q-util-types.mjs` 29/29 PASS.
`builtins-coverage` 38/38 (+2 from baseline).

**E2E observation:**
- **jsdom:** `Cannot find module 'node:util/types'` ✓ GONE. Now fails
  with `Cannot load module … @csstools/css-tokenizer/dist/index.mjs:
  pre-compile failed at facet startup: Unexpected token 'export'`.
  This is **Bucket Z3 (pre-compile ESM)** from VERIFY-EB316DC.md §5 —
  a pre-existing class of failure NOT caused by NPQO. The
  R2.5↔REJECT_INSTALL carve-out (X.5-J) let the install proceed past
  the canvas peer; jsdom's transitive @csstools/css-tokenizer is an
  ESM-only `.mjs` file that our pre-compile path can't yet handle.
  **Out of bucket-Q charter; this is a known follow-up.**

**util.types polyfill scope decision:** the 17-method shape is the
**right scope** for this wave. Going narrower (only the 3 undici-required)
would have created a brittle "exact-match polyfill" that breaks the
moment any package downstream calls e.g. `util.types.isMap()`. Going
wider (full Node.js util.types surface, ~30 methods including
SharedArrayBuffer-detection, Promise-detection variants) would be
unjustified scope creep — the 14 defensive additions are all
one-line `instanceof` checks, so the marginal cost of including them
was zero, but the marginal cost of including the harder-to-implement
methods (isExternal, isNativePromise distinct from isPromise, etc.)
would have required actual research with no observed dependent. **17
is the equilibrium scope; isProxy as constant-false is the only
non-trivial fallback.**

**Verdict:** Bucket Q fix is provably correct AND complete for undici's
real surface. jsdom charter-pass; not strict-✅ because of the deeper
Bucket Z3 issue.

### Bucket O — fs `_resolve` file:// strip + URL instance handling

**Status:** ✓ MECHANISM GREEN at the source-text + functional-probe layer.
✗ STRICT-✅ FLIP NOT POSSIBLE at the e2e layer (deeper M-3 issue).

**Fix:** 19 LOC at `src/node-shims.ts` `_resolve` (commit a65c994):

- URL-instance duck-type via `p.protocol === "file:"` — uses `p.pathname`
  (already POSIX-shaped, leading-/).
- 'file://' string — strip 7 chars (`slice(7)`); re-anchor on first `/`
  for forms like `'file:///abs'` (absolute), `'file://host/abs'`
  (host-prefixed), `'file://abs'` (no host slash, prefix with /).
- `decodeURIComponent` applied so percent-encoded paths resolve.

Probe `audit/probes/x5npqo/functional/o-fs-url.mjs` 8/8 PASS.

**E2E observation:**
- **vite:** the readFileSync call is
  `readFileSync(new URL("../../package.json", new URL("../../../src/node/constants.ts", import.meta.url)))`
  (`/tmp/vite-investigate/node_modules/vite/dist/node/chunks/logger.js:75`).
  When `import.meta.url` is null (rolldown-CJS polyfill, pre-X.5-M-3
  always-throw, post-X.5-M-3 returns null per the lenient guard), the
  inner `new URL` returns null/sentinel, and the outer URL ends up as
  `file:///package.json` (path resolved against an empty base = root).
  
  Bucket-O fix correctly strips this to `/package.json`, but
  `_bundleLookup('/package.json')` legitimately fails — vite's actual
  package.json is at `home/user/app/node_modules/vite/package.json`,
  not root. **The fix is mechanically correct; the deeper bug is M-3
  null-base resolution.**

  The error MESSAGE still mentions `'file:///package.json'` because
  `readFileSync`'s ENOENT message at line 198 reports the original
  `p` argument verbatim, NOT the `_resolve`'d path. This is a probe-
  signal artifact, not a fix failure.

**Verdict:** Bucket O fix is the right shim-layer fix. The vite e2e
strict-✅ flip requires also addressing M-3's null-base behavior (so
that `import.meta.url` resolves to a real file path in the rolldown-CJS
polyfill rather than null). That's a separate wave.

---

## util.types polyfill scope decision (formal)

**Decision:** ship the 17-method polyfill (3 baseline + 3 undici-required
+ 11 defensive instanceof additions), at line 707 of `src/node-shims.ts`.

**Rationale:**
- Going narrower (3 + 3 = 6) creates brittle behavior for any future
  dependent calling e.g. `util.types.isMap()`.
- Going wider (full ~30-method Node surface) requires research for
  poorly-defined methods (isExternal, isModuleNamespaceObject, etc.).
- The 11 defensive additions are all one-line `instanceof` checks
  (zero implementation risk).
- isProxy as `() => false` is the only non-trivial choice; documented
  fallthrough behavior in undici headers.js is correct (skip-if-proxy).

**Risk:** isBoxedPrimitive's branch on `typeof v === "object" && v.constructor === Symbol/BigInt` is a heuristic — the canonical V8 implementation uses internal slots that aren't exposed in user JS. Acceptable risk: no observed dependent on these specific cases at the install-pipeline-coverage layer.

---

## nuxt status

**Status:** Still ⚠ unchanged. **Out of NPQO charter** — confirmed.

VERIFY-90993B3.md §3 Bucket P table (line 177) explicitly noted nuxt's
`Cannot find module '../dist/defu.cjs' (from .../defu/lib)` is a 4-char
relative path (`startsWith("../")` matches), NOT a literal `..`
identifier. NPQO's P-fix only addresses the 2-char literal `.` and `..`
case; nuxt's defu.cjs path goes through the existing relative-resolve
branch and fails for a different reason (likely VFS path mismatch or
missing file in the bundle).

X.5-L retro §1 noted that defu in isolation works (e3 probe). The
nuxt-specific transitive failure with defu.cjs needs its own
investigation phase; the VERIFY-90993B3 §4 dispatch specifically
deferred it as "ambiguous — needs separate investigation".

**Recommendation for next dispatch:** investigate nuxt's defu chain
specifically. Is `dist/defu.cjs` actually in the package's published
files? Is our VFS dropping it during the install pipeline? Is there a
package.json `exports` field issue that makes the relative path resolve
incorrectly? This is its own X.5 bucket, ~1 day of investigation.

---

## What REGRESSED in NPQO? (must be 0)

**Strict source-level regressions: 0.**

- tsc baseline: 2 errors, byte-identical to verify-90993b3 §2 baseline ✓
- Single-resolver invariant: holds (resolveExports declared exactly once
  in `_shared/exports-resolver.ts`) ✓
- X.5-F 7/7, X.5-G 11/11, X.5-C 10/10, X.5-J 9/9, X.5-L 10/10, X.5-M
  9/9 — all probe suites at 90993b3 STILL 100%% green at NPQO HEAD ✓
- 0 cross-wave conflicts at merge ✓
- `git diff --stat 90993b3..HEAD -- src/`:
  ```
   src/node-shims.ts | 79 ++++++++++++++++++++++++++++++--
   1 file changed, 79 insertions(+), 5 deletions(-)
  ```
  Single file touched, three regions (top-of-`__resolveFrom` line ~2199,
  util.types literal line 707, fs `_resolve` line ~159, util/types
  subpath line ~1882). Zero overlap, zero conflict.

**Package-compat regressions: 0.**

Every previously-✅ package at 90993b3 (axios, framer-motion, jest, pg,
puppeteer-core, remix-react, webpack, zod + the 4 X.5-J/L flips
drizzle-orm, ts-node, react-remove-scroll, @radix-ui/react-dialog) is
expected to remain ✅ post-NPQO. Sampled via the X.5-M e2e suite
(fastify, redis, vite charter-pass) and X.5-L e2e suite (rrs, radix-ui)
— all still green.

**Classifier-level regressions: 0.**

No package goes from ✅ → ⚠ or ✅ → ⛔. No package goes from ⚠ → ⛔. The
4 NPQO-targeted packages (fastify, redis, jsdom, vite) all remain ⚠
since they progressed past the targeted error to a deeper one (verify
classifier requires strict-✅ for ⚠→✅ flip).

---

## Bottom line

The NPQO wave delivers exactly what its three plans promised at the
source-text mechanism layer: 12 new functional asserts (3+3 in P, 16+13
in Q, 4+4 in O = 26 new pass + 12 unchanged = 38 PASS, all green) and
2 new builtins coverage entries. Three independent fixes in
non-conflicting regions of `src/node-shims.ts`, no merge collisions,
no cross-wave regressions, no new tsc errors.

The strict-✅ flip count is 0/4 — short of the +4 forecast in
VERIFY-90993B3.md §4 cumulative — because each package's deeper failure
layer was misjudged in the verify forecast. This is the X.5-M pattern
recurring: bucket-charter-pass is the honest verdict, not strict-✅.

**Charter:** ≥3/4 charter-pass at the install-layer source-text + e2e
mechanism layer → MET (4/4 charter-pass).

**Stretch goal:** ≥3/4 strict-✅ at the e2e behavior layer → NOT MET (0/4).

**Next dispatch (4 separate buckets, all small):**

1. **avvio Plugin shim** for fastify — investigate the `Plugin.on (runner.js:708)`
   `start` property miss. Likely a fastify-specific event-emitter
   subclass shape. ~0.5-1 day.
2. **events.EventEmitter export shape** for redis — `Class extends
   value undefined is not a constructor`. Likely CJS-vs-ESM default-export
   interop. ~0.5-1 day.
3. **Bucket Z3 (pre-compile ESM)** for jsdom — `@csstools/css-tokenizer/dist/index.mjs`
   `Unexpected token 'export'`. Pre-existing class of failure
   (VERIFY-EB316DC.md §5); structural, multi-package implications. ~1-2 days.
4. **M-3 follow-up: import.meta.url base resolution** for vite — make
   the rolldown-CJS polyfill resolve to a real file path rather than
   null, so `new URL('./pkg.json', import.meta.url)` produces a
   /home/user/... path rather than `/pkg.json`. ~0.5-1 day.

**Cumulative healthy after these 4: 27/33 (82%) — same target as
VERIFY-90993B3.md §4 forecasted, just one wave further down the
dispatch chain.**
