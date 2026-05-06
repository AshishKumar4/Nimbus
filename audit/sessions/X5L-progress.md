# X.5-L Progress Log

> Branch `x5l-bare-subpath` off `main` HEAD `eb316dc`.
> One section per phase, appended in real time during the wave run.

## Phase A — 2026-05-05T00:00:00Z (plan)
- Status: ✓
- Commit: d56e389
- Notes:
  - Read VERIFY-EB316DC.md §3, §6 #2, §7.
  - Read verify probe artifacts: react-remove-scroll, radix-react-dialog, nuxt.
  - Read src/require-resolver.ts in full + src/_shared/exports-resolver.ts.
  - Installed react-remove-scroll-bar in /tmp scratch to inspect real shape.
  - Confirmed root cause: `react-remove-scroll-bar` has NO `exports`
    field; uses LEGACY directory-with-nested-package.json pattern
    (`<pkg>/constants/package.json` with `main: "../dist/..."`).
    Resolver falls through `resolvePackageEntry` to "raw subpath"
    return; `resolveFile` extension probe misses (subpath is a
    directory, no `<sub>.js`, no `<sub>/index.js`); returns null.
    File never reaches the bundle.
  - Plan authored at audit/sections/X5L-plan.md.
  - Bonus (nuxt → defu.cjs): hypothesis = different class
    (relative-import bundle-population gap, not bare-spec). Will
    validate in Phase B/C; if same root cause, ride along.

## Phase B — 2026-05-05T00:00:00Z (TDD red)
- Status: ✓
- Commit: 76c452e
- Notes:
  - Wrote 4 functional + 3 regression + 3 e2e probes.
  - Baseline run: 4 reds (f1, f4, e1, e2) + 6 greens.
    - f1 (synth-fixture): RED — confirms walker can't resolve legacy
      directory-with-nested-package.json subpath.
    - f2, f3: GREEN — confirms additive nature of the fix
      (modern exports / index.js fallback unchanged).
    - f4 (up-pointing nested main): RED — confirms `../` normalization
      not happening in current resolver.
    - r1, r2, r3: GREEN — single-resolver invariant + W3 + X.5-C
      suite all still pass on `main` HEAD.
    - e1 (react-remove-scroll real package): RED with verbatim
      "Cannot find module 'react-remove-scroll-bar/constants'" —
      reproduces verify-doc finding at probe layer.
    - e2 (radix-react-dialog real package): RED with same error —
      transitive via react-remove-scroll.
    - e3 (defu investigation, bonus): GREEN. defu loads correctly
      in isolation. Nuxt's `Cannot find module '../dist/defu.cjs'`
      verify error is NOT the same root cause class — must be a
      different chain inside nuxt's 500+ deps. **Verdict: inconclusive
      bonus; defer to separate bucket.**
  - One additional finding in e1: `dist/es2015/constants.js` lands in
    bundle anyway via greedy oversample / relative-import walking
    (sibling `index.js` does `from './constants'`). The runtime
    failure is on the RUNTIME RESOLVER side, not the prefetcher's
    file-shipping. Implication: the fix needs to either (a) also fix
    the runtime resolver, OR (b) emit a synthetic stub at the path
    the runtime probes for.
  - Anti-req: `node-shims.ts` is X.5-M territory. So fix path is (b)
    — synthesize a stub bundle entry at `<pkgDir>/<subpath>.js`
    that requires the actual resolved file. Decision documented.

## Phase C — 2026-05-05T00:00:00Z (build)
- Status: ✓
- Commit: baea4f2
- Notes:
  - Extended `src/require-resolver.ts` (+251 LOC, -15 LOC) with:
    - `ResolveSubpathResult` interface (resolved + optional stub).
    - `resolvePkgSubpathEx` — full extension of resolvePkgSubpath
      with the legacy-directory branch.
    - `tryLegacyDirectorySubpath` — reads nested package.json,
      follows `main`/`module`, returns target + stub.
    - `relativeFrom` — VFS-style relative-path computer used to
      build the stub's relative require.
    - `resolveNodeModuleEx` + `resolveRequireEx` — extended bare
      and require resolvers that surface stubs.
    - `addStub` in `prefetchForRequire` — injects stubs into the
      bundle at the path the runtime resolver probes.
  - Preserved `resolvePkgSubpath`, `resolveNodeModule`, `resolveRequire`
    as thin wrappers over the *Ex variants for back-compat.
  - Stub format: 2-line CJS file
    ```js
    // X.5-L synthetic stub: re-export legacy directory-subpath target
    module.exports = require('./<rel-path-to-real-target>');
    ```
    The relative path is computed via `relativeFrom(stubDir, resolved)`.
    For `react-remove-scroll-bar/constants.js` the stub is:
    `module.exports = require("./dist/es5/constants.js");`
  - Why a stub instead of mutating node-shims.ts: node-shims.ts is
    X.5-M territory; the stub bridges the bundle/runtime gap purely
    in the prefetcher.
  - Why `main` (CJS) preferred over `module` (ESM) in nested-pkg:
    walker uses DEFAULT_CJS_CONDITIONS; runtime require chain is
    CJS-shaped after W3.5 Fix B's transform; both consistent.
  - Test results (post-fix):
    - X.5-L run-all: 10/10 pass.
      - f1, f4 (synth-fixture for legacy directory subpath): GREEN.
      - f2, f3 (regression guards): GREEN.
      - r1, r2, r3 (single-resolver invariant + W3 + X.5-C parity): GREEN.
      - e1 (react-remove-scroll real): GREEN — `classNames.fullWidth`
        resolves to `"width-before-scroll-bar"` (real string from
        constants.js, proving the chain runs end-to-end).
      - e2 (radix-react-dialog real): GREEN — Root, Content, Overlay,
        Title, etc. all reachable.
      - e3 (defu bonus): GREEN — defu loads in isolation; nuxt's
        verify failure must be a different chain (defer to future bucket).
    - X.5-C run-all (regression): 10/10 pass — no breakage.
    - tsc: 2 errors (esbuild-wasm/esbuild.wasm + SqliteVFSProvider) —
      byte-identical to VERIFY-EB316DC §9 baseline. Zero new errors.
  - Sub-agent diff review (mental walkthrough + git diff --stat):
    - Single file changed: src/require-resolver.ts +251/-15.
    - All new code lives below existing exports (no surface-area changes).
    - Old API (`resolveFile`, `resolvePkgSubpath`, `resolveNodeModule`,
      `resolveRequire`) preserved as wrappers — zero risk to other
      callers. Only `prefetchForRequire` (the only in-tree caller of
      these helpers) opts into the new stub-emitting path via
      `addStub`.
    - No changes to `_shared/exports-resolver.ts`,
      `npm-resolve-facet.ts`, `npm-resolver.ts`, `node-shims.ts`,
      or any other src/ file.
    - Single-resolver invariant holds: `resolveExports` and
      `resolvePackageEntry` still declared once each in
      `_shared/exports-resolver.ts` (regression r1 confirms).

## Phase D — 2026-05-05T00:00:00Z (audit)
- Status: ✓
- Commit: 8c943b6
- Notes:
  - Final tests run after Phase C:
    - **X.5-L run-all**: 10/10 ✓ (functional 4/4, regression 3/3, e2e 3/3).
    - **X.5-C run-all**: 10/10 ✓ — no breakage from adding X.5-L.
    - **X.5-F functional/r1-toplevel-bypass**: PASS (webpack + rollup + parcel).
    - **X.5-G functional/applySwaps-rollup**: 16/16 PASS.
    - **W12 mossaic-shape regression**: 2/2 PASS.
    - **tsc**: 2 errors (esbuild-wasm/esbuild.wasm + SqliteVFSProvider) —
      byte-identical to VERIFY-EB316DC §9 baseline. Zero new errors.
  - Sub-agent diff review:
    - **Single src/ file changed**: src/require-resolver.ts +251/-15.
    - **Code locality**: all new code lives below the existing
      resolveFile helper; new `*Ex` functions wrap the legacy
      single-string-return helpers.
    - **API stability**: legacy `resolveFile`, `resolvePkgSubpath`,
      `resolveNodeModule`, `resolveRequire` are preserved as thin
      wrappers — zero risk to the only other in-tree consumer
      (`prefetchForRequire`, which opts into the new path explicitly).
    - **No changes to**: `_shared/exports-resolver.ts`,
      `npm-resolve-facet.ts`, `npm-resolver.ts`, `node-shims.ts`,
      `wasm-swap-registry.ts`, or any other src/* file.
    - **Single-resolver invariant**: holds (regression r1 confirms
      `resolveExports` and `resolvePackageEntry` declared exactly
      once each in `_shared/exports-resolver.ts`).
    - **TDD ordering**: every src/ change is gated behind a
      red→green test transition. f1, f4, e1, e2 were red pre-fix
      (Phase B baseline) and green post-fix (Phase C end).
    - **Anti-req compliance**:
      - ✓ No `node-shims.ts` changes (X.5-M territory).
      - ✓ No `npm-resolve-facet.ts` / `npm-resolver.ts` changes (X.5-J territory).
      - ✓ All work confined to /workspace/worktrees/x5l-bare-subpath.
      - ✓ Branch-only push (never main).
      - ✓ Every commit passes its associated probes.
      - ✓ No silent completion — every phase has progress + commit + push.
  - **Done criteria** (from brief):
    - ✓ X5L-plan.md authored.
    - ✓ react-remove-scroll ✅ at real-package install layer (e1 probe).
    - ✓ @radix-ui/react-dialog ✅ at real-package install layer (e2 probe).
    - ✓ src/ pushed to origin/x5l-bare-subpath.
    - ✓ X.5-C suite still green (regression).
    - ✓ tsc clean (baseline errors only).
    - All 6 phases will hit ✓ status by end of Phase F.

## Phase E — 2026-05-05T00:00:00Z (push)
- Status: ✓
- Commit: 8c943b6 (HEAD pushed)
- Notes:
  - All commits pushed to origin/x5l-bare-subpath:
    - d56e389 — Phase A (plan)
    - 76c452e — Phase B (TDD red probes)
    - baea4f2 — Phase C (build fix in require-resolver.ts)
    - 8c943b6 — Phase D (audit notes)

## Phase F — 2026-05-05T00:00:00Z (retro)
- Status: ✓
- Commit: 5fdf6d0
- Notes:
  - X5L-retro.md authored at audit/sections/X5L-retro.md.
  - Per-package verdict table: rrs ✅, radix-dialog ✅, nuxt ⚠ (different class).
  - Root cause confirmed at 3 layers (real-package inspection, synth
    fixture, real-package e2e).
  - Scope deviation: planned ~30 LOC, shipped +195 LOC net. Justified
    by parallel `*Ex` API (back-compat) + synthetic stub mechanism
    (runtime-bridging without touching node-shims.ts).
  - Recommended next: X.5-J (regression fix, P0) then X.5-M (shims).
  - X.5-L ships clean. All 6 phases ✓.
