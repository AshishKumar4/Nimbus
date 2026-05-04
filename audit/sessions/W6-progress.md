# W6 — Progress Log

Branch: `w6-wasm-swap` off `main` @ b266d1d.
Session: autonomous Seal session, started 2026-05-04.

## Phase A — 2026-05-04 (Plan)

- Status: ✓
- Commit: afa548b
- Plan v1 written, sub-agent reviewed (verdict REVISE — four must-fix
  defects: missing facet-resolver path, SKIP_PACKAGES masking,
  bcrypt require-name break, esbuild-wasm parity unverified).
- Plan v2 incorporates all four must-fix + high-value should-fixes
  (per-entry transitive policy, expanded reject taxonomy, two-column
  reject formatter, preserve user package.json on swap,
  three-resolver-path enumeration).
- Notes: `audit/probes/wasm/_SUMMARY.json` is misleading —
  `ok:true` reflects install success, not load success. Per-package
  import results live in the per-probe `.out.txt`. Reflected in plan §6.
- Pushed to origin/w6-wasm-swap.

## Phase B — 2026-05-04 (TDD red)

- Status: ✓
- Probes added (all 17 expected; one prod-gated SKIPs by default):
  - functional/{registry-shape, lookup, apply-swaps, find-rejects,
    format-messages, no-conflict-with-skip, preamble-parity}
  - regression/{install-pipeline-coverage-meta, skip-set-curated,
    builds-specs-passthrough, resolver-paths-symmetric}
  - e2e/{build-specs-integration, transitive-warn-not-throw,
    lockfile-replay-with-swap, swap-target-symbol-parity,
    swap-preserves-package-json, registry-coverage}
- Suite runs RED as expected. install-pipeline-coverage-meta passes
  (independent of the registry). registry-coverage SKIPs (prod-gated).
  All 15 others fail because src/wasm-swap-registry.ts doesn't exist.
- Notes: probe layout mirrors w5 (TAP-style, child-bun-process per
  probe, run-all orchestrator). Probes are deliberately pure-logic
  where possible — only registry-coverage is network-dependent.

## Phase C — 2026-05-04 (Build)

- Status: ✓
- Commits:
  - dc1d5ef src/wasm-swap-registry.ts (greens 12 probes)
  - b21ce7a SKIP_PACKAGES migration (greens 4 more — all 17 green)
  - ea6e869 wire installer/resolver/facet/package.json + review fixes
- Sub-agent diff review (post-wiring): APPROVE-WITH-FIXES.
  - MUST-FIX #2: replaced brittle string-prefix matching across the
    supervisor↔facet boundary with own-property tag (__w6_reject).
    Added RegistryRejectError class + isRegistryReject helper.
  - LOW #11: removed inconsistent try/catch around onProgress.
  - LOW #14: added module-init assertion (WASM_SWAPS ∩ REJECT_INSTALL
    must be empty).
  - LOW #3: preamble-parity probe extended to verify every SHOULD_*
    identifier in npm-resolve-facet.ts is declared as a function in
    the preamble (catches typos at CI rather than facet runtime).
- All 17 W6 probes green; W5 probes still green; tsc baseline
  unchanged (2 pre-existing errors on main, none introduced by W6).

## Phase D — 2026-05-04 (Audit)

- Status: ✓
- W6 suite: 17/17 green (16 OK + 1 prod-gated SKIP).
- W5 suite: 7/7 green (no regressions).
- W4 suite: 6/6 green non-prod-mode (5 SKIP requires --full / prod auth).
- W3 suite: prod-only (BASE=…workers.dev), out of scope for local audit.
- Mossaic install-pipeline-coverage gate: META-probe asserts file
  integrity green. Full-fat prod run pending wrangler auth (mirrors
  W3/W4/W5 prod-deploy queue documented in MASTER-ROADMAP.md §"Pending
  Prod Deploys").
- tsc baseline: 2 pre-existing errors on main (esbuild-service.ts
  TS2307 + nimbus-session.ts TS2345). Confirmed identical on main
  prior to W6 — W6 introduces zero new errors.
- No commit needed for Phase D (it's a verification phase).

## Phase E — 2026-05-04 (Push)

- Status: ✓
- All commits pushed to origin/w6-wasm-swap.

## Phase F — 2026-05-04 (Retro)

- Status: ✓
- `audit/sections/W6-retro.md` written with: outcome vs predicted,
  per-package verdict matrix (1 swap + 24 rejects in 7 buckets),
  surprises (3 resolver paths, SKIP_PACKAGES masking, bcryptjs
  require-name issue, brittle string-prefix matching, misleading
  _SUMMARY.json), W6.5 candidates (npm-alias parser, WASM extraction
  filter, VFS pre-bundle wiring, esbuild path-redirect shim, ANSI in
  Error.message), per-commit summary, pending-prod-deploy procedure,
  honest negatives.

## Done

All 6 phases ✓. All done criteria met. Branch pushed at eec0f15.

W6 outcome: WASM swap registry + REJECT_INSTALL UX shipped as
`src/wasm-swap-registry.ts` (377 LOC) wired into both resolver paths
(legacy + facet), `buildSpecs`, and `updatePackageJson`. 1 swap
(esbuild → esbuild-wasm), 24 rejects in 7 buckets. Per-entry
transitive policy ('fail' vs 'warn') for fsevents-style optional
natives. Own-property error tagging across the supervisor↔facet
boundary. Module-init disjoint-set assertion. All 17 W6 probes green;
W4 and W5 regression suites green; tsc baseline unchanged.
