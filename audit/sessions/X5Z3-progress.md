# X.5-Z3 progress log — pre-compile ESM (.mjs) at facet startup

> Branch: `x5z3-pre-compile-esm`
> Worktree: `/workspace/worktrees/x5z3-pre-compile-esm`
> Local main HEAD at start: `1e388a8` (audit: batch-merge-iv).
> Mode: BUILD. TDD red → green for jsdom Bucket Z3.
> Charter: VERIFY-700420F.md §4 #2 — extend W3.5 Fix B's ESM→CJS transform
> into facet startup pre-compile path. Predicted: +1 ✅ → 26/33.

## Phase A — Investigate ✓

- Wrangler dev launched on port 8787 against worktree HEAD `1e388a8`.
- i1 (`audit/probes/x5z3/investigation/i1-reproduce-jsdom.mjs`):
  attempted to reproduce VERIFY-700420F.md §4 #2 verbatim error. Result:
  the css-tokenizer ESM-pre-compile error **does not reproduce**.
  jsdom now fails at a different layer:
  `ENOENT: …/jsdom/lib/jsdom/browser/default-stylesheet.css`.
- i2 (`audit/probes/x5z3/investigation/i2-vfs-inspection.mjs`):
  - `require('@csstools/css-tokenizer')` → ✅ keys returned (Z3 transform
    healthy; X.5-Z5's looksLikeEsm relaxation already covers
    css-tokenizer's minified `}export{...}` shape).
  - `readdirSync('.../browser')` → returns the `.css` filename (manifest
    pass works).
  - `readFileSync('.../default-stylesheet.css')` → ENOENT; file is in
    VFS-on-disk + manifest, but **not in the prefetch bundle**.
- Root cause final: `buildPrefetchBundle` (`src/facet-manager.ts:885`)
  + `prefetchForRequire` (`src/require-resolver.ts:418`, out of scope)
  only collect files reachable through the require graph (.js/.mjs/.cjs)
  + pkg.json/main entry. Asset files (.css/.html/.txt) loaded at
  runtime via `fs.readFileSync(path.resolve(__dirname, "..."))` are
  excluded from the bundle. fs shim's `readFileSync`
  (`src/node-shims.ts:202-215`, also out of scope) ONLY consults the
  bundle, no fall-back to live VFS — so jsdom's
  `living/css/helpers/computed-style.js:16-19` fires ENOENT.
- Goalposts moved between 700420f → 1e388a8: this is a **NEW bucket**,
  call it Z4-asset-prefetch. The same goalposts-shift happened to
  fastify between 700420f → a571079 (X.5-R retro doc). The original Z3
  is empty.
- See `audit/probes/x5z3/investigation/SUMMARY.md` for full write-up.

Commits:
- `c1db81e` x5z3 phase A: investigation — Z3 bucket empty at 1e388a8.

## Phase B — Plan ✓

- `audit/sections/X5Z3-plan.md` shipped (~9 KB).
- Sub-agent self-review built into §6 (6 sub-questions answered).
- Bucket re-classified Z3 → Z4-asset-prefetch (branch-name kept for
  trace continuity).
- File scope: `src/facet-manager.ts` only (within prompt's nominal
  3-file allowlist).
- Probe matrix specified: 3 functional + 3 regression + 3 e2e + run-all.
- Predicted ✅ delta revised to +1 (jsdom), 25/33 cumulative — the
  prompt's "26/33" double-counted X.5-R's redis flip already in the
  24/33 baseline at 66b6897+.

Commits:
- `b2793c4` x5z3 phase B: X5Z3-plan.md.

## Phase C — TDD-RED ✓

- 3 functional probes (f1-readfilesync-asset, f2-asset-extensions,
  f3-skip-dynamic) — RED at HEAD (`addStaticReadFileAssets` not
  exported).
- 3 regression probes (r1-no-bundle-cap-blowup, r2-vfs-not-found,
  r3-existing-bundle-untouched) — GREEN (helper missing → safe path
  exercised; idempotency / no-clobber assertions vacuously hold).
- 2 cross-wave guards (x5f install-pipeline-coverage-shim, x5f
  single-resolver-source) — GREEN, no regression.
- 3 e2e probes (e1-jsdom-loads, e2-jsdom-window,
  e3-tailwindcss-vite-pre-existing-fail) — gated on
  NIMBUS_X5Z3_E2E=1; e1 verified RED (verbatim ENOENT default-stylesheet
  reproduces).
- run-all driver at `audit/probes/x5z3/run-all.mjs`. Pre-fix transcript
  at `audit/probes/x5z3/run-all-RED-pre-fix.txt` (5/8 PASS, the 3
  functional fail expected pre-fix).

Commits:
- (Phase C commit hash will be written into history at the time of
  the commit; see `git log` for exact SHA.)

## Phase D — BUILD ✓

- `src/facet-manager.ts:+146 / -0` — single addition: new exported
  helper `addStaticReadFileAssets(vfs, cwd, bundle, budgetState)` and
  one call-site (numbered "2.25") in `buildPrefetchBundle` between
  greedy and ESM-transform passes.
- Helper shape mirrors `greedyAddMainEntries` (same `budgetState`
  counter, same VFS_BUNDLE_MAX_FILES / VFS_BUNDLE_MAX_BYTES caps,
  same return-pattern).
- Regex: `/(?:\bfs\s*\.)?readFileSync\s*\(\s*(?:[\w$.]+\s*\.\s*)?resolve\s*\(\s*__dirname\s*,\s*(['"`])([^'"`]+)\1\s*[\),]/g`.
  Conservative — literal-only; rejects template-literal-with-`${}`
  and any non-asset-extension match.
- Comment-stripped first (`/\/\/[^\n]*/` + `/\/\*[\s\S]*?\*\//`).
- Asset extensions whitelisted: .css / .html / .htm / .svg / .txt
  / .json.
- Path resolution mirrors runtime: source file's containing dir is
  the `__dirname` substitute; `..` walks up; absolute paths handled
  too (defensive).
- All errors swallowed (missing asset, unreadable VFS, non-string
  reads) — silent skip per W3.5 Fix B precedent.

Post-fix verification:
- `bun audit/probes/x5z3/run-all.mjs` — 8/8 PASS local (functional+
  regression+cross-wave).
- `NIMBUS_X5Z3_E2E=1 BASE=http://127.0.0.1:8787 bun
  audit/probes/x5z3/run-all.mjs` — **11/11 PASS** including all 3
  e2e probes (jsdom loads, jsdom JSDOM(...).window resolves, tlw-vite
  pre-existing-fail still pre-existing-fails — NOT regressed).
- `bun x tsc --noEmit` — 2 errors (pre-existing baseline; byte-
  identical to pre-fix tsc output: `esbuild-wasm/esbuild.wasm` type
  decl missing + `nimbus-session-init.ts:74` provider type mismatch).
  No new errors introduced by the helper.

Commits:
- `5aba05d` x5z3 phase D BUILD: addStaticReadFileAssets in src/facet-manager.ts
  (+146 LOC, purely additive). e1-jsdom-loads e2e: JSDOM-OK keys present.

## Phase E — Audit ✓

- Final run-all: **11/11 GREEN** (3 functional + 3 regression +
  2 cross-wave + 3 e2e). Transcript:
  `audit/probes/x5z3/run-all-GREEN-post-fix.txt`.
- Cross-wave X.5-* run-alls: **9/10 clean GREEN**; the 1 fail is
  `x5z5-build/e2e/tailwindcss-vite` which is **pre-existing**
  (lightningcss native binding gap, signature byte-identical to the
  saved pre-X5Z3 transcript at `audit/probes/x5z5-build/run-all.txt`).
- Heavy regressions:
  - `run-mossaic-prod-w2.mjs` → **PASS** (status=200, external=0, alive=true).
  - `x5r/regression/r-w1.mjs` → **PASS** (external=0, twOk=true).
- tsc: 2 baseline errors only (esbuild-service.ts:153 +
  nimbus-session-init.ts:74), byte-identical to pre-fix.
- Mid-audit incident: workerd V8 OOM after 8 sequential run-alls in
  one DO (X.5-NPQO-documented sandbox 512 MiB cap). Restarted
  wrangler; e2e probes recovered cleanly. NOT a regression.
- Audit summary at `audit/probes/x5z3/AUDIT-SUMMARY.md`.

Commits:
- `1292c01` x5z3 phase E AUDIT: 11/11 GREEN, 0 cross-wave regressions.

## Phase F — Push ✓ (halted-on-grant — expected)

```
$ git push origin x5z3-pre-compile-esm
remote: Access denied: grant not approved
fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/':
       The requested URL returned error: 403
```

Same 403 grant-lapse documented in batch-merge-iv-progress.md and
verify-700420f-progress.md. Branch tip stays local at `1292c01`;
ready for next session's grant restoration → push.

Local branch: `x5z3-pre-compile-esm` @ `1292c01` (1 ancestor of
1e388a8 main, 5 commits ahead).

## Phase G — Retro ✓

- `audit/sections/X5Z3-retro.md` shipped (~10 KB).
  - §1 per-package verdict (jsdom ✅ / tailwindcss-vite ⚠ unchanged).
  - §2 root cause final (Z3 bucket empty; Z4-asset-prefetch the real
    blocker; fix is +146 LOC in `addStaticReadFileAssets`).
  - §3 scope deviations (Z3 → Z4 re-classification, file scope kept,
    +1 → 25/33 not 26/33 because prompt double-counted X.5-R redis).
  - §4 regression verdict (0 cross-wave regressions; 9/10 X.5-* clean,
    the 1 fail = pre-existing tlw-vite lightningcss).
  - §5 what surprised (goalposts moved again; fs-shim no-fallback
    boundary; lightningcss = same W2.6b cap shape; wrangler V8 OOM).
  - §6 predicted vs actual (+1 ✅ delivered, +1 ✅ plan-predicted —
    match).
  - §7 roadmap candidates (W2.6b cap sweep; asset-prefetch widening;
    push-grant restoration).
  - §8 phase tally (A B C D E G ✓; F halted-on-403).

Commits: (Phase G ships next — this is the final commit.)




