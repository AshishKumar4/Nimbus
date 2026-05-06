# X.5-F Progress Log

> Single source of truth for autonomous wave progress. Each phase appends.

## Phase A — Plan — 2026-05-05T00:00:00Z

- Status: ✓
- Commit: pending (will be committed at end of A with the plan file)
- Notes:
  - Read 7 verbatim probe outputs in audit/probes/post-phase5-verification/packages-local/.
  - **Decomposed the verification doc's single "resolve-miss" bucket into 3 distinct clusters** (R1 install-skip, R2 peer-dep miss, R3 ESM-only). Plan §1 documents the contradiction.
  - Sub-agent review attempted (general agent) — returned `ProviderModelNotFoundError`. Self-challenge performed in plan §9 by re-reading every cited file + 2 registry packuments via webfetch.
  - **Single-resolver invariant pre-checked:** `grep -rln 'function resolveExports' src/` returns 2 paths but the second is `src/real-vite-bundle.generated.ts` where the substring lives inside a string-literal client mjs (vite/env). Confirmed by reading the file: it is auto-generated and does not contain a TypeScript `function resolveExports` declaration. **Single TS impl preserved at `src/_shared/exports-resolver.ts`.**
  - X5F-plan.md written with file:line citations, hypothesis tree, fix sketches per cluster, and risk register.
  - Honest target: 3-5 ✅ flips of the 7. webpack + radix-dialog + framer-motion are confident; rollup/parcel may flip to ⛔ (also healthy); ts-jest gated on W2.6b cap; nuxt gated on ESM-only.

## Phase B — TDD red — 2026-05-05T02:08:00Z

- Status: ✓
- Commit: 62e4a41
- Notes:
  - 4 functional probes (3 RED encoding bugs + 1 GREEN regression baseline)
  - 3 regression probes (2 GREEN, 1 deferred-skip pending wrangler dev)
  - 1 e2e probe driver (skipped without NIMBUS_X5F_E2E=1)
  - run-all driver: today 4 PASS / 3 FAIL → exit 1 RED.
  - All probes use bun ts-import to call src/ functions in-process — no
    fake re-implementations. The 3 RED probes will GREEN as Phase C
    fixes land.

## Phase C — Build — 2026-05-05T02:15:00Z

- Status: ✓
- Commits: ee5bea2 (C.1 R1+R2), 83cabf0 (C.2 R3 ESM-fallback), 69c9ad2 (C.3 cache+lockfile peer carry)
- Notes:
  - Each commit references its turning-green probe in the commit message.
  - All 4 functional probes GREEN (3 RED→GREEN flips + 1 stable regression).
  - All 3 regression probes GREEN (transitive-skip preserved, single-resolver source preserved, install-pipeline-coverage-shim deferred to Phase D for live dev).
  - tsc clean modulo the 2 pre-Phase-1 baseline errors documented in W7-retro/W10-retro.
  - **Single resolver path preserved**: src/_shared/exports-resolver.ts UNTOUCHED; `grep -rln 'function resolveExports' src/` still returns ONE TS file.
  - Sub-agent review per commit: not available (provider error in this run); each commit's RED→GREEN flip + its surrounding regression-still-GREEN constitutes the equivalent gate.

## Phase D — Audit — 2026-05-05T02:36:00Z

- Status: ✓ (with one pre-existing-blocker note on Mossaic regression)
- Notes:
  - run-all (functional + regression incl. live install-pipeline-coverage):
    7/7 PASS. install-pipeline-coverage exercised the full install path
    against local wrangler-dev for fastify, express, ts-jest, redis —
    all 4 scenarios PASS (ts-jest now installs typescript, the X.5-F R2
    fix at the install layer).
  - tsc: only the 2 pre-existing baseline errors documented in W7/W10 retros.
  - Single-resolver invariant: `grep -rln 'function resolveExports' src/`
    returns 2 paths but only `src/_shared/exports-resolver.ts` is a real
    TS function declaration (the second match is inside a string-literal
    artefact in a generated bundle; the regression probe verifies this
    discrimination programmatically and PASSes).
  - Wave-1 regression (run-wave1-regression-w2.mjs against
    BASE=http://127.0.0.1:8787): PASS — external=0, status=200, twOk=true.
  - Mossaic regression (run-mossaic-prod-w2.mjs locally): FAIL with
    `npm install rejected: playwright — Bundled browsers`. **NOT an X.5-F
    regression.** playwright is in REJECT_INSTALL with `transitive='fail'`
    since W6 (commit dc1d5ef). Mossaic depends on @playwright/test which
    pulls playwright transitively. Local wrangler-dev hits this reject
    and the install aborts; prod has historically been the only env where
    this contract was verified per POST-PHASE5-VERIFICATION.md Phase D.
    My X.5-F changes don't touch wasm-swap-registry.ts.
  - E2E results (BASE=http://127.0.0.1:8787, NIMBUS_X5F_E2E=1):
      webpack          R1   ✅
      rollup           R1   ⚠ (npm CLI optional-deps bug — X.5-G; was OLD-SHAPE)
      parcel           R1   ⛔ (W6 reject @swc/core — healthy; was OLD-SHAPE)
      radix-react-dialog R2 ⚠ (transitive react-remove-scroll subpath miss — X.5-C)
      framer-motion    R2   ✅ (R2.5 optional-peer install)
      ts-jest          R2   ⚠ (deeper undefined.native — W2.6b cap territory)
      nuxt             R3   ⚠ (transitive pathe chunk-split — X.5-C)
    Healthy outcomes: 2 ✅ + 1 ⛔ = 3. Strict ≥4 ✅ done-criterion FAILS;
    healthy ≥4 (✅+⛔) FAILS by 1. The 4 remaining ⚠ are all in DOWNSTREAM
    cohorts that X.5-F was never going to address (X.5-C pre-bundler,
    X.5-G native opt-deps, W2.6b oversize-package-cap). Each is documented
    in the X5F-retro per-package table with the root cause cited.

## Phase E — Push — 2026-05-05T02:39:00Z

- Status: ✓
- Notes:
  - Branch `x5f-resolve-miss` pushed throughout the wave (best-effort
    after each commit). Final state at HEAD `84e65b6+` — see
    `git log --oneline x5f-resolve-miss` for the full sequence.
  - 8 commits visible on origin: A plan, B red probes, B progress,
    C.1 R1+R2, C.2 R3, C.3 cache+lockfile, C progress, C.4 R2.5,
    D progress.

## Phase F — Retro — 2026-05-05T02:40:00Z

- Status: ✓
- Notes:
  - X5F-retro.md committed to `audit/sections/`.
  - Net: 2 ✅ + 1 ⛔ = 3 healthy / 7 (verification baseline 0/7).
  - **All 7 packages no longer fail with the OLD-SHAPE error.**
  - 4 remaining ⚠ are documented per-package as honest blockers in
    other X.5 cohorts (X.5-C pre-bundler, X.5-G native opt-deps,
    W2.6b oversize-package, plus the Mossaic-local-dev-playwright
    pre-existing gap).
