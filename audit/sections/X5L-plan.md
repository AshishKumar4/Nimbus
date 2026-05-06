# X.5-L Plan — Bare-spec subpath walker

> **Branch:** `x5l-bare-subpath` off `main` HEAD `eb316dc`.
> **Authored:** 2026-05-05, autonomous wave-runner session (no user input).
> **Charter source:** `audit/sections/VERIFY-EB316DC.md` §3 + §6 #2 + §7
> ("X.5-L — bare-spec subpath walker").
> **Predecessor wave:** X.5-C (`origin/x5c-prebundler`, merged into `eb316dc`).

---

## 0. Context recap

The verification wave at HEAD `eb316dc` (`audit/sections/VERIFY-EB316DC.md`)
identified an **X.5-C retro overstatement**:

> X.5-C claimed `react-remove-scroll ✅`, `radix-react-dialog ✅` —
> measured **⚠** (synth-fixture passes; real-package install hits sibling
> subpath miss `react-remove-scroll-bar/constants`).

X.5-C's ESM walker (`src/require-resolver.ts:79` `IMPORT_RE`) recurses
through ESM `import` and `export-from` statements for **relative-path**
specifiers. That fix was correct as far as it went — but it fails on
the closely-related case of **bare-spec subpaths** like
`'react-remove-scroll-bar/constants'`. The root-cause analysis is in §1
below.

---

## 1. Root cause — confirmed

Read paths followed during this analysis:

- `audit/probes/verify-eb316dc/packages-local/react-remove-scroll.out.txt`
  (from `origin/verify-eb316dc`) — verbatim runtime error:
  `Error: Cannot find module 'react-remove-scroll-bar/constants' (from home/user/app/node_modules/react-remove-scroll/dist/es2015)`.
- `audit/probes/verify-eb316dc/packages-local/radix-react-dialog.out.txt`
  — same verbatim error (radix → react-remove-scroll → react-remove-scroll-bar/constants).
- `src/require-resolver.ts` (lines 41, 79, 115–143, 145–179, 213–334).
- `src/_shared/exports-resolver.ts` (full file — `resolveExports`,
  `resolveConditionValue`, `resolvePackageEntry`).
- Real-package layout (`/tmp/rrs-test/node_modules/react-remove-scroll-bar/...`
  via `bun add react-remove-scroll-bar` outside the worktree):
    - `node_modules/react-remove-scroll-bar/package.json` — has `main`,
      `module`, `jsnext:main` but **NO `exports` field**.
    - `node_modules/react-remove-scroll-bar/constants/package.json` —
      *nested* package.json with `main: "../dist/es5/constants.js"`,
      `module: "../dist/es2015/constants.js"`. This is the **legacy
      pre-`exports`-field subpath convention** (a directory containing
      its own package.json that points back into the parent's `dist/`).

### Trace — what happens today

When `react-remove-scroll/dist/es2015/UI.js` does
`import { fullWidthClassName, zeroRightClassName } from 'react-remove-scroll-bar/constants';`:

1. The X.5-C ESM walker matches it via `IMPORT_RE` ✓
2. `resolveRequire(vfs, 'react-remove-scroll-bar/constants', fromDir)`:
   - `id` is bare → `resolveNodeModule(...)`
   - Splits correctly: `pkgName='react-remove-scroll-bar'`,
     `subpath='./constants'`.
   - Walks up to find `<dir>/node_modules/react-remove-scroll-bar` ✓
   - Calls `resolvePkgSubpath(vfs, pkgDir, './constants')`.
3. `resolvePkgSubpath`:
   - Reads `<pkgDir>/package.json` ✓
   - Calls `sharedResolvePackageEntry(pkg, './constants', DEFAULT_CJS_CONDITIONS)`.
4. `resolvePackageEntry`:
   - `pkg.exports` is `undefined` → skip the exports lookup.
   - `subpath !== '.'` → fall through to "Non-root subpath without
     exports — caller probes raw subpath" → `return './constants'`.
5. Back in `resolvePkgSubpath`:
   - `entry = './constants'`
   - `resolveFile(vfs, pkgDir + '/constants')` probes the extension
     list `['', '.js', '.mjs', '.cjs', '.json', '/index.js',
     '/index.cjs', '/index.mjs', '/index.json']`.
   - **All probes miss.** `<pkgDir>/constants` exists but is a directory
     (so the empty-string probe fails the `!vfs.isDirectory(p)` guard).
     `<pkgDir>/constants.js`, `<pkgDir>/constants/index.js` etc. don't
     exist on disk. Returns `null`.
6. `resolveNodeModule` returns `null` → walker silently no-ops.
   `node_modules/react-remove-scroll-bar/dist/es2015/constants.js` is
   never added to the bundle.
7. At runtime, the W3.5-Fix-B-rewritten require chain calls
   `require('react-remove-scroll-bar/constants')` from inside
   `react-remove-scroll/dist/es2015/UI.js`. The runtime resolver hits
   the same `__resolvePkgSubpath` semantics (mirrored impl in
   `src/node-shims.ts`) and bails with the verbatim error.

### Why the existing logic misses this

The legacy "directory subpath" pattern works as follows: when Node's
require sees `pkg/constants`, it:

1. Tries the `exports` map for `./constants` (→ none here).
2. Falls back to extension-probe of `<pkgDir>/constants.{js,json,…}`.
3. **If `<pkgDir>/constants` is a directory**, reads
   `<pkgDir>/constants/package.json` and follows its `main`/`module`
   field as a path relative to the **subpath directory** (so
   `main: "../dist/es5/constants.js"` resolves to
   `<pkgDir>/dist/es5/constants.js`).
4. If no nested package.json, falls back to `<pkgDir>/constants/index.{js,json,…}`.

**Step 3 is the missing piece.** The current `resolveFile` only does
extension probes; it does not recognise a directory and read its
nested package.json.

This same trace applies to `@radix-ui/react-dialog`: it transitively
depends on `react-remove-scroll`, which transitively depends on
`react-remove-scroll-bar/constants`. Once the constants subpath
resolves, both flip ✅ at the runtime layer.

### Verbatim package.json snippets (post-install reality)

```json
// react-remove-scroll-bar/package.json
{
  "name": "react-remove-scroll-bar",
  "main": "dist/es5/index.js",
  "module": "dist/es2015/index.js",
  "files": ["dist", "constants"]
  // no `exports` field
}
```

```json
// react-remove-scroll-bar/constants/package.json   (nested)
{
  "description": "separate entrypoint for constants only",
  "private": true,
  "main": "../dist/es5/constants.js",
  "jsnext:main": "../dist/es2015/constants.js",
  "module": "../dist/es2015/constants.js",
  "sideEffects": false
}
```

The `..` in `main` is intentional — these nested package.jsons are
back-pointers into the parent `dist/` directory.

### Implication for X.5-C's "bare-spec subpath" framing

The verify doc framed this as "extend the walker to handle bare-spec
subpath imports … resolve via `pkg/package.json#exports['./constants']`
or fallback `pkg/constants/index.js` / `pkg/constants.js`". That
framing is **partially correct**: the bare-spec **plumbing** is already
in place (steps 1–4 above resolve `pkg/sub` correctly when the parent
package declares the subpath via `exports`). What's missing is the
**directory-with-nested-package.json fallback** — the
*pre-`exports`-field* legacy convention that `react-remove-scroll-bar`
uses.

So the fix ends up being slightly different from the doc's wording:
add a "if the subpath probe hits a directory, look for a nested
package.json" branch in `resolvePkgSubpath` (and `resolveFile` for
relative-path subpath landings). Both the install-time prefetch
(`require-resolver.ts`) and the runtime
(`node-shims.ts:__resolvePkgSubpath`) need this.

### Sub-agent-style review

Pre-implementation cross-check (mental sub-agent walkthrough):

- **Q: Could the fix be just "use `DEFAULT_ESM_CONDITIONS`"?**
  A: No. The package has no `exports` field at all, so condition
  selection is moot. Confirmed by inspecting
  `node_modules/react-remove-scroll-bar/package.json` — no `exports`.

- **Q: Why doesn't greedy oversample
  (`facet-manager.ts:greedyAddMainEntries`) catch this?**
  A: Greedy oversample adds the package's **main entry** + package.json
  for every visited package. It doesn't add nested-subpath entry files.
  Even if `react-remove-scroll-bar` is in `visitedPkgDirs` (because
  the walker reaches its `dist/es2015/index.js` via the bare import
  `'react-remove-scroll-bar'` from `SideEffect.js`), the
  `dist/es2015/constants.js` file is *not* the main entry.

- **Q: Could the runtime-side resolver (node-shims) compensate?**
  A: Yes — but the file isn't in the bundle, so the runtime resolver
  can find the *path* but not load the *content*. Both walker AND
  bundle must include the file. Hence the fix is in
  `require-resolver.ts` first (to ensure the file lands in the
  bundle), with a parity update in `node-shims.ts:__resolvePkgSubpath`
  if needed (so the runtime resolves the same path the walker does).

- **Q: Is `DEFAULT_CJS_CONDITIONS` correct in the prefetch path?**
  A: Yes — runtime `require()` is CJS-shaped. The walker's job is to
  predict what runtime `require()` will reach. The X.5-C IMPORT_RE
  loop also passes the same conditions implicitly via
  `resolveRequire` (it doesn't override). Even though the call site
  is an ESM `import` statement, the resolver is being asked
  "what file would `require('pkg/sub')` reach", since the bundle is
  consumed by the runtime CJS facet. (W3.5 Fix B's ESM→CJS transform
  rewrites all `import` statements to `require()`; so prefetch
  conditions should match runtime conditions = CJS.)

- **Q: Won't this also need a change in `_shared/exports-resolver.ts`?**
  A: No. `resolvePackageEntry` already returns the raw subpath when
  there's no `exports` field — that's correct per Node spec. The fix
  is in `resolvePkgSubpath` / `resolveFile` (the *probe-after-resolve*
  layer), not the resolver itself.

- **Q: Will this break other packages?**
  A: The change is additive: if extension probes succeed (current
  behaviour), the new branch is never consulted. Only when all
  extension probes miss AND the path is a directory do we attempt
  the nested package.json. This mirrors Node's own behaviour exactly.

- **Q: Does `nuxt → defu.cjs` share this root cause?**
  A: **No** — different class. The verify probe error is
  `Cannot find module '../dist/defu.cjs' (from home/user/app/node_modules/defu/lib)`.
  That's a **relative** import from a CJS file, and the walker's
  `REQUIRE_RE` already handles relative imports. The likely cause is
  that `defu/lib/defu.cjs` (the `require` condition's target) is
  reached via the package's `exports` map, but the recursion through
  its `require("../dist/defu.cjs")` fails because the bundle only
  contains the entry file (`lib/defu.cjs`), not the file *it
  requires*. This points at a bundle-population-order or
  `parseAndResolve` recursion-not-firing bug rather than a resolver
  bug. Will investigate as a **bonus** in Phase B/C — if it's the same
  root cause, a single fix unblocks 3 packages; if not, defer to the
  retro as a separate finding.

---

## 2. Target packages

| Pkg | Verbatim runtime error | Source hop |
|---|---|---|
| **react-remove-scroll** | `Cannot find module 'react-remove-scroll-bar/constants' (from .../react-remove-scroll/dist/es2015)` | `react-remove-scroll/dist/es2015/UI.js` — `import { fullWidthClassName } from 'react-remove-scroll-bar/constants'` |
| **@radix-ui/react-dialog** | same (transitive via react-remove-scroll) | radix-dialog → react-remove-scroll → react-remove-scroll-bar/constants |

Bonus investigation:

| Pkg | Verbatim runtime error | Hypothesis |
|---|---|---|
| **nuxt** | `Cannot find module '../dist/defu.cjs' (from .../defu/lib)` | likely a bundle-population gap, NOT bare-spec — see §1 sub-agent Q. Will deep-dive in Phase B; if it's the same class, ride along; otherwise document and defer. |

---

## 3. Fix sketch

### 3.1 `src/require-resolver.ts:resolvePkgSubpath` — line 115

Add a branch after the existing extension-probe + `pkg.main` fallback
that tries: if `<pkgDir>/<subpath>` is a **directory**, read its
nested `package.json`, follow `module`/`main`, and resolve relative to
that nested directory.

Pseudocode:

```ts
function resolvePkgSubpath(vfs, pkgDir, subpath) {
  // ... existing pkg.exports + pkg.main + final extension probe ...

  // NEW: legacy directory-with-nested-package.json fallback.
  // If the final extension probe missed AND `<pkgDir>/<subpath>` is a
  // directory, read its nested package.json.
  const subDir = normalizePath(pkgDir + '/' + subpath.replace(/^\.\//, ''));
  if (vfs.exists(subDir) && vfs.isDirectory(subDir)) {
    const nestedPkgJson = subDir + '/package.json';
    if (vfs.exists(nestedPkgJson)) {
      try {
        const nested = JSON.parse(vfs.readFileString(nestedPkgJson));
        // Resolve nested.module → nested.main per same condition order
        // as parent. nested entries can be relative (`./x.js`) or up-pointing
        // (`../dist/x.js`); resolveFile + normalizePath handle both.
        const nestedEntry = nested.module || nested.main;
        if (typeof nestedEntry === 'string') {
          const r = resolveFile(vfs, normalizePath(subDir + '/' + nestedEntry.replace(/^\.\//, '')));
          if (r) return r;
        }
      } catch { /* fall through */ }
    }
    // Last-resort: probe `<subDir>/index.{js,…}` (already covered by
    // the original probe via /index.js suffix, but it relies on
    // `<pkgDir>/<subpath>` being the bare path — covered upstream).
  }

  return null; // unchanged
}
```

### 3.2 `src/node-shims.ts:__resolvePkgSubpath` (parity)

The user-shell `node` runtime mirror of `resolvePkgSubpath` lives in
`node-shims.ts`. We need the **same** legacy fallback there so the
runtime require can find the file the walker shipped.

Per the anti-requirements, **node-shims.ts is X.5-M territory**. So
this wave touches **only** `require-resolver.ts`. We'll verify that
runtime-side `__requireFrom` already does the directory→nested-pkg
fallback, OR document the gap as an X.5-M follow-on.

**Re-read** of node-shims (after Phase A authoring): the runtime
mirror needs to be checked. If the parity is already there (legacy,
pre-X.5-C), the prefetch fix alone lands the file in the bundle and
the runtime will load it. Will validate empirically in Phase B's
e2e probe (the synth-fixture eval harness exercises the runtime
resolver too).

If the runtime mirror needs the same change, the fix is **2 lines**
to enable `__resolvePkgSubpath` to call into a directory probe — but
that's still touching `node-shims.ts`. **Decision rule:** if Phase B's
e2e fails purely on the runtime side (file IS in bundle but runtime
can't find it), I'll **stop** and write `audit/sessions/X5L-stuck.md`
flagging the X.5-M cross-cut. If Phase B's e2e passes (runtime
already does the right thing once the file is in the bundle), proceed.

Actually wait — re-reading anti-req: "DO NOT touch src/node-shims.ts
(X.5-M territory)". This is explicit. So if runtime parity is needed,
I document it and stop. The likely outcome is *runtime parity is
already correct* (the legacy pattern predates X.5-C and was working
for years), so the prefetch fix alone is sufficient.

### 3.3 File-line plan

| File | Change | Approx LOC |
|---|---|---|
| `src/require-resolver.ts:~115-143` | extend `resolvePkgSubpath` with directory→nested-package.json branch | +25 LOC |
| `src/require-resolver.ts:~100-107` | extend `resolveFile` similarly (for the relative-path entry-point case where a relative import lands on a directory) | +10 LOC if needed |
| Probe: `audit/probes/x5l/functional/f1-bare-subpath-walker.mjs` | NEW | ~120 LOC |
| Probe: `audit/probes/x5l/regression/r1-install-pipeline-coverage.mjs` | NEW (mirrors X.5-C r3) | ~80 LOC |
| Probe: `audit/probes/x5l/regression/r2-x5c-fixes-still-green.mjs` | NEW (re-runs X.5-C functional probes via re-export) | ~30 LOC |
| Probe: `audit/probes/x5l/e2e/e1-react-remove-scroll-real.mjs` | NEW — uses real package files copied into synth VFS | ~150 LOC |
| Probe: `audit/probes/x5l/e2e/e2-radix-react-dialog-real.mjs` | NEW — same pattern, transitive chain | ~150 LOC |
| Probe: `audit/probes/x5l/e2e/e3-nuxt-defu-investigation.mjs` | NEW — bonus, validates nuxt's failure class | ~100 LOC |
| Probe: `audit/probes/x5l/_helpers.mjs` | NEW — re-exports X.5-C helpers + adds real-package-fixture loader | ~50 LOC |
| Probe: `audit/probes/x5l/run-all.mjs` | NEW — same shape as X.5-C run-all | ~50 LOC |

**Total src/ change: ~30 LOC** in a single file (`require-resolver.ts`).

---

## 4. TDD plan (Phase B)

Probes that must turn red on `main` HEAD `eb316dc`, then green after
the Phase C fix:

### Functional

- **f1-bare-subpath-walker** — synth-fixture: `pkg-A/index.js` does
  `import x from 'pkg-B/sub'`; `pkg-B` has no `exports` field but has
  `pkg-B/sub/package.json` with `main: '../dist/sub.js'`. Asserts the
  walker pulls `pkg-B/dist/sub.js` into the bundle.
- **f2-bare-subpath-with-exports** — same fixture, but `pkg-B` has
  `exports./sub: './dist/sub.js'`. Asserts current behaviour still
  works (regression guard for the current X.5-C path).
- **f3-bare-subpath-fallback-index** — `pkg-B/sub/` is a directory
  with NO nested package.json, but has `index.js`. Asserts walker
  falls through to `<sub>/index.js` (existing behaviour, regression
  guard).
- **f4-bare-subpath-up-pointing** — nested `package.json` has
  `main: '../dist/x.js'` (the actual `react-remove-scroll-bar/constants`
  shape). Asserts the up-pointing path normalizes correctly.

### Regression

- **r1-install-pipeline-coverage** — re-run a curated set of W2.6a
  3-package smoke tests via the prefetcher to confirm we haven't
  regressed.
- **r2-x5c-fixes-still-green** — re-import and re-run all X.5-C
  functional probes via Bun (delegate to existing `audit/probes/x5c/run-all.mjs`).
- **r3-single-resolver-source** — assert single-resolver invariant
  still holds (`resolveExports` declared once in `_shared/exports-resolver.ts`).

### E2E

- **e1-react-remove-scroll-real** — copy actual files from a
  scratch-installed `react-remove-scroll@^2.7` + `react-remove-scroll-bar@^2.3`
  + tslib + stubs into a synth VFS; prefetch + transform + run via
  facet harness. Asserts `require('react-remove-scroll').default` is
  callable AND `default.classNames.fullWidth === 'zr'` (or whatever
  the constants module exports).
- **e2-radix-react-dialog-real** — same pattern, with the radix-dialog
  package + its full transitive cone (≥10 packages). Asserts
  `require('@radix-ui/react-dialog').Root` is a function/component.
- **e3-nuxt-defu-investigation** — same pattern but with just `defu`
  + a script that does `require('defu')`. Phase B will determine
  whether this is the same root cause; if it FAILS pre-fix and
  PASSES post-fix, we ride along; otherwise we document the
  separate finding in the retro.

---

## 5. Acceptance criteria (Phase D)

- All x5l functional + regression + e2e probes green locally.
- All X.5-C probes (`audit/probes/x5c/run-all.mjs`) still green.
- Mossaic regression (`audit/probes/mossaic-prod-w2.txt` shape, if
  re-runnable in this env) green or unchanged.
- `bunx tsc --noEmit` reports the same 2 pre-existing errors and
  zero new ones.
- Sub-agent diff review on every commit's diff (mental review +
  `git diff --stat` cross-check).

---

## 6. Out of scope

- `src/node-shims.ts` — X.5-M territory. If runtime parity is needed,
  stop and write `X5L-stuck.md`.
- `src/npm-resolve-facet.ts`, `src/npm-resolver.ts` — X.5-J territory.
- `tailwindcss-vite` ESM pre-compile — X.5-N territory.
- `rollup` runtime require — X.5-K territory.
- `drizzle-orm`, `ts-node` regressions — X.5-J territory.

---

## 7. Risks

- **Real-package fixture probes need network or pre-installed
  packages.** Mitigation: use `bun add` to install into a scratch
  dir at /tmp once, then read files in to assemble the synth VFS
  (no network at probe-run time).
- **The `react-remove-scroll-bar/constants/package.json#main` field
  uses up-pointing `../dist/...`.** Mitigation: `normalizePath`
  already handles `..`. Functional probe f4 specifically validates
  this.
- **Runtime-side parity for the legacy directory→nested-pkg
  fallback.** Mitigation: e2e probes execute the runtime require
  chain via `makeFacet` — they catch runtime parity gaps.
- **nuxt bonus turns out to be a different root cause.** Mitigation:
  document in retro, defer to a future bucket. Doesn't block X.5-L
  primary scope.

---

## 8. Done

Ship X.5-L when:
- src/require-resolver.ts changes <50 LOC, single function extended.
- 4 functional + 3 regression + 3 e2e probes green.
- X.5-C probes still green.
- tsc clean (2 pre-existing errors, byte-identical).
- Branch pushed; retro authored.

Goal: `react-remove-scroll` and `@radix-ui/react-dialog` flip ⚠ → ✅
at the real-package install layer (closing the X.5-C overstatement).

Cumulative target after this wave: **24/33 = 73% healthy** (per verify §6
recommended dispatch math, lifting 22→24).
