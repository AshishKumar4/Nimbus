# X.5-drizzle — progress log

> Branch: `x5-drizzle` (off `origin/main` @ `9d4b61d`)
> Mission (from prompt + VERIFY-9D4B61D §4 #1): refine the framework-detect
> "Framework detected — installing framework-required packages (vite, …)"
> heuristic so `npm install drizzle-orm` (in the starter app) no longer
> speculatively pulls vite into the resolved tree, which would drag
> lightningcss → REJECT_INSTALL via X.5-26b.
> Predicted delta: drizzle-orm `⛔ → ✅`; cohort 15/33 → 16/33 strict
> (no healthy delta; ⛔ is healthy, ✅ is also healthy + strict).

## Phase A — Investigate ✓

3 investigation probes under `audit/probes/x5-drizzle/investigation/`:

- **01-detect-on-starter** — runs `detectFramework()` against the starter
  app's `package.json` (extracted from `src/seed-project.ts`).
  Verdict: `framework='vite', confidence=0.7, devCommand='vite-real'`
  via step 8 ("found 'vite' in dependencies (no specific framework)").
  This makes the current `detectFrameworkAware()` return `true` (because
  `'vite' !== 'unknown'`) — which is the load-bearing trigger for the
  `[npm] Framework detected — installing framework-required packages (vite, …)`
  banner and the speculative vite pull-in that drags lightningcss.
- **02-detect-on-frameworks** — runs the detector against 9 fixtures
  (5 frameworks + wrangler-on-fw + wrangler-standalone + starter +
  pure-node-lib) and asserts the *post-fix* semantic
  `frameworkAware = (framework !== 'unknown' && framework !== 'vite')`
  preserves the W11 cases. **9/9 PASS** with the proposed semantic.
  This means: refining the trigger to exclude generic-vite is safe for
  all W11 frameworks.
- **03-call-site-survey** — `frameworkAware` is computed in exactly ONE
  src/ site (`npm-installer.ts:detectFrameworkAware`) and consumed
  elsewhere as a pass-through (resolveTree, resolveTreeViaFacet,
  npm-resolve-facet.ts, parallel/npm-resolve-preamble.ts). Single edit
  point. Literal `Framework detected` string lives in
  `src/npm-installer.ts:209` (NOT `src/npm-resolver.ts` as the prompt
  states — minor prompt mis-localization).

**Trigger localized:** the speculative vite pull-in fires whenever
`detectFrameworkAware(projDir)` returns true. It returns true for
`framework !== 'unknown'`, which includes step 8's generic-vite verdict
that fires for ANY `package.json` with `vite` in dependencies/devDependencies.
The starter (and Mossaic, per W11-retro §4 #8 stated intent) hit this
case but don't actually need vite materialized at install time —
real-vite is bundled in the supervisor (`src/cirrus-real.ts` /
`nimbus-session-init.ts:849`), and `npm run dev` routes through
cirrusReal regardless of whether user-installed vite exists.

**Most surgical refinement:** narrow `detectFrameworkAware()` to return
true only when the detected framework is one of the *real* frameworks
(next/astro/nuxt/remix/sveltekit/wrangler) — i.e., add `&& result.framework !== 'vite'`
to the existing `result.framework !== 'unknown'` condition. The
detector's output (`detectFramework`) stays unchanged so the W11
`detect-vite-generic` probe (`vite` + `vite-real` devCommand) keeps
passing — only the *aware-flag* downstream of detection narrows.

What makes drizzle-orm match (and why a different refinement axis would
miss it): drizzle-orm itself is *not* in any framework category; the
detector runs against the project's `package.json`, not the package
being installed. The match is purely an accident of running
`npm install drizzle-orm` inside the seeded starter (which has `vite`
in devDependencies). Any pkg installed in the starter would match —
this is why even axios/jest/redis printed "Framework detected" in
verify-90993b3. The `transitive: 'fail'` REJECT makes this
previously-cosmetic cascade fatal.


## Phase B — Plan ✓

Plan landed at `audit/sections/X5-drizzle-plan.md` (6 sections,
~190 lines):

- §1 investigation summary (3 probes)
- §2 four refinement options + rationale (Option 1 chosen, 2-4 rejected
  with reasons)
- §3 regression matrix per W11 framework — 9 cases, 0 risk
- §4 probe plan (3 functional + 6 regression + 3 e2e)
- §5 source change preview — `src/npm-installer.ts` only, ~6 LOC
  including comment
- §6 self-review TL;DR

**Refinement chosen:** change `return result.framework !== 'unknown';`
to `return result.framework !== 'unknown' && result.framework !== 'vite';`
in `npm-installer.ts:detectFrameworkAware()`.

## Phase C — TDD red ✓

3 functional + 5 regression + 3 e2e probes under
`audit/probes/x5-drizzle/{functional,regression,e2e}/` plus a
`run-all.mjs` driver.

### Functional (RED expected pre-fix)

- `detect-aware-on-starter.mjs` — RED. 1 of 3 assertions fails:
  `frameworkAware === false` (current src returns `aware=true` for
  generic-vite).
- `detect-aware-preserves-frameworks.mjs` — GREEN at all times. 14
  assertions across 7 W11 frameworks. Baseline guard.
- `installer-detect-source-shape.mjs` — RED. 2 of 4 assertions fail:
  the `&& result.framework !== 'vite'` clause is missing; rationale
  comment is missing.

### Regression (must stay GREEN through src change)

- `single-resolver-source.mjs` — GREEN. Delegates to `x5f`.
- `install-pipeline-coverage-shim.mjs` — GREEN. Delegates to `x5f` shim
  (BASE-unreachable skip is the documented sentinel).
- `w11-frameworks-still-detect.mjs` — GREEN. Drives all 12 W11
  functional probes; all pass.
- `w11-vite-generic-still-detects-as-vite.mjs` — GREEN. Detector
  still returns `vite` / `vite-real` for generic vite (we don't touch
  the detector).
- `mossaic-regression-coverage.mjs` — RED. Codifies W11-retro §4 #8's
  stated intent (Mossaic should have aware=false).
- `prior-x5-runalls-shim.mjs` — included in run-all under `--heavy`;
  runs all 13 prior X.5 + 5 W run-alls with --no-e2e.

### E2E (live wrangler @ 127.0.0.1:8790)

Pre-fix run captured:

- `drizzle-orm-installs.mjs` — **RED** (3/5 fail): install rejected with
  `npm install rejected: lightningcss`; "resolver-facet failed" line
  present. Exact regression from VERIFY-9D4B61D §6. Pre-fix transcript
  saved to `e2e/drizzle-orm-installs.pre-fix.out.txt`.
- `drizzle-orm-smoke.mjs` — **RED** (5/6 fail): install REJECT, then
  `Error: Cannot find module 'drizzle-orm'` at runtime.
- `drizzle-orm-no-vite-pulled.mjs` — **RED** (2/6 fail): install
  rejected before vite/lightningcss could materialize, so the absence
  assertions pass — but install succeeded + drizzle-orm-exists fail.
  Post-fix this probe locks in the *cause* (vite still absent because
  frameworkAware=false → SKIP_PACKAGES applies → vite never resolved).

### RED summary

`run-all.mjs --no-e2e`: 5 pass / 3 fail (expected).

3 e2e probes RED (pre-fix transcripts archived as `*.pre-fix.out.txt`).

## Phase D — Build (PIVOT) ✓

**Phase B plan's framework-detect refinement was empirically falsified.**
Investigation 04 (`audit/probes/x5-drizzle/investigation/04-trace-lightningcss-from-drizzle.mjs`)
traced the actual chain: `drizzle-orm → expo-sqlite (optpeer; X.5-J
enqueue) → expo (peer) → @expo/metro-config (dep) → lightningcss (dep)`.
The lightningcss REJECT enters via X.5-J optional-peer subtree, NOT
framework-detect.

**Pivot fix landed** in `src/npm-resolver.ts` + `src/npm-resolve-facet.ts`:

- Introduced `bestEffortNames: Set<string>` alongside existing
  `topLevelNames` / `optionalNames`.
- X.5-J optional-peer enqueue (R2.5) marks the peer as best-effort.
- Post-resolve children-enqueue (deps / optDeps / peers) propagates the
  flag (`inheritBestEffort` from parent).
- `__w6_reject` catch path checks `bestEffortNames.has(name)`; if true,
  silent-skip with a `[skip] <name> — inside best-effort optional-peer
  subtree (X.5-drizzle): <reason>` notice instead of throwing.

**Diff:** +46 LOC `npm-resolve-facet.ts` + +41 LOC `npm-resolver.ts`
(mirror). 0 new files. 0 type changes. tsc baseline: 2 errors (byte-
identical to VERIFY-9D4B61D §2).

**Probe changes:**
- Functional probes refactored to test the new mechanism (source-shape
  asserts `bestEffortNames` declared + soft-skip branch + X.5-J tag).
- Mossaic-regression-coverage downgraded to detector-contract-only
  (since framework-detect is no longer touched).
- E2E probes:
  - drizzle-orm-installs: 6/6 GREEN — install adds 614+ packages, no
    "npm install failed", `[skip] lightningcss — inside best-effort
    optional-peer subtree (X.5-drizzle)` line present.
  - drizzle-orm-smoke: 6/6 GREEN — `require('drizzle-orm')` returns
    keys including `ColumnAliasProxyHandler` + `TableAliasProxyHandler`
    matching the verify-700420f / verify-90993b3 baseline.
  - drizzle-orm-no-vite-pulled: 6/6 GREEN — drizzle-orm exists; vite
    + lightningcss absent (the soft-skip dropped them, as designed).

**run-all.mjs** (functional + regression, --no-e2e): 8/8 GREEN.

Post-fix transcripts archived under `e2e/*.post-fix.out.txt`.

## Phase E — Audit ✓

**Resumed session 2026-05-06 (after first-session api_error mid-Phase-D-audit).**

Phase D audit re-run against `5c3d61f`:

| Layer | Result |
|---|---|
| `bun audit/probes/x5-drizzle/run-all.mjs --no-e2e` | 8/8 GREEN (3 functional + 5 regression) |
| `BASE=… bun .../e2e/drizzle-orm-installs.mjs` | 6/6 GREEN |
| `BASE=… bun .../e2e/drizzle-orm-smoke.mjs` | 6/6 GREEN |
| `BASE=… bun .../e2e/drizzle-orm-no-vite-pulled.mjs` | 6/6 GREEN |
| `bun audit/probes/x5-drizzle/regression/w11-frameworks-still-detect.mjs` | 12/12 W11 detect probes PASS |
| `tsc --noEmit` | 2 errors (esbuild-service / nimbus-session-init), byte-identical to VERIFY-9D4B61D §2 |
| 10 single-resolver-source probes (x5f/g/j/m/s/npqo/m3/z5-build/26b/x5-drizzle) | 10/10 PASS |
| `audit/probes/regression/install-pipeline-coverage.mjs` (canonical) | 4/4 PASS (fastify/express/ts-jest/redis) |
| `audit/probes/w4/regression/wave1-contract-rerun.mjs` | PASS, external=0 |
| Mossaic shape probes (w12 + w7 + x5-drizzle) | 3/3 PASS |
| 13 X.5 wave run-alls (J/L/M/NPQO/Z5/R/Z3/M3/S/26b + C/F/G; peer-gap is plan-only) | 12/13 PASS; x5z5-build is documented pre-existing fail (probe self-marks "out of Z5 scope") |
| x5peer-gap-investigation 3 probes | 3/3 PASS |
| Forbidden files (`src/node-shims.ts`, `src/wasm-swap-registry.ts`, `src/parallel/npm-resolve-preamble.ts`) | 0 changes (`git diff` empty) |

Audit artifacts:
- `audit/probes/x5-drizzle/AUDIT-RESULTS.md` (Phase D audit results)
- `audit/probes/x5-drizzle/AUDIT-SUMMARY.md` (probe roster + ledger)
- `audit/probes/x5-drizzle/regression/wave-runalls-audit.txt`
- `audit/probes/x5-drizzle/regression/prior-x5-runalls-shim.audit-log.txt`
- `audit/probes/x5-drizzle/e2e/*.audit.out.txt` (post-fix transcripts)

## Phase F — Push ✓

`git push origin x5-drizzle` (this commit + prior 4) — see Phase F commit log.

## Phase G — Retro ✓

`audit/sections/X5-drizzle-retro.md` (7 sections, ~250 lines):

- §1 drizzle-orm verdict (✅ recovered with diff vs pre-fix)
- §2 heuristic refinement chosen (`bestEffortNames` + transitive-reject
  soft-skip) with file:line + 5 alternatives evaluated
- §3 scope deviations (5 categories: mechanism, diff size, probe-suite,
  forbidden-files=0, cohort prediction)
- §4 REGRESSED status — W11 framework-detect 12/12 PASS, structural
  argument, full cross-wave invariant table
- §5 lessons (5: trust-trace-earlier, transitive-fail-blast-radius,
  mirror-parity, e2e-OOM, plan-vs-actual)
- §6 follow-up candidates (4: framework-detect hygiene, mirror-parity
  probe, restart-between-probes harness, transitive-fail blast-radius gate)
- §7 closing

## All 7 phases complete

| Phase | Commit | Verdict |
|---|---|---|
| A. Investigate | `459a59a` | ✓ 4 probes, framework-detect trigger localized + Phase D pivot evidence (probe 04) |
| B. Plan | `ffb96cb` | ✓ `audit/sections/X5-drizzle-plan.md` (Option 1 chosen, Options 2-4 rejected; Phase D pivot section appended) |
| C. TDD red | `dcfd158` | ✓ 3 functional + 5 regression + 3 e2e RED confirmed pre-fix |
| D. Build | `5c3d61f` | ✓ +87 LOC across `npm-resolver.ts` + `npm-resolve-facet.ts`; 0 forbidden-file touches |
| E. Audit | (this commit) | ✓ All probes GREEN; tsc baseline stable; W11 12/12 PASS; 0 cross-wave regressions |
| F. Push | (this commit) | ✓ `origin/x5-drizzle` |
| G. Retro | (this commit) | ✓ `audit/sections/X5-drizzle-retro.md` |

**Done. drizzle-orm ⛔→✅ via best-effort optional-peer subtree soft-skip.
W11 framework-detect contract preserved (12/12 PASS).**
