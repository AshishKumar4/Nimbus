# d1-fix progress

## Brief
D'.1 cirrus-real-do-facet probe was waved through across 4+
cross-wave runs (prod-bugs-2, cache-and-scrub, two-tier-fanout)
as "pre-existing FAIL — unchanged on main". Root-cause and fix.

## Phases
- [x] Setup worktree (HEAD: e81790b; tsc baseline: 2)
- [x] P1 verbatim D'.1 failure capture (f741c91)
- [x] P2 root-cause via git archaeology (130ec95)
- [x] P3 fix: cirrus-real graceful-degrade + probe accepts both kinds (c0a2b8e)
- [x] P4 cross-wave 29/29 PASS (4ae0f8c)
- [x] P5 retro at audit/sections/D1-FIX-retro.md

## Final state
- D'.1 GREEN: 7/7 assertions, kind='fetcher-fallback' (the prod path)
- Phase 5 regression: 29 PASS, 0 FAIL, 0 SKIP, 0 TIMEOUT (first
  all-PASS run since 2026-05-08 deploy-flag-fix broke D'.1)
- tsc baseline: 2 errors (unchanged from main)
- src/ touch: 1 file (src/facets/cirrus-real.ts) — runtime
  feature-probe with two-path bind
- probe touch: 1 file (audit/probes/d-prime/d1-cirrus-real-facet/
  cirrus-real-do-facet.mjs) — accepts both 'do-facet' and
  'fetcher-fallback' kinds
- No src/ behavior change beyond the minimal D'.1 fix

## Headline finding from P2
Commit 1909718 (deploy-flag-fix in prod-bugs-2 wave) removed
`experimental` from compatibility_flags. That broke
worker.getDurableObjectClass() — an `$experimental` API needed
for the post-D'.1 DO Facet path. The deploy-flag-fix retro
correctly identified that CF rejects `$experimental` on
non-team accounts but didn't audit which features depended on
the flag. cirrus-real.start() then silently set bootError;
/api/_diag/cirrus reported {running:true} only.

The fetcher-fallback added in this wave IS the actual prod
behavior. Local without `$experimental` matches prod exactly.
The DO-Facet variant remains preserved for any future Nimbus
deployment on a CF-team account or after `$experimental`
promotion.

## Why D'.1 slipped 4 prior cross-wave runs
Every prior P6 reported "pre-existing FAIL — confirmed
unchanged on main" without git archaeology. The probe's own
.txt artifact showed PASS at 2026-05-08T22:03:56Z and FAIL by
the next regression run. Diff was visible in git log -p; no
prior wave checked.

## Policy note added in P5 retro
Any "pre-existing FAIL — unchanged" in future cross-wave
reports MUST be challenged in the next wave's P1, not accepted
by precedent. The next wave's P1 must run git log -p on the
probe's .txt artifact and the asserted src files; if a recent
PASS exists, treat the failure as a regression and find the
introducing commit.

## Anti-requirements honored
- NO disabling, skipping, or commenting out the probe.
- NO 'false-positive in local; works in prod' hand-wave: the
  fetcher-fallback IS the prod path.
- NO new src/ behavior beyond the minimal D'.1 fix.
- NO restoring `experimental` to compatibility_flags (that
  would re-trigger CF deploy validator rejection).
- NO setTimeout / sleep / retry / hand-wave skip.
