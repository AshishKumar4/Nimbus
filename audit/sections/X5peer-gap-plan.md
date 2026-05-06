# X.5-peer-gap Plan — Install-time peer/sibling-package gap

> **Source:** `VERIFY-23417C5.md` §4 #3 ("Install-time peer/sibling-package gap (1-2 pkgs, P2)").
> **Branch:** `x5peer-gap` off `origin/main` HEAD `23417c5`.
> **Mode:** PLAN-ONLY audit. No `src/` writes. Implementation deferred to a subsequent dispatchable wave.
> **Predicted ✅ delta:** +1-2 (nuxt + tailwindcss-vite).

---

## §0. TL;DR

The two failures share an error shape (`__requireFrom (runner.js:2910:24)`)
but have **fully independent root causes**. Neither folds into
X.5-26b (W2.6b cap eviction). Both are surgical, dispatch-ready, and
sized at ≤25 LOC each.

| Pkg | Root cause | Layer | Est. LOC | Predicted flip |
|---|---|---|---:|---|
| `nuxt` | `greedyAddMainEntries` adds main entry without recursing into its requires; defu's CJS shim (`lib/defu.cjs`) lands but its `require("../dist/defu.cjs")` target never enters `__vfsBundle`. | prefetch bundler | ~15-25 | ✅ |
| `tailwindcss-vite` | `tailwindcss` is silent-skipped at install time by SKIP_PACKAGES (a v3-era build-tool blocklist). v4 made `tailwindcss` a runtime dependency of `@tailwindcss/node`, so the skip is a false-positive. | install resolver | ~3-5 | ✅ |

Recommended dispatch: **two independent X.5 sub-buckets** (`X.5-peer-A` for
nuxt, `X.5-peer-B` for tailwindcss-vite). Order: B first (smaller,
higher-confidence, instantly verifiable), then A.

---

## §1. nuxt — `defu/dist/defu.cjs` not in prefetch bundle

### §1.1 Failure shape

```
Error: Cannot find module '../dist/defu.cjs' (from home/user/app/node_modules/defu/lib)
    at __requireFrom (runner.js:2910:24)
    at scopedRequire (runner.js:2796:33)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:3:51)
    ...
```

(`audit/probes/verify-23417c5/packages-local/nuxt.out.txt:164-174`,
extracted from `verify-23417c5` branch into `/tmp/nuxt-23417c5.out.txt`
during this investigation.)

### §1.2 Root cause (CONFIRMED via probes p1 + p3)

**Static evidence chain:**

1. defu@6.1.7 ships a CJS shim at `lib/defu.cjs` (278 B) that re-exports
   from `dist/defu.cjs` (2203 B). Both files ARE in the registry tarball
   (probe p1: `audit/probes/x5peer-gap-investigation/p1-defu-shim-shape.out.txt`).
2. defu's `package.json#main = ./lib/defu.cjs`, with `exports."."."require".default = ./lib/defu.cjs`
   and `exports."."."import".default = ./dist/defu.mjs`.
3. The Nimbus install pipeline extracts the entire tarball (no
   `package.json#files` filter — `src/npm-tarball.ts:65 extractTarballFromResponse`
   iterates every entry without filter), so both files land on VFS-disk
   under `node_modules/defu/`.
4. `buildPrefetchBundle` (`src/facet-manager.ts:1016-1110`) ships only
   files in two passes:
   - **Pass 1** — `prefetchForRequire` (`src/require-resolver.ts:418`),
     a recursive walker rooted at the entry script. It DOES recurse on
     every added file (`addFile` at `src/require-resolver.ts:441-488`
     calls `parseAndResolve` at line 484-487).
   - **Pass 2** — `greedyAddMainEntries` (`src/facet-manager.ts:598-747`),
     a per-package oversample. **Probe p3 confirmed: 0 calls to
     `parseAndResolve` / `prefetchForRequire` inside its body.** It adds
     1 main entry + hash-chunk siblings + shared/ subdir, then stops.
5. nuxt's main entry is `dist/index.mjs` (ESM). The require-walker's
   `IMPORT_RE` pass picks up `import { defu } from 'defu'` and resolves
   via defu's `exports.import.default = dist/defu.mjs`. So Pass 1 lands
   `defu/dist/defu.mjs` (NOT `lib/defu.cjs`).
6. Pass 2 (greedy) reads defu's `package.json#main = ./lib/defu.cjs`
   and adds it via `addOne` (`src/facet-manager.ts:611-626`). The
   hash-chunk pattern (`<base>.<hash>.<ext>`) requires a hash segment
   — `defu.cjs` has no hash. The `shared/` subdir scan walks
   `<entryDir>/shared/` — entryDir is `lib/`, target is in `dist/`.
   Neither catches `dist/defu.cjs`.
7. At runtime, the chain is CJS: a downstream pkg (or the test harness's
   `require('nuxt')` driving CJS resolution) reaches `defu` via
   `__resolvePkgSubpath` (`src/node-shims.ts:2124+`), which honours
   `exports.require.default = lib/defu.cjs`. The shim runs, calls
   `require("../dist/defu.cjs")` → `__resolveFile` → `__fileExists`
   (`src/node-shims.ts:2045-2056`). `__fileExists` consults ONLY
   `__vfsBundle / __vfsWrites / __vfsDirs` — never the underlying
   `__fsMod` / SQLite VFS. So even though the file is on VFS-disk,
   the bundle-only resolver returns false → `Cannot find module`.

**Why this isn't W2.6b cap eviction:** `dist/defu.cjs` is 2203 B. The
eviction loop (`src/facet-manager.ts:1095-1104`) sorts largest-first
and would never pop a 2 KB file. Confirmed by inspection — H2 ruled
out in Phase B.

**Why this isn't X.5-L (legacy directory subpath):** X.5-L's pattern
is `<pkgDir>/<sub>/package.json` with a relative `main` field. defu's
`lib/` has no nested `package.json`. The chain is just a flat shim
that does an explicit `require("../dist/defu.cjs")`. Different class.

### §1.3 Fix shape

**Option A (preferred): one-level recursive walk inside `greedyAddMainEntries`.**

After `addOne(candidate)` lands successfully, parse the file's content
for `require()` / `import` of relative paths (`./` or `../`) and add
those targets via `addOne` too. **Single level only** (no full
recursion) — keeps the fix bounded, cheap, and consistent with the
"oversample" intent of the greedy pass.

Pseudocode:

```ts
function addOneAndFollowRelativeRequires(filePath: string): boolean {
  const ok = addOne(filePath);
  if (!ok) return false;
  // already-read content: re-read or pass through (cheap; ~10 KiB max for shims)
  const content = bundle[filePath.replace(/^\/+/, '')];
  if (!content) return ok;
  const fromDir = filePath.replace(/\/[^/]+$/, '');
  const RE = /(?:require\s*\(\s*|from\s+)['"`](\.\.?\/[^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(content)) !== null) {
    const rel = m[1];
    const target = resolveRelative(fromDir, rel); // mirror node-shims __resolveFile
    if (target) addOne(target);
  }
  return ok;
}
```

**Land site:** `src/facet-manager.ts` — replace the `addOne(candidate)`
call sites at line 674 + the existing hash-chunk + shared/ block. Reuse
the existing `__resolveFile`-shaped logic from `src/require-resolver.ts`
(its `__resolveFile` equivalent is already exported as `resolvePkgSubpathEx`/`resolveRequireEx`,
but for one-level relative the simpler regex+extension-probe is enough).

**LOC estimate:** ~15-25 (one helper + extension-probe loop + 1 call-site
swap). Tight bound: hash-chunk regex already exists adjacent
(`src/facet-manager.ts:703-708`), so the parsing infrastructure is
familiar.

**Option B (fallback): special-case `dist/<base>.cjs` for shim mains.**

Detect when the main entry is a thin file (size < N bytes) that
contains a single `require("../dist/<X>.<ext>")`, and add the dist
target. Fragile — Option A is strictly more general.

**Option C (heaviest): replace `greedyAddMainEntries` with
`prefetchForRequire`-from-each-package.** Adds full recursion per
package main entry. Predictably blows the 24 MiB raw cap on big trees
(nuxt 526 pkgs / 31.5 MiB raw JS) — would force a coordinated W2.6b
cap-bump first. Punted unless Option A is empirically insufficient.

### §1.4 Predicted impact

- ✅ flip on `nuxt` (single high-value framework — 1 of 5 main W11
  frameworks).
- Side-effect bonus candidates: any pkg whose CJS main is a thin
  shim that requires a sibling `dist/` chunk. Unbuild-emitted libs
  with `lib/index.cjs` → `../dist/index.cjs` shape would benefit.
  Empirical scan recommended at retro time.

### §1.5 Risks

| Risk | Mitigation |
|---|---|
| Adds ~5-10% bundle-bytes for shim-shaped packages | Bounded by existing budgetState.totalBytes + VFS_BUNDLE_MAX_BYTES gate (line 614-619) — same cap path, so worst-case cap fires earlier and a few large shims drop one-level relative requires. Acceptable. |
| Regex over-matches inside string literals / comments | One-level relative targets that don't exist on VFS just no-op — same fail-soft pattern as existing addOne. |
| Recursion depth > 1 leaks in | Explicit single-level — no nested call back into the helper. |

---

## §2. tailwindcss-vite — `tailwindcss` silent-skipped at install

### §2.1 Failure shape

```
Error: Cannot find module 'tailwindcss' (from home/user/app/node_modules/@tailwindcss/node/dist)
    at __requireFrom (runner.js:2910:24)
```

(`audit/probes/verify-23417c5/packages-local/tailwindcss-vite.out.txt:135`,
extracted into `/tmp/twv-23417c5.out.txt`.)

### §2.2 Root cause (CONFIRMED via probe p2)

`tailwindcss` is hardcoded into `SKIP_PACKAGES` at:

- `src/npm-resolver.ts:884-896` (canonical):

  ```ts
  const SKIP_PACKAGES = new Set([
    'typescript', 'vite', 'webpack', 'parcel',
    'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',  // ← line 887
    ...
  ]);
  ```

- `src/parallel/npm-resolve-preamble.ts:39-47` (mirror for facet-resolver
  worker):

  ```ts
  const __SKIP_PACKAGES = new Set([
    'typescript', 'vite', 'webpack', 'parcel',
    'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',  // ← line 42
    ...
  ]);
  ```

`FRAMEWORK_REQUIRED_PACKAGES` (`src/npm-resolver.ts:902-904`,
`src/parallel/npm-resolve-preamble.ts:48-50`) exempts only `'vite'`.
There's no exemption for `tailwindcss`.

The skip was correct for Tailwind v3 — `tailwindcss` was a build-time
CSS CLI, never required at runtime in a Workers environment.

**Tailwind v4 split changed the contract.** `@tailwindcss/node@4.2.4`
declares `tailwindcss: "4.2.4"` as a regular `dependencies` entry
(probe p2 confirmed `peerDependencies: undefined`,
`optionalDependencies: undefined`). Its `dist/index.js` does
`require("tailwindcss")` at line 1 — runtime require, not build-time.
The skip therefore breaks any `@tailwindcss/*` consumer that runs
through the Nimbus facet runtime.

The resolver's call-site to `SHOULD_SKIP_PACKAGE` at
`src/npm-resolve-facet.ts:483` and `:663` runs the skip even for
transitive deps (only top-level names typed by the user are exempted —
the user typed `@tailwindcss/vite`, not `tailwindcss`).

### §2.3 Fix shape

**Option A (preferred): remove `tailwindcss` from SKIP_PACKAGES.**

Two-line edit (one in `src/npm-resolver.ts`, one in
`src/parallel/npm-resolve-preamble.ts`):

```diff
- 'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',
+ 'postcss', 'autoprefixer', 'cssnano',
```

This removes the false-positive at install time. `tailwindcss` will
then be resolved + installed transitively when any consumer
(`@tailwindcss/vite`, `@tailwindcss/node`, `@tailwindcss/oxide` users
etc.) declares it as a dep.

**Option B (narrower, gated): add `'tailwindcss'` to
`FRAMEWORK_REQUIRED_PACKAGES` so it's only un-skipped when framework
detection fires.**

Same pattern as W11's `vite` exemption. Slightly narrower blast
radius (still skipped in vanilla `npm install tailwindcss` from a
non-framework project), but for v4's runtime-engine model the blanket
removal in Option A is cleaner — there's no scenario where you WANT
v4's `tailwindcss` package skipped.

**Option C (gated by major version): registry-aware skip.**

Skip `tailwindcss < 4.0.0`, install `>= 4.0.0`. Requires reading the
packument before deciding skip — adds a network round-trip and
complicates the `SHOULD_SKIP_PACKAGE` contract (currently
synchronous + name-only). Not recommended.

**Decision:** Option A. v3's "skip tailwindcss because it's a CLI"
intent is obsolete — Workers can't run the v3 CLI binary either way,
so its installation is harmless dead weight; v4's runtime engine is a
real dep.

**Land site:** Two single-line removals. ~3-5 LOC total (including a
comment line documenting the v4 split).

### §2.4 Predicted impact

- ✅ flip on `tailwindcss-vite`.
- Side-effect: `tailwindcss` package itself becomes installable as a
  top-level user request (currently silent-skipped). In the
  VERIFY-23417C5 33-pkg matrix, no probe directly tests
  `npm install tailwindcss` standalone — but downstream consumers
  benefit.
- `tailwindcss-oxide` (separately ⚠ in VERIFY-23417C5) — different
  root cause (`Cannot find native binding. npm has a bug related to
  optional dependencies (#4828)`). NOT unblocked by this fix; tracked
  under W2.6b.

### §2.5 Risks

| Risk | Mitigation |
|---|---|
| `tailwindcss` v3 still installs unnecessarily for some users | The package is small (~5 MiB tarball); always-install is harmless overhead. The v3 CLI binary is unusable in Workers, but the package install itself is benign. |
| Increased install size for projects that don't need v4 | Negligible vs the existing 526-pkg nuxt install footprint. |
| Resolver picks an unexpected version range | `tailwindcss` is a regular `dependencies` entry — semver resolution proceeds normally. No new behaviour. |
| `tailwindcss-vite` still fails on a deeper layer (e.g. lightningcss native binding) | VERIFY-23417C5 §3 noted this as the *previous* shape; the Z5 walker dual-relaxation closed it. Current top error is the missing-tailwindcss; closing that exposes the next layer. **Monitoring:** if tailwindcss-vite still ⚠ post-fix, file:line of the new error becomes the next-bucket trigger. |

---

## §3. Cross-cutting

### §3.1 Shared-or-distinct?

The verify-doc framing was *cautious* — "shared symptom but differ in
mechanism (intra-package vs peer-package)". This investigation
**confirms two fully independent root causes** with no shared fix.
They share:

- The `__requireFrom` error shape (because `__requireFrom` is the
  single runtime entry point for any unresolved CJS require).
- The X.5-26b *symptom family* (something the install pipeline didn't
  ship into the runtime bundle/node_modules).

They differ in:

- **Layer.** §1 is a prefetch-bundle gap (file present on VFS, missing
  from `__vfsBundle`). §2 is an install-resolver gap (package never
  resolved → never installed → never on VFS).
- **Fix LOC.** §1 ~15-25 LOC, §2 ~3-5 LOC.
- **Fix file.** §1 in `src/facet-manager.ts`. §2 in
  `src/npm-resolver.ts` + `src/parallel/npm-resolve-preamble.ts`.
- **Generality.** §1's fix benefits any thin-shim CJS package across
  the tree. §2's fix benefits only Tailwind v4 (and any user typing
  `npm install tailwindcss` standalone).

**Verdict: do NOT fold into X.5-26b.** Neither is a cap-eviction
case; neither shares mechanism with W2.6b's typescript / lightningcss
/ tailwindcss-oxide native-binding cluster.

### §3.2 Should they be one bucket or two?

Two independent sub-buckets (X.5-peer-A nuxt, X.5-peer-B
tailwindcss-vite). Rationale:

- Different files → different code review surface.
- §2 is a 3-line change; §1 is a 15-25 LOC helper. Bundling them
  forces the smaller fix to wait on the larger one's regression-run
  budget.
- Independent dispatch lets §2 land first (instant verification) and
  §1's regression-test envelope (worst-case bundle-size impact across
  the 33-pkg matrix) run in parallel.

### §3.3 Fold-into-X.5-26b verdict

**NO.** X.5-26b territory is per VERIFY-23417C5 §3 W2.6b:
typescript single-file 9 MiB / lightningcss native binding /
tailwindcss-oxide optional-deps. Mechanism = cap eviction or native
binding gap. Neither §1 (greedy-doesn't-recurse) nor §2 (skip-list
false-positive) fits that envelope.

---

## §4. Backlog readiness + dispatch order

### §4.1 Dispatch matrix

| Bucket | Pkg | Effort | Dependencies | Confidence | Risk |
|---|---|---:|---|---|---|
| **X.5-peer-B** | tailwindcss-vite | ~3-5 LOC | None — straight skip-list edit. Unblocks immediately. | HIGH (mechanism fully understood, single-file regression scope) | LOW (bigger install, but harmless) |
| **X.5-peer-A** | nuxt | ~15-25 LOC | None — pure addition to greedyAddMainEntries. | MEDIUM-HIGH (mechanism confirmed; one-level recursion is bounded; needs full 33-pkg regression to confirm no bundle-size cap regressions) | LOW-MEDIUM (bundle-bytes ~5-10% growth on shim-heavy installs; cap loop already handles overflow gracefully) |

### §4.2 Recommended dispatch order

1. **First: X.5-peer-B (tailwindcss-vite).**
   - Smallest possible change (edit 1 line in 2 files + comment).
   - Independently verifiable: probe `npm install @tailwindcss/vite`
     + `require('@tailwindcss/vite')` smoke.
   - No bundle-size regression risk (just enables an additional install).
   - Predicted +1 ✅.

2. **Then: X.5-peer-A (nuxt).**
   - Larger surface; needs the full 33-pkg regression matrix to
     confirm no bundle-byte-cap eviction regressions on adjacent
     packages.
   - Side-effect bonuses possible (other thin-shim packages); retro
     should re-run the 33-pkg matrix and quantify.
   - Predicted +1 ✅, possibly +1-2 bonus.

### §4.3 Dispatch-readiness gate

Both buckets are **dispatch-ready**:

- ✓ Root cause confirmed with file:line evidence.
- ✓ Fix shape sketched with LOC estimates.
- ✓ Land site identified.
- ✓ No parent-enabler dependency (§1 doesn't need W2.6b cap-bump
  unless Option C is selected — Option A is the recommendation).
- ✓ Risk register populated.

### §4.4 Predicted matrix delta

| State | Strict ✅ | % |
|---|---:|---|
| `23417c5` baseline | 27/33 | 82% |
| + X.5-peer-B (tailwindcss-vite) | 28/33 | 85% |
| + X.5-peer-A (nuxt) | 29-30/33 | 88-91% |

(Bonus packages, if any, push toward 30-31/33. Combined with the
existing roadmap (S → W2.6b → peer-gap), full path predicts
32-33/33 = 97-100% strict.)

---

## §5. Anti-fixes (DO NOT)

| DO NOT | Why |
|---|---|
| Fold §1 + §2 into a single bucket | Different files, different mechanisms, different LOC scopes. Bundling forces lockstep dispatch. |
| Add `__fsMod` fallback to `__fileExists` (`src/node-shims.ts:2045`) | Would mask the prefetch-bundle gap by falling through to runtime VFS reads. Defeats the W2.6a "ship a static bundle" architecture and re-introduces the cold-cache penalty W2.5b/W2.6a were designed to eliminate. The bundle is the contract; widening its content is the right fix. |
| Ship `dist/` for every package unconditionally in greedy oversample | Would bloat the bundle by 2-3× on most installs. Targeted one-level relative-require follow keeps it bounded. |
| Convert SKIP_PACKAGES to a dynamic packument-aware filter | Adds a synchronous → async conversion in a hot path. Versioned skip-by-major is a broader refactor; out of scope for X.5. |
| Replace greedyAddMainEntries with full-recursion prefetchForRequire-per-package | Predicted bundle-byte cap blowout on big trees. Forces a coordinated W2.6b cap-bump first. Premature for X.5-peer-A's blast radius. |
| Edit `src/nimbus-session*.ts` | Out of scope per audit charter (X.5-C precedent). |

---

## §6. Open questions / followups

1. **Empirical bundle-bytes impact of §1's one-level walk.** Estimated
   5-10% on shim-heavy installs; pre-implementation probe should
   measure on the nuxt 526-pkg install to pin.
2. **Does §1 unblock other ⚠ packages?** Unbuild-emitted shims are a
   common pattern. A retro-time scan of the 33-pkg matrix for
   "thin CJS shim → ../dist" patterns is recommended.
3. **Is `peerDependencies` of `@tailwindcss/node` ever set in older
   versions?** Probe p2 covers 4.2.4. If older 4.x had peer instead
   of regular dep, the X.5-F R2 peer-walker would have caught it.
   Not material to the fix (Option A removes the skip regardless),
   but worth noting in the retro for completeness.
4. **Should `parcel` and `webpack` follow the same v4-style runtime-
   split audit?** Out of scope for X.5-peer-gap; flagged for future
   maintenance pass.

---

## §7. Verification plan (post-implementation)

For X.5-peer-B:
- Probe: `npm install @tailwindcss/vite` then `require('@tailwindcss/vite')`.
  Expect typeof === 'function' or 'object' (no `Cannot find module`).
- Regression: run full 33-pkg matrix, confirm no flip-back on
  adjacent packages.

For X.5-peer-A:
- Probe: `npm install nuxt` then `require('nuxt')`. Expect
  no `Cannot find module '../dist/defu.cjs'`.
- Regression: full 33-pkg matrix; specifically watch for any
  bundle-cap eviction flip on packages currently near the 22 MiB
  encoded ceiling.
- Bundle-bytes telemetry: log `totalBytes` post-greedy on the nuxt
  install; expect ≤ +10% vs baseline.

---

*Plan written under audit-only PLAN-ONLY constraint. No `src/` writes.
Implementation deferred to dispatchable X.5-peer-A / X.5-peer-B
sub-waves. See `X5peer-gap-investigation-retro.md` for retro.*
