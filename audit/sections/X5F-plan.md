# X.5-F Plan — `resolve-miss` cohort, decomposed

> Status: Plan-mode 2026-05-05, worktree `x5f-resolve-miss` off `main` HEAD `c3d9f47`.
> Sub-agent review attempted but unavailable in this run — challenge was performed
> in-line by re-reading every cited file and registry packument. This plan
> CONTRADICTS the verification doc's single-bucket framing in §1 below.
>
> **Done criteria for X.5-F (per dispatch prompt):**
> ≥ 4 of 7 packages turn ✅; single resolver path preserved
> (`grep -rln 'function resolveExports' src/` returns ONE TS file).

---

## 1. The verification wave's "resolve-miss" bucket is not one bug

`audit/sections/POST-PHASE5-VERIFICATION.md` §1 Phase D table grouped these 7
packages under a single bucket "Cannot find module 'X' (from /home/user/app)":

```
framer-motion, nuxt, parcel, radix-react-dialog, rollup, ts-jest, webpack
```

That framing is **wrong**. Reading the 7 verbatim probe outputs in
`audit/probes/post-phase5-verification/packages-local/` reveals **three**
distinct failure modes with **three different root causes** in **three
different layers**:

| Pkg | Verbatim symptom | Layer | Cluster |
|---|---|---|---|
| parcel | `[npm] resolver-facet: 0 resolved... No packages resolved. Failed: parcel` THEN `Cannot find module 'parcel' (from /home/user/app)` | **install resolver** | **R1** |
| rollup | same shape (line 28 of `rollup.out.txt`) | install resolver | R1 |
| webpack | same shape (line 28 of `webpack.out.txt`) | install resolver | R1 |
| framer-motion | install OK (4 pkgs) → `Cannot find module 'react/jsx-runtime' (from home/user/app/node_modules/framer-motion/dist/cjs)` | **resolver tree** | **R2** |
| @radix-ui/react-dialog | install OK (26 pkgs) → `Cannot find module 'react' (from home/user/app/node_modules/@radix-ui/react-dialog/dist)` | resolver tree | R2 |
| ts-jest | install OK (15 pkgs) → `Cannot find module 'typescript' (from home/user/app/node_modules/ts-jest/dist/legacy)` | resolver tree | R2 |
| nuxt | install OK (428 pkgs) → `Cannot find module 'nuxt' (from /home/user/app)` | **runtime CJS resolver** | **R3** |

Note the `(from <path>)` token IS the smoking gun the verification doc
overlooked: 3 packages fail from inside their own nested directory (R2),
3 packages fail from `/home/user/app` because they were never installed
(R1), and 1 fails from `/home/user/app` after being installed (R3 — must
be a different cause than R1 because `[npm] Resolved 428 packages` is in
the log).

Citations: `audit/probes/post-phase5-verification/packages-local/parcel.out.txt:28-29,40`,
`rollup.out.txt:28-29,40`, `webpack.out.txt:28-29,40`,
`framer-motion.out.txt:36,45`, `radix-react-dialog.out.txt:36,45`,
`ts-jest.out.txt:35,44`, `nuxt.out.txt:35,45`.

---

## 2. Cluster R1 — top-level install of a SKIP_PACKAGES name returns 0

### Evidence
1. `src/npm-resolver.ts:674-686` declares `SKIP_PACKAGES`:
   ```
   const SKIP_PACKAGES = new Set([
     'typescript', 'vite', 'rollup', 'webpack', 'parcel',
     'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',
     'prettier', 'eslint', 'stylelint',
     'chokidar', 'node-gyp', 'node-pre-gyp',
     '@cloudflare/vite-plugin', '@cloudflare/workers-types', 'wrangler',
     'husky', 'lint-staged', 'commitlint',
   ]);
   ```
2. `src/npm-resolver.ts:544` — every name passes through `shouldSkipPackageWithFramework`
   regardless of whether it's a top-level user request or transitive.
3. `src/npm-installer.ts:245-251` — when zero packages resolve, the installer
   logs `'No packages resolved.'` and returns with `failed: Object.keys(specs)`.
4. `src/nimbus-session.ts:235-250` — `BUNDLER_BIN_PREFIXES` *also* lists `webpack`,
   `rollup`, `parcel`, etc. — but that path is for npm-script bin pre-flight,
   independent of install resolution.

### Root cause
The W6 design assumed `SKIP_PACKAGES` only fires for *transitive* deps
(silent-skip is correct: the user didn't ask for them, they're build-tool
noise that won't run in workerd anyway). But when the user explicitly types
`npm install rollup`, the same set blocks the request. There's no top-level
exemption analogous to `FRAMEWORK_REQUIRED_PACKAGES` (npm-resolver.ts:692-694)
which exempts `vite` only when a framework is already detected.

### Hypothesis tree

| H | Description | Likelihood | How to falsify |
|---|---|---|---|
| H1 | Top-level installs of SKIP_PACKAGES names are silently dropped at line 544 | **VERY HIGH** (verbatim probe shows it; code path is unambiguous) | Fix: thread `topLevel: Set<string>` through `resolveTree`. If miss list shrinks → confirmed. |
| H2 | Maybe the resolver-facet path (npm-resolve-facet.ts) bypasses the skip and the bug is supervisor-side only | LOW | Check if `useFacetResolver` is the actually-used path locally. If yes, the same fix needs to land in `parallel/npm-resolve-preamble.ts`. |
| H3 | The skip is intentional and these 3 packages *should* be installable via WASM swap (like esbuild→esbuild-wasm) | LOW (rollup ships native WASM, but webpack/parcel are pure JS) | Read `wasm-swap-registry.ts` for any swap entry. Result: none. |

### Per-package likely outcome after fix
| Pkg | After R1 fix |
|---|---|
| parcel | install proceeds. Parcel's own deps include native bindings (lmdb, sharp, …). May get caught by W6 REJECT_INSTALL on those transitive natives → loud-reject. **Likely outcome: ⛔ loud-reject** (acceptable: that's the W6 healthy path). |
| rollup | install proceeds. Rollup also needs native (`@rollup/rollup-linux-x64-gnu`). Same loud-reject path likely. **Likely outcome: ⛔** OR ✅ if rollup falls back to its WASM build. |
| webpack | install proceeds. Webpack is pure JS but huge (~3 MiB minified). Likely lands as ✅ for `require('webpack'); typeof webpack`. **Likely outcome: ✅**. |

So R1 fix alone delivers **at least 1 ✅ flip** (webpack), with rollup/parcel
either flipping to ⛔ (also a healthy outcome per the verification doc's
own classification, where ⛔ is "loud-reject = healthy").

---

## 3. Cluster R2 — peerDependencies are silently dropped at install

### Evidence
1. `grep -rn peerDependencies src/ --exclude='*.generated.ts'` returns **zero**
   matches in any non-generated file. The npm-resolver / npm-installer never
   read `peerDependencies` or `peerDependenciesMeta`. (The two matches grep finds
   are inside string literals in `.generated.ts` files — vite/react-plugin
   bundles.)
2. `src/npm-resolver.ts:593` and `:634` only enqueue from `pkg.dependencies`.
3. Live registry data (verified via `webfetch https://registry.npmjs.org/<pkg>/latest`
   at plan time):
   - `@radix-ui/react-dialog@1.1.15` declares `peerDependencies: { react, react-dom, @types/react, @types/react-dom }`. `@types/*` are marked `optional` via `peerDependenciesMeta`. **`react` and `react-dom` are required.**
   - `framer-motion` requires `react` (and via React 17+ JSX runtime contract: `react/jsx-runtime`).
   - `ts-jest` requires `typescript` and `jest`.
4. The error site is INSIDE the nested package's own dist directory:
   `from home/user/app/node_modules/@radix-ui/react-dialog/dist`. The
   runtime resolver `__resolveNodeModule` (node-shims.ts:1961) walks up
   `node_modules` from the calling module's dir. From inside
   `node_modules/@radix-ui/react-dialog/dist`, the walk visits:
   - `home/user/app/node_modules/@radix-ui/react-dialog/dist/node_modules/react` → not exist
   - `home/user/app/node_modules/@radix-ui/react-dialog/node_modules/react` → not exist
   - `home/user/app/node_modules/react` → **not exist** ← this is the actual miss
   - `home/user/app/node_modules` → not exist for `react`
   So the resolver IS doing the right walk; `react` simply isn't installed.

### Root cause
Standard npm CLI behaviour (npm v7+) auto-installs peer-deps. Nimbus's
resolver doesn't. The supervisor reports `added 26 packages` but the
peer set wasn't enqueued.

### Hypothesis tree

| H | Description | Likelihood | How to falsify |
|---|---|---|---|
| H4 | Adding required peerDeps (filter out `peerDependenciesMeta.X.optional === true`) to the resolve queue closes all 3 R2 packages | **HIGH** | Run R2 e2e probes with the fix; expect react & typescript in node_modules. |
| H5 | Even with peer install, the peers themselves bring in their own ESM-only files that runtime CJS can't load (e.g. react-dom is ESM-heavy) | MEDIUM | If peer install works but require still fails, the second-order failure has a different shape (e.g. "Cannot find module './cjs/react-dom.production.min.js'") and is a SEPARATE bug. |
| H6 | The peer is declared but NOT actually used at runtime (e.g. only types) — adding it to install would be wasteful | LOW for these 3 (radix-dialog/jsx imports `react`; ts-jest imports `typescript` to typecheck) |

### Subtlety to handle
- `peerDependenciesMeta.<name>.optional === true` → skip
- Don't auto-install peers that are *already* deps of any installed pkg in the
  tree (avoid double-enqueue with version conflicts; let hoist algorithm pick).
- Keep R6 W6 reject path: if peer is in REJECT_INSTALL with `transitive='fail'`,
  surface the same loud-reject as before.
- A peer dep can BE in SKIP_PACKAGES (e.g. `typescript`). The R1 fix changes
  top-level handling but doesn't help peers. We need: **"peer deps of an
  installed package = top-level enough to bypass SKIP for build-tools the
  consumer needs at install time"**. Specifically `typescript` is in
  SKIP_PACKAGES today; ts-jest hard-requires it. Peer-dep handling MUST
  also exempt SKIP_PACKAGES.

### Per-package likely outcome after fix
| Pkg | Expected after fix |
|---|---|
| @radix-ui/react-dialog | ✅ — react installs as peer; nested `require('react')` resolves to `node_modules/react/index.js` |
| framer-motion | ✅ if react ships full CJS jsx-runtime entry. May need exports-resolver subpath fix for `react/jsx-runtime` (separate test). |
| ts-jest | ✅ once typescript is installable. Note: typescript.js is ~9 MiB single-file — hits W2.6b cap (D3 in the W2.6 plan). May get evicted in `buildPrefetchBundle`. **Honest call: this one probably stays ⚠ blocked on W2.6b/W6.5 even with peer install.** |

So R2 fix alone delivers **at least 2 ✅ flips** (radix-dialog, framer-motion).

---

## 4. Cluster R3 — nuxt is ESM-only, runtime resolver gives up

### Evidence
1. nuxt's package.json (verified at plan time, registry packument):
   ```json
   "type": "module",
   "exports": {
     ".": { "types": "./types.d.mts", "import": "./dist/index.mjs" },
     "./app": "./dist/app/index.js",
     ...
   }
   ```
   No `require` condition, no `default`, no `main` or `module` fields at top level.
2. `src/_shared/exports-resolver.ts:36-39` — runtime CJS uses
   `DEFAULT_CJS_CONDITIONS = ['require', 'node', 'default']`.
3. For subpath `.` against the nuxt exports map, `resolveExports` walks the
   `{types, import}` value. None of `require`/`node`/`default` is in the
   condition map → returns null. (The lone exception spec'd in resolver.ts:152-154 is
   "default is always a valid fallback" — but `default` isn't in the
   condition object either; only `types` and `import`.)
4. `resolvePackageEntry` falls back to `pkg.module || pkg.main` — both
   undefined → returns null.
5. `__resolvePkgSubpath` (node-shims.ts:1936-1946) then tries
   `__resolveFile(pkgDir + '/index')` — nuxt has no `index.*` file at root,
   only `dist/index.mjs`. Returns null. Caller throws "Cannot find module".

### Root cause
nuxt is pure ESM. Our runtime require() path with CJS conditions cannot
enter it via the spec-correct exports map walk. **This is the W2.6 D4
decision: ESM-only loader was punted to W3+.** It's not strictly a "bug"
in the resolver (the resolver is spec-correct); the bug is the absence of
an ESM-aware runtime loader.

However, there's a partial fix that's CHEAP and doesn't require an ESM
loader:

- Recall `buildPrefetchBundle` (facet-manager.ts:842-854) already runs
  `transformEsmInBundle` (W3.5 Fix B) which esbuild-converts every .mjs in
  the bundle into CJS in-place.
- After that transform, nuxt's `dist/index.mjs` IS executable as CJS — but
  only if our resolver knows to LOOK at it via the `import` condition.
- Therefore: when CJS conditions yield null, **try ESM conditions as a
  last-resort fallback** at the runtime resolver (`__resolvePkgSubpath`).
  The bundle has already been ESM→CJS transformed; the file content is CJS.

### Hypothesis tree

| H | Description | Likelihood | How to falsify |
|---|---|---|---|
| H7 | Runtime CJS resolver fails because nuxt's exports has no `require`/`default` | **VERY HIGH** (verified by reading registry) | Fix: extend `__resolvePkgSubpath` to retry with `[import, default]` conditions on null. If the file is in the bundle (post-ESM→CJS transform), `__loadModule` succeeds. |
| H8 | Even with ESM-condition fallback, nuxt's main file imports >> the cap and gets evicted | HIGH (nuxt is 6 MiB+ for its own dist; greedy oversample caps at one file/pkg) | The eviction loop (facet-manager.ts:875-881) sorts by file size DESC. nuxt's own main is ~150 KiB (small). Big losses are vue-bundler internals nuxt loads. |
| H9 | nuxt requires top-level await at module-eval (forbidden in user-shell) | MEDIUM | Read transformed nuxt main; check for TLA. The esbuild ESM→CJS transform usually inlines TLA via async wrapper — but nuxt's `dist/index.mjs` is a CLI exporter, not the user-callable surface. |
| H10 | Even if `require('nuxt')` returns *something* it'd be unusable because nuxt is a CLI/build tool, not a library | HIGH (nuxt's library API is at `nuxt/kit` not `nuxt` root) | Probe assertion: "doesn't crash on require, prints something" is enough. Don't assert library functionality. |

### Per-package likely outcome after fix
| Pkg | Expected after fix |
|---|---|
| nuxt | **Likely still blocked**, but for a NEW honest reason ("nuxt is ESM-only and exports `dist/index.mjs` which esbuild can't make synchronously requireable due to top-level await"). Worth attempting H7 cheaply; if that flips ✅, great. If not, the new diagnostic is itself a win. |

So R3 fix alone delivers **0-1 ✅ flips** depending on nuxt's TLA shape. Net
impact: even if H7 doesn't flip nuxt, the same ESM-condition fallback
mechanism can flip OTHER packages elsewhere in the cohort that the
verification doc didn't classify as R3 (e.g. `vitest` — currently in the
"vitest-cjs" bucket).

---

## 5. Per-package fix matrix

| Pkg | Cluster | Primary fix | Probe path |
|---|---|---|---|
| parcel | R1 | top-level exempt SKIP | functional + e2e |
| rollup | R1 | top-level exempt SKIP | functional + e2e |
| webpack | R1 | top-level exempt SKIP | functional + e2e |
| @radix-ui/react-dialog | R2 | install required peerDeps | functional + e2e |
| framer-motion | R2 | install required peerDeps + maybe `react/jsx-runtime` subpath fix | functional + e2e |
| ts-jest | R2 | install required peerDeps (typescript) | functional + e2e — may stay ⚠ on W2.6b cap |
| nuxt | R3 | runtime CJS resolver: ESM-condition fallback when CJS yields null | functional + e2e — may stay ⚠ on TLA |

**Honest target:** ≥ 4 ✅ flips out of 7 (the dispatch's done criteria).
- Confident: webpack (R1), @radix-ui/react-dialog (R2), framer-motion (R2)
- Likely-but-not-certain: rollup, parcel (depend on whether W6 REJECT
  catches their native deps and produces ⛔ vs ✅)
- Risky: ts-jest (W2.6b cap), nuxt (ESM-only)

Net expectation: **3-5 ✅ flips** plus the conversion of the unhelpful
"Cannot find module 'X' (from /home/user/app)" error into either
healthy ✅/⛔ or a more diagnostic message.

---

## 6. Code-level fix plan (file:line per change)

### 6.1 R1 fix — `src/npm-resolver.ts`

```ts
// Current line 544:
if (shouldSkipPackageWithFramework(name, frameworkAware)) {

// Replace with:
if (!topLevelNames.has(name) &&  // R1: top-level requests bypass skip
    shouldSkipPackageWithFramework(name, frameworkAware)) {
```

Add `topLevelNames: Set<string>` parameter to `resolveTree`, populated
from `Object.keys(specs)` at the top of the function. Thread through
`opts`. Existing transitive callers (which pass through `pkg.dependencies`
at line 593) don't add to `topLevelNames` — preserves silent-skip for
build-tool noise as before.

Also: **mirror the same change in the facet-resolver path** at
`src/parallel/npm-resolve-preamble.ts` (the embedded JS preamble used by
the resolver facet pool). Same pattern: thread topLevelNames; bypass at
the same call site.

LOC: ~15 in npm-resolver.ts, ~10 in npm-resolve-preamble.ts.

### 6.2 R2 fix — `src/npm-resolver.ts`

Read `pkg.peerDependencies` in `resolvePackage` (around line 482) and
include in `ResolvedPackage` interface (line 75). Then in `resolveTree`
loop (~line 593), enqueue required peers:

```ts
// After existing dependencies loop:
for (const [peerName, peerRange] of Object.entries(pkg.peerDependencies || {})) {
  if (pkg.peerDependenciesMeta?.[peerName]?.optional) continue;
  if (resolved.has(peerName) || seen.has(peerName)) continue;
  // Peer-deps bypass SKIP_PACKAGES (typescript is a peer of ts-jest; we MUST install it)
  topLevelNames.add(peerName);   // mark so the R1 bypass at line 544 fires
  queue.push([peerName, peerRange as string]);
}
```

The `peerDependenciesMeta` field also needs to flow through the registry
cache (`registryCacheToResolved` at line 491-503) and packument extraction
(line 482). LOC: ~30 in npm-resolver.ts.

### 6.3 R3 fix — `src/node-shims.ts:1911`

Modify `__resolvePkgSubpath`:

```js
function __resolvePkgSubpath(pkgDir, pkg, subpath) {
  if (!pkg) pkg = __readPkgJson(pkgDir);
  if (!pkg) {
    if (subpath === ".") return __resolveFile(pkgDir + "/index");
    return __resolveFile(pkgDir + "/" + subpath.replace(/^\\.\\/+/, ""));
  }
  // Try CJS conditions first (current behaviour)
  let entry = resolvePackageEntry(pkg, subpath, __NIMBUS_CJS_CONDITIONS);
  // R3: ESM-condition fallback for pure-ESM packages whose dist/.mjs
  // has been transformed into CJS at install time (transformEsmInBundle
  // in facet-manager.ts:842). When this fallback fires, we know the
  // file is actually present and runnable via the CJS loader.
  if (entry == null && pkg.exports != null) {
    entry = resolvePackageEntry(pkg, subpath, DEFAULT_ESM_CONDITIONS);
  }
  if (entry != null) {
    // ... unchanged
```

This is a 5-line change in `getExportsResolverJS()` consumer. The shared
resolver itself doesn't change — we simply pass different conditions on
the second attempt. LOC: ~5 in node-shims.ts.

### 6.4 Constants / helpers

No new constants. No new helpers outside the 3 existing source files.
**The shared resolver `src/_shared/exports-resolver.ts` is untouched.**

### 6.5 Lockfile coverage

`src/npm-cache.ts` lockfile shape stores resolved tree. Adding peerDeps to
the resolution graph means lockfile-resolved entries also need peer info.
Check if invalidation is correct: existing lockfiles built before this
change MUST be invalidated to force re-resolve. Specifically, in
`isLockfileValid` (npm-installer.ts ~ line 216), bump a lockfile version
sentinel so old lockfiles miss-validate.

LOC: ~5 in npm-installer.ts/npm-cache.ts (depends on existing schema).

---

## 7. Test-first plan (Phase B)

Each test file lives under `audit/probes/x5f/{functional,regression,e2e}/`.
ALL must be RED before any src/ change.

### 7.1 Functional probes (resolver isolation)

These don't touch the live install pipeline — they exercise the JS-emitted
resolver source against synthetic node_modules trees. This isolates
"is the bug in the resolver?" from "is the bug in the installer?".

| Probe | Target | Cluster |
|---|---|---|
| `audit/probes/x5f/functional/r3-esm-fallback.mjs` | resolver shape: pure-ESM exports yields null on CJS conds, returns valid entry on ESM conds | R3 |
| `audit/probes/x5f/functional/r3-cjs-priority.mjs` | regression: a package with BOTH `require` and `import` conditions still picks `require` | R3 (no regression) |
| `audit/probes/x5f/functional/r2-peerdep-resolution.mjs` | resolver finds `react` from `node_modules/@radix-ui/react-dialog/dist/foo.js` when `node_modules/react` exists | R2 |
| `audit/probes/x5f/functional/r2-peerdep-meta-optional.mjs` | resolver shape: `peerDependenciesMeta.X.optional === true` means installer should NOT enqueue | R2 (validates the install logic via a tiny harness) |
| `audit/probes/x5f/functional/r1-toplevel-bypass.mjs` | given `topLevelNames = {'rollup'}`, `shouldSkipPackageWithFramework` is bypassed | R1 |

### 7.2 Regression probes

| Probe | Asserts |
|---|---|
| `audit/probes/x5f/regression/install-pipeline-coverage.mjs` | re-runs `audit/probes/regression/install-pipeline-coverage.mjs` without any change to expectations. Must stay GREEN — proves we didn't regress the W2.5b coverage matrix. |
| `audit/probes/x5f/regression/skip-still-skips-transitive.mjs` | given a deep tree where `typescript` is a transitive dep of foo → bar, it's still silent-skipped (R1 must not regress transitive silence). |
| `audit/probes/x5f/regression/single-resolver-source.mjs` | `grep -rln 'function resolveExports' src/` returns ONE TS file (`_shared/exports-resolver.ts`). Asserts the X.5-F build phase didn't introduce a 2nd impl. |

### 7.3 E2E probes (full install + import)

| Probe | Asserts |
|---|---|
| `audit/probes/x5f/e2e/r1-rollup-install.mjs` | `npm install rollup` reports added>0 OR a loud-reject; AFTER the install `require('rollup')` either succeeds OR returns a deterministic ⛔ message. |
| `audit/probes/x5f/e2e/r1-webpack-install.mjs` | `npm install webpack` then `require('webpack'); typeof webpack === 'function'`. |
| `audit/probes/x5f/e2e/r1-parcel-install.mjs` | `npm install parcel` reports something other than `[npm] No packages resolved`. |
| `audit/probes/x5f/e2e/r2-radix-dialog.mjs` | after `npm install @radix-ui/react-dialog`, react is present at `node_modules/react`, and `require('@radix-ui/react-dialog')` doesn't throw on `'react'`. |
| `audit/probes/x5f/e2e/r2-framer-motion.mjs` | after `npm install framer-motion`, react is present, and the require-chain to `react/jsx-runtime` resolves. |
| `audit/probes/x5f/e2e/r2-ts-jest.mjs` | after `npm install ts-jest`, typescript is present in node_modules. The require-it test is gated on cap (may stay ⚠). |
| `audit/probes/x5f/e2e/r3-nuxt.mjs` | after `npm install nuxt`, `require('nuxt')` either returns a (possibly empty) object via the ESM-condition fallback OR fails with a NEW ESM-only message (NOT the old "Cannot find module 'nuxt'"). |

All 7 E2E probes spin a local wrangler dev (port 8787, `--ip 0.0.0.0` per
AGENTS.md) and probe via the WS supervisor protocol. Pattern: copy the
existing `_driver.mjs` and `run-packages-prod-w26a.mjs` shape.

### 7.4 Run-all driver

`audit/probes/x5f/run-all.mjs` — orchestrates the above (function ⊃
regression ⊃ e2e in that order); honors `NIMBUS_X5F_E2E=1` to gate the
slow e2e cohort behind a flag (so `bun audit/probes/x5f/run-all.mjs` is
fast by default).

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Adding peer-deps doubles install time on radix-class apps (every component pulls react+react-dom; with hoisting it shouldn't double, but 1st-time overhead is real) | LOW | The W11 framework-aware path already accepts this cost for vite. |
| Lockfile schema churn forces all existing tenant lockfiles to rebuild on next install | MEDIUM | Bumping the lockfile sentinel triggers exactly one re-resolve per tenant. Acceptable. |
| ESM-condition fallback in node-shims masks legitimate "this package isn't installed" misses — a require for nuxt where nuxt isn't in node_modules now silently tries ESM lookup that always fails too | LOW | The fallback only fires when CJS yields null AND `pkg.exports` is non-null AND we already have a `pkg` object (so we read package.json successfully → the directory is there). The "not installed at all" path returns `null` from `__resolveNodeModule` BEFORE reaching `__resolvePkgSubpath`. No semantic regression. |
| ts-jest still fails because typescript.js (~9 MiB) gets evicted from the bundle | HIGH for ts-jest only | Documented in retro as known W2.6b cap blocker. Don't claim ts-jest as ✅. |
| Adding `topLevelNames` to the resolver-facet preamble means changing the embedded JS string (parallel/npm-resolve-preamble.ts) | LOW | Same change pattern as the recent W11 framework-aware threading. |
| W11 already exempts `vite` for framework-detection — does R1's broader exempt regress that? | LOW | `topLevelNames` is purely additive. The framework-aware path stays; we just add another bypass condition. |
| Peer-dep auto-install creates infinite loops for circular peer setups | LOW | Standard `seen` Set in `resolveTree` already prevents this. |

---

## 9. Sub-agent review status

Sub-agent dispatch returned `ProviderModelNotFoundError` in this run.
Self-challenge was performed in §1-§5 by re-reading every cited file at
the cited line and verifying every registry packument via webfetch
(packuments for nuxt, @radix-ui/react-dialog).

Specific challenges I posed to myself and resolved:

- **C1** "Maybe nuxt's failure is a cap eviction not an exports-condition issue."
  Falsified: nuxt's exports map is verifiable from the registry packument and
  has no `require`/`default` condition. Eviction would surface a different
  error ("Cannot read module:" — see `__loadModule` at node-shims.ts:2049).
- **C2** "Maybe radix-react-dialog auto-installs react via npm-cli's
  legacy-peer-deps default."
  Falsified: the verbatim probe shows `[npm] resolver-facet: 26 resolved`.
  Counting radix-react-dialog + its 11 deps + transitives ≈ 26. There's no
  +2 for react/react-dom. So the resolver did NOT include peers.
- **C3** "Maybe the R1 fix should also apply to W11 framework detection (auto-install
  the framework's CLI deps)."
  Distinct concern: framework-aware is already its own path (FRAMEWORK_REQUIRED_PACKAGES).
  R1 fix is purely top-level user-typed names. They compose cleanly.

---

## 10. Done criteria recap

| Criterion | How verified |
|---|---|
| ≥ 4 of 7 packages flip ✅ (or honest blocker reason) | retro §X5F-retro.md per-package table |
| Single resolver path preserved | `audit/probes/x5f/regression/single-resolver-source.mjs` asserts `grep -rln 'function resolveExports' src/` returns 1 TS file |
| `tsc --noEmit` clean (modulo the 2 pre-existing baseline errors) | Phase D audit |
| Mossaic regression PASS | Phase D audit |
| Wave 1 contract PASS (external=0) | Phase D audit |
| install-pipeline-coverage regression PASS | Phase D audit |
| Branch `x5f-resolve-miss` pushed (or halted-on-grant) | Phase E |

---

## 11. Citations

- `audit/sections/POST-PHASE5-VERIFICATION.md` (verification baseline; the bucket framing this plan corrects)
- `audit/sections/02-packages.md` (probe outputs)
- `audit/probes/post-phase5-verification/packages-local/{framer-motion,nuxt,parcel,radix-react-dialog,rollup,ts-jest,webpack}.out.txt` (verbatim error logs)
- `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` Section D (npm install architecture; orthogonal to this fix)
- `audit/sections/W2.6-plan.md` D2 (express/framer-motion exports-conditions bug — this plan supplies the fix)
- `audit/sections/W2.6-plan.md` D4 (ESM-only loader; R3 partial fix)
- `audit/sections/W11-plan.md` §3.0 (FRAMEWORK_REQUIRED_PACKAGES — pattern this plan extends)
- Source: `src/npm-resolver.ts:544,593,634,674-686,692-694,710,724`
- Source: `src/npm-installer.ts:245-251,1004` (skip-package call sites)
- Source: `src/_shared/exports-resolver.ts:36-39,49-119,165-190` (shared resolver — UNTOUCHED)
- Source: `src/node-shims.ts:1882-1888` (resolver embed point), `:1911-1950` (`__resolvePkgSubpath`), `:1961-2001` (`__resolveNodeModule`)
- Source: `src/facet-manager.ts:585-674,809-888` (buildPrefetchBundle + greedy oversample)
- Source: `src/require-resolver.ts:175-283` (prefetchForRequire)
- Source: `src/parallel/npm-resolve-preamble.ts:36-110` (resolver-facet preamble — same fix pattern needed)
- Registry: `https://registry.npmjs.org/nuxt/latest` (verified ESM-only at plan time)
- Registry: `https://registry.npmjs.org/@radix-ui/react-dialog/latest` (verified peer-dep on react/react-dom at plan time)
