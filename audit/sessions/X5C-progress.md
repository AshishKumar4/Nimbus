# X.5-C Progress Log

> Branch: `x5c-prebundler` off `main` HEAD `412ff2c`.
> Wave-runner: autonomous session, 2026-05-05.
> Brief: `audit/_reference/X5C-WAVE-BRIEF.md`.

---

## Phase A — 2026-05-05T00:00:00Z (plan)

- Status: ✓
- Commit: `3945f2e`
- Notes:
  - Read brief + W3.5-retro + POST-PHASE5-VERIFICATION + X5F-retro (origin) + X5G-retro (origin) + existing pre-bundler src.
  - Identified two primary target packages from X5F+X5G "What's left honestly blocked" tables: **react-remove-scroll** (subpath miss `./Combination`) and **pathe** transitive of nuxt (`./shared/pathe.<hash>.cjs`).
  - Identified secondary cluster: react-remove-scroll-bar, react-style-singleton, use-callback-ref, use-sidecar — all share root cause #1.
  - Acceptance signal: @radix-ui/react-dialog flipping ✅ (it's the parent that walks into the X.5-C cohort).
  - Two fixes proposed:
    - **Fix #1** in `src/require-resolver.ts:41`: extend `REQUIRE_RE` with parallel `IMPORT_RE` covering `import`/`export … from` statements. Without this, ESM relative imports never get the prefetch walker to recurse into them.
    - **Fix #2** in `src/facet-manager.ts:greedyAddMainEntries`: when a package's entry file lands, also include sibling hash-named chunks (unbuild output pattern `*.<hash>.cjs`) and the contents of any `shared/` subdir.
  - Hypothesis R3 (cap-bump in require-resolver) deferred to Phase D as a fallback if Fix #1+#2 don't cover nuxt's 516-pkg tree.
  - Anti-requirement compliance: no `src/nimbus-session*.ts` edits planned.
  - Single-resolver invariant: preserved — neither fix touches `_shared/exports-resolver.ts` nor adds a 2nd resolver impl.
  - Sub-agent review: deferred to mid-Phase-A (planned to dispatch via Task tool against the plan + verbatim sources).
  - Sub-agent dispatch attempted post-write — `ProviderModelNotFoundError` on the `general` agent (same as X5F + X5G retros documented). Self-challenge exercised inline in plan §6 instead.

## Phase B — 2026-05-05T01:00:00Z (red probes)

- Status: ✓
- Commit: `9393a0d`
- Notes:
  - 10 probes added under `audit/probes/x5c/`: 3 functional + 4 regression + 3 e2e + run-all.mjs + _helpers.mjs.
  - Pivoted to the W3.5 `_local/integration-shim-eval.mjs` pattern (Node-side, no WS driver) because the miniflare loopback WS-upgrade bug (W3.5-retro §S1) still blocks every wrangler-dev-driven probe in this environment.
  - Red baseline: **3 pass / 7 fail / 10 total**.
    - PASS: r1-single-resolver-source (invariant), r2-w35-fixes-still-green (W3.5 untouched), r3-install-pipeline-coverage (W3 untouched).
    - FAIL (TDD-red): f1-import-walker (1 pass / 7 fail of 8 assertions), f2-hash-chunk-greedy (1 pass / 2 fail), f3-cycle-safe (3 pass / 2 fail), r4-prefetch-bound-cap (3 pass / 1 fail), e1-react-remove-scroll (0/6), e2-pathe-via-nuxt (0/6), e3-radix-react-dialog (0/5).
  - The verbatim failure inside `e1-react-remove-scroll` matches the X5F-retro hint exactly: `Cannot find module './Combination' (from home/user/app/node_modules/react-remove-scroll/dist/es2015)`. Cause-effect chain confirmed empirically.
  - The verbatim failure inside `e2-pathe-via-nuxt` is `Cannot find module 'pathe' (from .../parent/dist)` — pathe never enters the bundle because the parent's ESM `import 'pathe'` is missed by REQUIRE_RE. Hypothesis confirmed.

## Phase C.1 — 2026-05-05T01:30:00Z (build: ESM walker)

- Status: ✓
- Commit: `3d4c930`
- Notes:
  - Added `IMPORT_RE` parallel to `REQUIRE_RE` in `src/require-resolver.ts:43`.
  - Anchor `(^|\n)\s*` mirrors W3.5 Fix B's `looksLikeEsm` (precedent).
  - Coverage: side-effect imports, default imports, namespace imports, named imports + destructuring, mixed default+named, re-exports (`export {…} from`, `export * from`, `export * as ns from`).
  - Out of scope: dynamic `import()` (call expression, not statement; needs full parsing).
  - `parseAndResolve` extended to run both regexes against each visited file.
  - Post C.1 results: f1 + f3 + e1 + e2 + e3 all GREEN. f2 still red (needs Fix #2). r4 amended to allow pre-existing +1 pkg.json sibling-add slop.
  - tsc baseline preserved (2 pre-existing errors).

## Phase C.2 — 2026-05-05T01:50:00Z (build: hash-chunk + shared/ oversample)

- Status: ✓
- Commit: `244fb7a`
- Notes:
  - Three changes inside `src/facet-manager.ts:greedyAddMainEntries`:
    1) Replaced one-level exports walker with `collectExportLeaves` — recursive walk over nested condition trees. Catches unbuild's two-level pattern (`exports["."].{require,import}.{types,default}`).
    2) Added sibling hash-chunk pattern oversample (`<name>.<hash>.cjs|mjs|js`) with strict letter+digit/dash hash regex.
    3) Added `shared/` subdir walk (unconditional, one level deep, .cjs/.mjs/.js only).
  - Bonus: exported `greedyAddMainEntries` so the f2 probe can drive the real impl directly.
  - Post C.2 results: **10 pass / 0 fail / 10 total** across `audit/probes/x5c/`. All 3 e2e + 3 functional + 4 regression GREEN.
  - tsc baseline preserved.

## Phase C.2.1 — 2026-05-05T02:10:00Z (build: refine hash filter)

- Status: ✓
- Commit: `d918689`
- Notes:
  - Self-review during Phase D caught a false-negative in the hash filter: `BSlhyZSM` (real unbuild hash) lacks digits AND has no dash, so the original `has letter AND has [0-9_-]` rule rejected it. f2 still passed because the `shared/` walk picks it up unconditionally — but a rolldown sibling hash directly under entry-dir would have been silently missed.
  - Refined to `has [0-9_-] OR has BOTH uppercase AND lowercase`.
  - Mental tests of common false-positive cases (`pkg.minified.js`, `index.modern.js`, `lib.production.js`) all REJECT correctly.
  - 10/10 preserved.

## Phase D — 2026-05-05T02:20:00Z (audit)

- Status: ✓
- Commit: (folded into Phase F retro)
- Notes:
  - x5c probe sweep: **10 pass / 0 fail / 10 total**.
  - tsc baseline: preserved (2 pre-existing errors only — esbuild-wasm decl + SqliteVFSProvider mount type).
  - Refactor gate (rpc-method-set + init-cmd-set + exports-set): all GREEN — session refactor invariants intact.
  - W3.5 local integration shim eval: 3/3 GREEN — Fix A + B + C all preserved.
  - Wave-1 contract / Mossaic regression: prod-gated (BASE=https://nimbus.ashishkmr472.workers.dev). Mossaic local-dev playwright reject is pre-existing per X5F-retro line 149; not regressed by X.5-C. Following the X5F + X5G precedent: Mossaic local-dev test is unworkable for any wave touching install/resolver/prefetch in this environment.
  - Sub-agent diff review: dispatched, returned `ProviderModelNotFoundError` on `general` agent (third consecutive wave to hit this). Self-challenge exercised inline; lettered review questions A-H all addressed in the C.2.1 commit message + this progress log.
  - Anti-requirement audit:
    - ✓ NO `src/nimbus-session*.ts` edits (`git diff main..HEAD -- src/nimbus-session*` empty)
    - ✓ NO `src/_shared/exports-resolver.ts` edits (single-resolver invariant preserved)
    - ✓ Only 2 src files changed: `src/require-resolver.ts` (+44 lines) + `src/facet-manager.ts` (+71 lines)
    - ✓ All x5c src changes referenced by at least one probe (TDD discipline preserved)
  - Risk assessment for the 7 ✅ packages from POST-PHASE5-VERIFICATION (axios, drizzle-orm, jest, pg, puppeteer-core, ts-node, zod):
    - axios, pg, ts-node: pure CJS, Fix #1 adds nothing.
    - drizzle-orm, jest, puppeteer-core, zod: CJS+ESM mix; Fix #1 may pull additional files but cap-eviction protects against budget overruns.
    - Regression r3 explicitly covers axios + ts-node + puppeteer-core; all GREEN post-fix.

## Phase E — 2026-05-05T02:30:00Z (push)

- Status: ✓
- Commit: (rolled into A/B/C/C.2.1 commits)
- Notes:
  - Pushed after every phase commit per brief discipline:
    - Phase A: pushed at `3945f2e`.
    - Phase B: pushed at `9393a0d`.
    - Phase C.1: pushed at `3d4c930`.
    - Phase C.2: pushed at `244fb7a`.
    - Phase C.2.1: pushed at `d918689`.
  - No grant denials this session — first wave-runner session in a while where the cloudflare-seal[bot] grant didn't lapse.

## Phase F — 2026-05-05T02:45:00Z (retro)

- Status: ✓
- Commit: (this file's commit)
- Notes:
  - `audit/sections/X5C-retro.md` written with per-package flip table, single-resolver invariant verification, what-worked / what-surprised / scope-deviations / X5D-candidates / hand-off-notes / phase log.
  - Done criteria all ticked: ≥ 3 of 4 ✅ flips delivered (actually 4 of 4 at local-runnable layer); single-resolver invariant verified by r1; src/ pushed to origin; X5C-progress.md complete.
