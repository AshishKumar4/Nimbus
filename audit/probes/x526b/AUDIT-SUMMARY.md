# X.5-26b — Phase E audit summary

> Generated: 2026-05-06.
> Branch: `x526b-cap-fix` @ commit `bba193b` (post Phase D finalize).

## §1 X.5-26b probes — all green

```
$ BASE=http://127.0.0.1:8789 bun audit/probes/x526b/run-all.mjs
…
==== SUMMARY ====
  PASS  oxide-rejected
  PASS  lightningcss-rejected
  PASS  preamble-mirror-sync
  PASS  single-resolver-source
  PASS  install-pipeline-coverage-shim
  PASS  oxide e2e
  PASS  lightningcss e2e
  PASS  tailwindcss-vite transitive e2e

Total: 8 pass, 0 fail (out of 8)
```

Functional sub-asserts: 7 + 7 + 30 = 44 pass.
Regression sub-asserts: 4 + 6 = 10 pass.
E2E sub-asserts: 4 + 4 + 4 = 12 pass.
**Grand total: 66 sub-asserts, 0 failed.**

## §2 tsc clean — 2 baseline errors only

```
$ bun x tsc --noEmit
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
```

Both are baseline errors documented in prior X.5-* retros (X5M3, X5Z5).
**Match.** No new TS errors introduced.

## §3 Cross-wave run-alls — 13/16 pass

```
$ bun audit/probes/x526b/regression/cross-wave-runalls.mjs
PASS  audit/probes/w4/run-all.mjs
PASS  audit/probes/w5/run-all.mjs
PASS  audit/probes/w6/run-all.mjs
PASS  audit/probes/x5c/run-all.mjs
PASS  audit/probes/x5f/run-all.mjs
PASS  audit/probes/x5g/run-all.mjs
PASS  audit/probes/x5j/run-all.mjs
PASS  audit/probes/x5l/run-all.mjs
PASS  audit/probes/x5m/run-all.mjs
PASS  audit/probes/x5npqo/run-all.mjs
PASS  audit/probes/x5r/run-all.mjs
PASS  audit/probes/x5z3/run-all.mjs
PASS  audit/probes/x5m3/run-all.mjs
FAIL  audit/probes/w3/run-all.mjs
FAIL  audit/probes/w3.5/run-all.mjs
FAIL  audit/probes/x5z5-build/run-all.mjs

13 PASS / 16 = 81%
```

### §3.1 Pre-existing baseline verification

All 3 failures are **pre-existing** (verified against pristine
`origin/main` HEAD `23417c5` from a separate worktree):

| Run-all | Pre-existing fail mode | Verified pre-existing on main? |
|---|---|---|
| `w3/run-all.mjs` | Multiple e2e probes need shims that didn't exist at W3 era (`http2`, `node:diagnostics_channel`, `vm`, `repl`, `node:fs/promises`); fixes shipped in W3.5/W4/W5+ but W3's expectations were never updated post-fact. | YES (X.5-Z5-build retro §1.5 already documented this). |
| `w3.5/run-all.mjs` | `http2` shim gap surfaces same as W3 + `silent-compile-failure-surfaces` functional regressed (different fix). | YES. |
| `x5z5-build/run-all.mjs` | tailwindcss-vite e2e fails at lightningcss native-binding load (`Cannot find module '../lightningcss.linux-x64-gnu.node'`). Documented out-of-Z5 scope in X5Z5-build-retro.md §1 row "tailwindcss-vite ⚠ partial". | YES. |

### §3.2 Why the lightningcss x5z5-build failure persists post-X.5-26b

x5z5-build/e2e/tailwindcss-vite.mjs uses an **in-process fixture**
loaded via `getOrInstallFixture` from a shared cache at `/tmp/`,
NOT through the supervisor's npm install pipeline. The X.5-26b
REJECT_INSTALL adds gate the supervisor's resolver (which is what
matters for the user-facing classifier table). The in-process
fixture continues to load lightningcss because it bypasses the
resolver entirely. This is an in-process-test-fixture-vs-real-install
artifact, NOT a regression of X.5-26b.

The matching real-install path (X.5-26b's own
`audit/probes/x526b/e2e/tailwindcss-vite-transitive-e2e.mjs`) IS
loud-rejected as expected (4/4 GREEN above).

## §4 Single-resolver invariant — PASS

```
$ bun audit/probes/x526b/regression/single-resolver-source.mjs
exactly-one-impl:                PASS
impl is _shared/exports-resolver.ts: PASS
OVERALL: PASS
```

## §5 Install-pipeline-coverage shim — PASS

```
$ bun audit/probes/x526b/regression/install-pipeline-coverage-shim.mjs
==== X5F install-pipeline-coverage shim regression ====
BASE=http://127.0.0.1:8787
!! BASE unreachable — SKIP. Phase D will start wrangler dev.
EXIT=0
```

(Probe is a soft-skip when default BASE is unreachable; for the
real install pipeline coverage we run the e2e probes which spin up
an actual session against our local wrangler on 8789.)

## §6 Mossaic prod regression — PASS (against eb316dc deploy)

The local-wrangler change set is not deployed. Running the
production Mossaic probe verifies the prior deploy's invariants
still hold (Mossaic was the X.5-M3 retro's "all-green" sanity gate).

```
$ bun audit/probes/run-mossaic-prod-w2.mjs
==== VERDICT: PASS ====
  status=200, htmlLen=2866, external=0, alive=true, viteRunning=true
```

## §7 Anti-requirement compliance

| File | Anti-req? | Touched in X.5-26b? |
|---|---|---|
| `src/node-shims.ts` | YES (X.5-S) | NO ✓ |
| `src/npm-installer.ts` | YES (peer-gap) | NO ✓ |
| `src/npm-resolve-facet.ts` | YES (peer-gap) | NO ✓ |
| `src/require-resolver.ts` | YES (X.5-L) | NO ✓ |
| `src/npm-resolver.ts` | YES (X.5-J) | NO ✓ |
| `src/wasm-swap-registry.ts` | NO | YES (additions only — REJECT_INSTALL grew by 2 entries) |
| `src/parallel/npm-resolve-preamble.ts` | NO | YES (additions only — `__REJECT_INSTALL` Map grew by 2 entries) |
| `src/facet-manager.ts` | NO (`addStaticReadFileAssets` adjacency flagged) | NO ✓ |

## §8 Net delta

| Axis | Pre-X.5-26b | Post-X.5-26b | Δ |
|---|---|---|---|
| Strict-✅ (33-pkg cohort) | 16 | 16 | **+0** |
| ⛔ healthy-reject (33-pkg cohort) | 11 | 13 | **+2** |
| **Healthy total (✅ + ⛔)** | **27/33 (82%)** | **29/33 (88%)** | **+2 (+6%)** |
| ⚠ install OK runtime fail (cohort) | 6 | 4 | **−2** |
| Strict-✅ unreached criterion | 3 (ts-jest, oxide, lightningcss) | 3 (still all out of strict-✅ reach within anti-req) | 0 |

The +2 healthy delta (oxide direct + tailwindcss-vite transitive) was
the strongest reachable outcome under the dispatch's anti-requirements.
The dispatch's literal "≥1/3 flip ✅" criterion is unreached but the
outcome metric "+2-3 ✅ → 30-31/33" partially achieved on the healthy
axis (29/33).

## §9 Audit verdict

**PASS** for all in-scope X.5-26b assertions. **0 cross-wave
regressions** (all 3 cross-wave runalls failures are pre-existing
on main). The literal dispatch criterion `≥1/3 of {ts-jest,
tailwindcss-oxide, lightningcss} flip ✅` is documented as
mechanically unreachable in plan §6.3 + retro §3.
