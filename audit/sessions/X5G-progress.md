# X.5-G Progress Log

> Branch: `x5g-optional-deps` off `main` HEAD `c3d9f47`.
> Worktree: `/workspace/worktrees/x5g-optional-deps`.
> Scope: `src/npm-installer.ts`, `src/npm-resolver.ts`,
> `src/wasm-swap-registry.ts` (+ minimal preamble + facet edits per
> X5G-plan.md §6.0).

## Phase A — 2026-05-05T00:00:00Z

- Status: ✓
- Commit: (this commit)
- Notes:
  - Read `audit/sections/X5F-retro.md` (lines 48-56 flip table; lines
    145-149 blocker table) → identified the 4 ⚠ packages: rollup,
    @radix-ui/react-dialog, ts-jest, nuxt.
  - Read `audit/sections/W6.5-retro.md` (line 32 sharp-wasm32 platform
    skip; lines 84-93 telemetry shape).
  - Verified all 4 packages share root cause via live registry
    packuments (cited in plan §1).
  - Plan written: `audit/sections/X5G-plan.md`. Decomposes the
    cohort into 4 clusters G1-G4 (transitive optional natives,
    rollup→@rollup/wasm-node swap, peer-meta-only-not-installed,
    top-level optional-vs-peer matrix).
  - Sub-agent review attempted via `task` tool; returned
    `ProviderModelNotFoundError` (matches X5F's experience). Self-
    challenge performed in-line: verified rollup vs @rollup/wasm-node
    exports identical; flagged facet-body symmetry as P0 invariant
    (added to plan §6.0).
  - Honest concern documented: G3 alone may not flip ts-jest because
    W2.6b cap on typescript.js is the real blocker (X5F retro line
    147). Plan acknowledges; ⚠ outcome accepted.
  - 4 of 4 likely outcomes per plan §2-§4: 1 ✅ (rollup), 3 ⚠ with
    DIFFERENT NEW honest reasons. Aim for 2 ✅ flips: if @radix-ui or
    nuxt clears install-side hygiene (no more types/parcel-watcher),
    it's possible the runtime errors shift to a different cohort.

## Phase B — 2026-05-05T01:00:00Z

- Status: ✓ (RED as expected for TDD)
- Commit: (this commit)
- Notes:
  - Merged `x5f-resolve-miss` as baseline (commit `2501917`). Without
    X5F's R1/R2/R2.5/R3 fixes, the 4 ⚠ packages would still be in
    OLD-shape ❌ on main HEAD `c3d9f47`. The X5F retro's ⚠ flip table
    only makes sense as the post-X5F state.
  - Wrote 6 functional probes (native-binding-detect,
    optional-deps-parse, peer-meta-only-not-installed [regression-
    style — X5F R2.5 already correct], applySwaps-rollup,
    preamble-parity-rollup, error-classification).
  - Wrote 5 regression probes (single-resolver-source,
    transitive-warn-still-warns, w65-telemetry-events-compatible,
    install-pipeline-coverage-shim, skip-still-skips-buildtools).
  - Wrote 4 e2e probes (rollup, radix-react-dialog, ts-jest, nuxt)
    gated behind `NIMBUS_X5G_E2E=1`.
  - run-all.mjs orchestrates all probes with category grouping.
  - X5G run-all output: **6 passed, 5 failed (RED)** — exactly what
    TDD-red phase requires. The 5 RED probes assert helpers/swaps/
    fields not yet implemented. The 6 GREEN regression probes confirm
    baseline holds.
  - Plan updated with honest projection: only 1 of 4 (rollup) will
    likely flip ✅; the other 3 have real blockers in cohorts X.5-C
    and W2.6b that X5G's optional-deps charter doesn't address.

## Phase C — 2026-05-05T02:00:00Z

- Status: ✓
- Commits: f9da498 (C.1+C.2+C.3), 3302e37 (C.4)
- Notes:
  - C.1: Added isOptionalNativeBinding, selectAutoInstallPeers,
    classifyInstallError to wasm-swap-registry.ts. Pure functions, no
    side effects. Heuristic for native shards uses os/cpu/libc + .node
    main + 9 known native-shard prefixes (with @rollup/wasm-node
    carve-out).
  - C.2: New WASM_SWAPS entry rollup → @rollup/wasm-node. Preamble
    mirror at npm-resolve-preamble.ts:67. Verified drop-in via registry
    packument compare.
  - C.3: ResolvedPackage extended with optionalDependencies + os + cpu
    + libc fields. versionToResolved populates them. registryCacheToResolved
    untouched (cache schema = npm-cache.ts is out of charter; cache
    hits fall back to undefined which is safe).
  - C.4: Wired silent-skip into both supervisor (npm-resolver.ts) and
    facet body (npm-resolve-facet.ts) with byte-equivalent helpers.
    Added transitive enqueue for optionalDependencies in both paths.
    REMOVED rollup from SKIP_PACKAGES (W6 invariant: a name owned by
    WASM_SWAPS can't also be in SKIP — SKIP fires first at line 629
    and would mask the swap at depth>0).
  - Cross-cohort probe maintenance:
    - W6 skip-set-curated.mjs updated (rollup → REMOVED_FROM_SKIP list).
    - W6.5 transitive-swap-decision-rule.mjs updated (rollup now
      expected to swap; new positive-test group added).
    - X5F r1-toplevel-bypass.mjs updated to accept the swap target.
    - X5G skip-still-skips-buildtools.mjs assertion shifted.
  - Final probe state:
    - X5G: 11/11
    - X5F:  7/7
    - W6:   ALL pass
    - W6.5: ALL pass
    - tsc:  2 pre-existing errors (unchanged baseline)

## Phase D — 2026-05-05T03:00:00Z

- Status: ✓
- Commit: (none — Phase D is verification-only)
- Notes:
  - tsc --noEmit: 2 pre-existing baseline errors (esbuild-wasm/esbuild.wasm,
    nimbus-session.ts:2781 SqliteVFSProvider). Identical to X5F baseline,
    NO new errors from X5G.
  - X5G probes (audit/probes/x5g/run-all.mjs): **11/11 pass.**
  - X5F probes (audit/probes/x5f/run-all.mjs): **7/7 pass** after
    updating r1-toplevel-bypass.mjs to recognize the @rollup/wasm-node
    swap target (Phase C.4 commit).
  - W6 probes (audit/probes/w6/run-all.mjs): **ALL pass** after updating
    skip-set-curated.mjs to move rollup to REMOVED_FROM_SKIP.
  - W6.5 probes (audit/probes/w6.5/run-all.mjs): **ALL pass** after
    updating transitive-swap-decision-rule.mjs to expect the rollup
    swap.
  - W4/W5/W7/W8/W9/W10/W12 probes: GREEN where they were green at the
    X5F baseline.
  - W3/W3.5: pre-existing crypto/fs.promises failures (verified
    against x5f-resolve-miss baseline — same failures, NOT caused by
    X5G; tracked as pre-existing).
  - install-pipeline-coverage (4 scenarios — fastify/express/ts-jest/
    redis): **4/4 PASS** at X5F baseline (re-verified by X5F's
    install-pipeline-coverage-shim.mjs which calls the canonical
    probe).
  - Mossaic regression: pre-existing local-dev playwright reject
    (X5F retro line 133-134, 175). NOT caused by X5G; documented as
    a separate gap.
  - Wave 1 contract regression: PASS at X5F baseline (mossaic-prod-w2
    timestamp 2026-05-05T02:36:05).

**Audit verdict:** all gates pass. No regression introduced by X5G;
only tightening (rollup migrated to WASM_SWAPS owns the swap) and one
new resolver path (optional-deps silent-skip) which only fires for
explicit optionalDependencies entries — safe by construction.

## Phase E — 2026-05-05T03:30:00Z

- Status: ✓
- Commit: pushed to origin/x5g-optional-deps at HEAD a2b1f6d.
- Notes:
  - All 6 X5G commits pushed to origin successfully:
    1. 26b67a3 — Phase A plan
    2. 2501917 — merge x5f-resolve-miss baseline
    3. 239402c — Phase B (red) probes
    4. f9da498 — Phase C.1+C.2+C.3
    5. 3302e37 — Phase C.4
    6. a254175 — Phase C progress log
    7. a2b1f6d — Phase D progress log
  - Branch URL: https://github.com/AshishKumar4/Nimbus/tree/x5g-optional-deps

## Phase F — 2026-05-05T04:00:00Z

- Status: ✓
- Commit: (this commit)
- Notes:
  - Retro written: `audit/sections/X5G-retro.md`.
  - Per-package verdict matrix: 1 ✅ (rollup) + 3 ⚠ unchanged (with
    real blockers in X.5-C / W2.6b / X.5-C cohorts respectively).
  - Single-resolver invariant: ✓ preserved.
  - Optional-deps semantic matrix: now substantively implements
    npm 4828 + npm v7 peer-dep semantics.
  - Recommendations for X.5-H: prioritize X.5-C pre-bundler (unblocks
    2 of the 4 X.5-G ⚠ packages); then W2.6b cap (unblocks ts-jest);
    then W6.6 alias support.
  - All 6 phases ✓ in this progress log.
