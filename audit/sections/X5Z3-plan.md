# X.5-Z3 plan — pre-compile ESM .mjs at facet startup (REVISED — bucket empty, new bucket Z4-asset-prefetch substituted)

> Branch: `x5z3-pre-compile-esm`. Worktree HEAD at start: `1e388a8`.
> Charter (per VERIFY-700420F.md §4 #2): unblock jsdom by extending
> W3.5 Fix B's ESM→CJS transform into facet startup pre-compile path.
> **Realised charter (Phase A finding): the original Z3 bucket is
> already empty at 1e388a8.** The fix that flips jsdom is in a
> different (sibling) bucket, but the prompt's done-criterion ("jsdom
> ✅ at real-package install layer") and file-scope ("src/pre-bundle-
> facet.ts, src/facet-manager.ts, src/barrel-synthesizer.ts") still
> match. Branch name kept for trace continuity.

## 1. Investigation summary

See `audit/probes/x5z3/investigation/SUMMARY.md` for full evidence.

**One-line:** Between 700420f (when VERIFY-700420F was captured) and
1e388a8 (current main, post X.5-Z5-build, post X.5-R), the
`@csstools/css-tokenizer/dist/index.mjs` ESM-pre-compile error
**stopped reproducing** as a side-effect of X.5-Z5-build's
looksLikeEsm regex relaxation in `src/facet-manager.ts:780`
(originally targeted at @tailwindcss/vite). jsdom now fails at a
different layer:

```
Error: ENOENT: no such file or directory, open
       '/home/user/app/node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css'
    at Object.readFileSync (runner.js:234:19)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:18:30)
```

Originating in jsdom's `lib/jsdom/living/css/helpers/computed-style.js:16`:
```js
const defaultStyleSheet = fs.readFileSync(
  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),
  { encoding: "utf-8" },
);
```

i2 confirmed:
- The .css file IS in VFS-on-disk (`ls` shows it).
- The .css file IS in `__MODULE_VFS_MANIFEST` (`fs.readdirSync` returns
  it).
- The .css file is **NOT in `__MODULE_VFS_BUNDLE`** — `fs.readFileSync`
  ENOENTs because the fs shim only consults bundle+writes.
- `require('@csstools/css-tokenizer')` succeeds — Z3 transform works.

## 2. Root cause final

**Bucket Z4-asset-prefetch** (NEW — sibling of Z3, NOT identical).

The facet runtime is fully air-gapped from VFS. Everything readable at
runtime must be in `__MODULE_VFS_BUNDLE` (file content) or
`__MODULE_VFS_MANIFEST` (directory shape only). The prefetch passes:

| Pass | Source file:line | What it adds |
|---|---|---|
| 1. Reachable-set walk | `require-resolver.ts:418` (`prefetchForRequire`) | files reached via `require()` / `import` chains in the user entry — `.js/.mjs/.cjs` only (`.ts/.json` indirectly via the recurse guard at `:484`). |
| 2. Greedy main-entries | `facet-manager.ts:606` (`greedyAddMainEntries`) | Every installed pkg's `package.json` + `meta.main` / `meta.module` / `dot.import` candidate. JS-shaped, again. |
| 2.5. ESM→CJS transform | `facet-manager.ts:822` (`transformEsmInBundle`) | NOT a collection pass; transforms what's already in `bundle`. |
| 3. Manifest pass | `facet-manager.ts:558` (`buildManifest`) | All directory shapes (uncapped). Names only — no content. |

**Asset files (.css/.html/.txt/.svg) loaded at runtime via
`fs.readFileSync(path.resolve(__dirname, "<rel>"))` are excluded.**

This is broader than jsdom — any package that ships a runtime asset
file and reads it via `fs.readFileSync` will hit the same wall. We
just hadn't tripped over it before because:
- W3.5 / X.5-C / X.5-Z5 progress chained jsdom past earlier blockers
  (`tldts` ESM, `node:util/types`, css-tokenizer ESM minified shape)
  step by step.
- jsdom's `default-stylesheet.css` load happens at module
  evaluation time, deep in the require graph, so it was masked until
  the chain reached this layer.

## 3. Fix sketch

**File scope:** `src/facet-manager.ts` only. `src/pre-bundle-facet.ts`
and `src/barrel-synthesizer.ts` are nominally in scope per the prompt
but neither is the right home for this pass — those run at install
time over the resolver's per-pkg view, while the facet
prefetch+greedy passes already exist in `facet-manager.ts` and
operate on the same in-memory `bundle: Record<string, string>` we
need to extend. Keeping the change there preserves the W3.5 →
X.5-C → X.5-Z5 progression of "everything-runtime-bundle-related lives
in facet-manager.ts".

**New helper: `addStaticReadFileAssets(bundle, vfs)`**

After `greedyAddMainEntries` and before `transformEsmInBundle`, scan
every bundled JS source for the **static-asset readFileSync pattern**:

```regex
fs\.readFileSync\(\s*path\.resolve\(\s*__dirname\s*,\s*(['"`])([^'"`]+\.(?:css|html|htm|svg|txt|json))\1\s*\)
```

Or the equivalent split-line and `readFileSync` (no `fs.` prefix)
forms. Conservative — string literals only, no template-literal /
binary expression / variable interpolation.

For each match:
1. Compute `assetVfsPath = path.resolve(<source-file-dir>, <captured-relative>)`
   in the same way the runtime would have
   (`__dirname` for the source file is the source's containing dir).
2. Strip leading `/` to match VFS bundle key format.
3. If `vfs.exists(assetVfsPath)` and not already in bundle, read +
   add via `vfs.readFileString(assetVfsPath)` subject to the same
   byte-cap as elsewhere.
4. Increment fileCount/totalBytes counters.

The existing `BUNDLE_MAX_ENCODED_BYTES` eviction loop (line 949+)
already handles the rare case where a giant .css file would push the
encoded bundle over the workerd module-text-size budget — non-asset
files (ie .js sources) are evicted before the manifest, but assets
are .js's peers in `bundle`, so they share the same fate. Predicting
~50-200 KB of extra bundle bytes per package on the worst end (jsdom's
`default-stylesheet.css` is 17 KB).

### Why not just bake assets into the bundle at install time?

Two reasons:
1. The install pipeline already writes them into VFS (`readdirSync`
   confirms). The gap is only in the per-exec **prefetch** —
   collecting them at install time wouldn't help; they'd still need
   threading through the bundle the facet receives.
2. Per-exec collection is more selective: only collect what THIS
   exec's require-graph reaches, instead of bloating every facet's
   bundle with every package's assets. Matches the W2.6a posture
   ("bundle bounded by what the user's require chain actually reaches
   PLUS a greedy oversample" — facet-manager.ts:867).

### Why not extend the require-walker instead?

`require-resolver.ts` is OUT OF SCOPE per anti-requirements (X.5-L
territory). Even if it weren't, the walker's parser-state model is
keyed off `require()` / `import …` shapes; bolting an asset-readFileSync
pattern onto it is a nominal-fit but design-incoherent (the walker is
explicitly a "what the JS module graph reaches" tool, and an
fs.readFileSync of an asset is not in that graph). Better to put the
asset pass in facet-manager.ts as a sibling of `greedyAddMainEntries`.

## 4. Regression matrix

The fix is **purely additive** — we only WRITE to `bundle` for paths
not already present. No deletions, no semantic flips.

Risk classes:

| Risk | Mitigation |
|---|---|
| False-positive matches (regex grabs a string inside a comment / regex literal) | Same `comment-strip` trick as W3.5 Fix B's `looksLikeEsm`. Real `path.resolve(__dirname, "x.css")` inside a string literal is a non-issue: at worst we add a non-existent file via `vfs.exists` check (which short-circuits) or we add an unrelated file (still safe — just byte cost). |
| Bundle byte cap pressure | The eviction loop at `facet-manager.ts:949` already handles cap excess. |
| Duplicate adds (file in both prefetch + assets pass) | `if (path in bundle) continue` guard at top of helper. |
| Performance: regex over every bundle .js | Bounded — same scan as `transformEsmInBundle`. .js bundle is ≤ a few MB; one regex pass takes <100ms. |

Cross-wave guards we will keep green:

| Suite | Guards what |
|---|---|
| `audit/probes/install-pipeline-coverage.mjs` (or the equivalent at run-mossaic-prod-w2 / W1 / single-resolver) | install-time pipeline + W1 + single-resolver source-of-truth. |
| `audit/probes/run-mossaic-prod-w2.mjs` | Mossaic prod regression. |
| `audit/probes/x5j/run-all.mjs`, `x5l/run-all.mjs`, `x5m/run-all.mjs`, `x5npqo/run-all.mjs`, `x5z5-build/run-all.mjs`, `x5r/run-all.mjs` | All prior X.5 wave probes. |
| `bunx tsc --noEmit` | Baseline 2 errors only (pre-existing, byte-identical). |

## 5. Probe matrix (TDD-RED → GREEN)

Authored under `audit/probes/x5z3/{functional,regression,e2e}/`.

### Functional (3)

| Probe | What it asserts | Pre-fix state | Post-fix state |
|---|---|---|---|
| `f1-readfilesync-asset.mjs` | A synthetic pkg with `fs.readFileSync(path.resolve(__dirname, "./asset.css"))` in a JS source file gets `asset.css` into the bundle returned by `buildPrefetchBundle`. | RED — bundle missing the asset path. | GREEN — bundle has it. |
| `f2-asset-extensions.mjs` | The asset prefetch covers `.css`, `.html`, `.txt`, `.svg`, `.json`. | RED for .css/.html/.txt/.svg; .json may already be reachable via `require('./x.json')`. | GREEN for all 5. |
| `f3-skip-dynamic.mjs` | Template-literal / variable forms (e.g. `fs.readFileSync(__dirname + "/" + name)`) are NOT picked up — confirms scope is bounded to static literals. | RED (no match — same as post-fix). | GREEN — still no match (no false positive from dynamic forms). |

### Regression (5 + run-all linkage)

| Probe | Asserts |
|---|---|
| `r1-no-bundle-cap-blowup.mjs` | A realistic install (no asset references in source) does not include any extra files. |
| `r2-existing-bundle-untouched.mjs` | Files already in `bundle` (added by prefetch / greedy) are not re-added or duplicated. |
| `r3-vfs-not-found.mjs` | Static literal that resolves to a non-existent file is silently skipped (no throw). |
| `r4-no-comment-false-positive.mjs` | A `// fs.readFileSync(path.resolve(__dirname, "x.css"))` inside a comment is NOT picked up. |
| `r5-x5z5-tailwindcss-vite-still-flips.mjs` | The X.5-Z5 looksLikeEsm + walker fixes still cleanly handle tailwindcss-vite's pre-Z5 verbatim error (no cross-wave regression). |

Plus run-all driver linkage to existing suites:
- `audit/probes/install-pipeline-coverage.mjs`
- `audit/probes/run-mossaic-prod-w2.mjs`
- `audit/probes/x5z5-build/run-all.mjs`
- (lighter regression set — the heavy ones gated on env per X.5-R precedent)

### E2E (3)

| Probe | Asserts |
|---|---|
| `e1-jsdom-loads.mjs` | `cd app && npm install jsdom && node -e "const m=require('jsdom');console.log('keys:',Object.keys(m).slice(0,8))"` exits 0 with non-empty key list. **DONE-criterion satisfied.** |
| `e2-jsdom-window.mjs` | `new (require('jsdom').JSDOM)('<p>x</p>')` produces a parsed DOM (deeper smoke; confirms the .css load isn't merely silenced). |
| `e3-tailwindcss-vite-pre-existing-fail.mjs` | tailwindcss-vite still hits the same lightningcss native-binding error (NOT regressed). |

### run-all driver

`audit/probes/x5z3/run-all.mjs` — runs all functional + regression
locally + e2e gated on `NIMBUS_X5Z3_E2E=1` (per X.5-R precedent).

## 6. Self-review TL;DR

1. **Sub-q: how does this differ from W3.5 Fix B's pre-bundle path?**
   W3.5 Fix B operates on `bundle` AFTER prefetch — it transforms ESM
   files into CJS for the new-Function pre-compile loop. Our fix
   operates on `bundle` BEFORE Fix B's transform — it ADDS missed
   asset files that Fix B (and the pre-compile loop) wouldn't touch
   anyway (.css ≠ JS). Both passes are sibling extensions to
   `buildPrefetchBundle`, both purely additive. No code-path
   collision.

2. **Sub-q: why was the facet startup uncovered NOW?**
   It always was uncovered. The .css read at jsdom module-eval time
   was MASKED by earlier failures: pre-W3.5 jsdom couldn't even reach
   `living/css/helpers/computed-style.js` because tldts ESM blew up
   first. Each successive fix (W3.5 Fix B → X5C ESM transitive walk →
   X.5-NPQO Q's util/types → X.5-Z5 looksLikeEsm regex) peeled back a
   layer; the asset-prefetch gap was the next layer the X.5-Z5 fix
   exposed. Same mechanism we documented in X.5-Z5-build retro §2.2
   ("the Z5 investigation plan was scope-correct but layer-bounded").

3. **Sub-q: shouldn't this be a different wave entirely (Z4) given
   the bucket-mismatch?**
   Yes from a taxonomy standpoint — call it Z4 in the next roadmap
   sweep. But the BRANCH NAME `x5z3-pre-compile-esm` is preserved
   because (a) the prompt's done-criterion is met by this fix, (b)
   reverting and re-creating a `x5z4-asset-prefetch` branch costs
   trace continuity and is outside the prompt's "GO" mandate, and (c)
   future readers landing on this commit via `git log --grep` for
   either Z3 or jsdom will find both the original error report (in
   investigation/SUMMARY.md) and the resolution. X5Z3-retro will be
   explicit about the bucket re-classification.

4. **Sub-q: where would this fix have caught regression-test
   coverage at the time of W3.5?**
   It wouldn't have — the W3.5 failure modes (1=directory-as-index,
   2=ESM-not-detected) are orthogonal to the asset-prefetch gap, and
   the W3.5-plan §1 explicitly noted "we accept the limitation of
   `"type":"module"` packages with no statement-level import/export"
   as a residual edge — but that's a different edge (CJS-shaped ESM
   pkg), not "JS that reads a .css asset at runtime". Pre-W3.5 nobody
   ran jsdom past tldts.

5. **Sub-q: does this risk affecting Mossaic prod?**
   No — Mossaic's render path uses Vite, not the require-graph
   facet bundle. The fix is entirely scoped to `buildPrefetchBundle`
   which is the `node script.js` path. `audit/probes/run-mossaic-prod-w2.mjs`
   will be re-run as a regression smoke; expected: identical pass.

6. **Sub-q: anything about the original prompt's "extends W3.5 Fix B"
   framing that I should preserve?**
   The fix is in the same file as Fix B, in the same outer function
   (`buildPrefetchBundle`), placed adjacent (between greedy and Fix B
   passes). Pattern: same shape (scan-bundle, augment-bundle). Same
   philosophy. So while the LOGICAL bucket is Z4, the IMPLEMENTATION
   pattern faithfully follows the W3.5 Fix B precedent.

## 7. Predicted ✅ delta

- **jsdom: +1 ✅** at `package fully loads` measurement (the prompt's
  success criterion).
- **tailwindcss-vite: +0** (still blocked at lightningcss native — out
  of charter, per X5Z5-build-retro §2.2).
- Cumulative after fix: **24/33 → 25/33** (one ✅ flip; 26/33 was the
  prompt's optimistic bound assuming both Z3 members flipped, but
  tailwindcss-vite was already known-blocked at lightningcss).

  *Note on count drift:* The prompt referenced "Predicted: +1 ✅ →
  26/33 strict" — that's based on the X.5-R retro's "redis +1 ✅ at
  HEAD a571079" → 24/33 baseline. Adding +1 (jsdom) → 25/33. The
  prompt likely double-counted X.5-R's redis flip (already merged at
  66b6897) when computing the `26` target. We will hit **25/33**
  conservatively.
