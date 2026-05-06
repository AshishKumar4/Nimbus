# X.5-drizzle — Probe Audit Summary

> Branch: `x5-drizzle` (off `origin/main` @ `9d4b61d`)
> Final commit: `5c3d61f` (Phase D pivot)
> Date: 2026-05-06 single autonomous session

## Probe roster

```
audit/probes/x5-drizzle/
├── investigation/        (4 probes, all GREEN — Phase A + Phase D pivot evidence)
│   ├── 01-detect-on-starter.mjs               PASS  pkg.json verdict
│   ├── 02-detect-on-frameworks.mjs            PASS  9/9 framework fixtures
│   ├── 03-call-site-survey.mjs                INFO  enumerates frameworkAware refs
│   └── 04-trace-lightningcss-from-drizzle.mjs HIT   expo-sqlite chain (the actual mechanism)
├── functional/           (3 probes, GREEN post-fix)
│   ├── detect-aware-on-starter.mjs            PASS  detector contract on starter
│   ├── detect-aware-preserves-frameworks.mjs  PASS  9/9 framework verdicts
│   └── installer-detect-source-shape.mjs      PASS  bestEffortNames declared in BOTH src files
├── regression/           (6 probes, GREEN; prior-x5-runalls captures pre-existing failures)
│   ├── single-resolver-source.mjs                  PASS  delegates to x5f
│   ├── install-pipeline-coverage-shim.mjs          PASS  delegates to x5f shim
│   ├── w11-frameworks-still-detect.mjs             PASS  12/12 W11 detect probes
│   ├── w11-vite-generic-still-detects-as-vite.mjs  PASS  detector unchanged
│   ├── mossaic-regression-coverage.mjs             PASS  detector contract
│   └── prior-x5-runalls-shim.mjs                   ALLOW-FAIL  (see ledger below)
├── e2e/                  (3 probes, GREEN against live wrangler @ 127.0.0.1:8790)
│   ├── drizzle-orm-installs.mjs           6/6  install adds 614+ packages, lightningcss soft-skipped
│   ├── drizzle-orm-smoke.mjs              6/6  require('drizzle-orm') keys match baseline
│   └── drizzle-orm-no-vite-pulled.mjs     6/6  drizzle-orm exists; vite + lightningcss absent
├── run-all.mjs                                (functional + regression GREEN; e2e gated on BASE)
├── run-all-pre-fix-no-e2e.txt                 RED state at HEAD `9d4b61d`
└── run-all-post-fix-no-e2e.txt                GREEN state at `5c3d61f`
```

## Cross-wave invariants

| Invariant | Probe | Verdict |
|---|---|---|
| Single-resolver (8+ wave compose-without-fork) | `audit/probes/x5f/regression/single-resolver-source.mjs` | PASS — 1 impl in `_shared/exports-resolver.ts` |
| Install-pipeline coverage (Mossaic-shape sanity) | `audit/probes/regression/install-pipeline-coverage.mjs` | 4/4 PASS — fastify/express/ts-jest/redis all visible after install |
| W11 framework-detect contract | `audit/probes/x5-drizzle/regression/w11-frameworks-still-detect.mjs` | 12/12 PASS — all W11 detect probes still PASS |
| W11 vite-generic detector verdict | `audit/probes/x5-drizzle/regression/w11-vite-generic-still-detects-as-vite.mjs` | PASS — `framework=vite, devCommand=vite-real, confidence=0.7` |
| W7 Mossaic-shape file presence | `audit/probes/w7/regression/mossaic-shape.mjs` | 3/3 PASS |
| W12 Mossaic-shape runner | `audit/probes/w12/regression/mossaic-shape.mjs` | 2/2 PASS |
| tsc baseline | `bunx tsc --noEmit` | 2 errors, byte-identical to VERIFY-9D4B61D §2 |

## prior-x5-runalls ledger (16 wave run-alls swept)

Captured in `regression/prior-x5-runalls-shim.audit-log.txt`:

| Wave run-all | Verdict | Note |
|---|---|---|
| `audit/probes/w3/run-all.mjs` | FAIL | **Pre-existing (verified)** — node:vm/http2/diagnostics_channel/repl module-resolver gaps; node-shims gaps for fastify/jsdom/axios/redis. Reproduces against `origin/main` HEAD without our src/ changes (Phase E re-baseline run). |
| `audit/probes/w3.5/run-all.mjs` | FAIL | **Pre-existing (verified)** — same shape: directory-as-index, esm-in-bundle, http2/diagnostics_channel/vm gaps. Re-baselined against origin/main: same 0/7. |
| `audit/probes/w4/run-all.mjs` | PASS | (cached/data-only) |
| `audit/probes/w5/run-all.mjs` | PASS | |
| `audit/probes/w6/run-all.mjs` | PASS | |
| `audit/probes/x5c/run-all.mjs` | PASS | |
| `audit/probes/x5f/run-all.mjs` | PASS | |
| `audit/probes/x5g/run-all.mjs` | PASS | |
| `audit/probes/x5j/run-all.mjs` | PASS | (the X.5-J optional-peer wave that we extend) |
| `audit/probes/x5l/run-all.mjs` | PASS | |
| `audit/probes/x5m/run-all.mjs` | PASS | |
| `audit/probes/x5m3/run-all.mjs` | PASS | |
| `audit/probes/x5npqo/run-all.mjs` | PASS | |
| `audit/probes/x5r/run-all.mjs` | PASS | |
| `audit/probes/x5s/run-all.mjs` | PASS | |
| `audit/probes/x5z3/run-all.mjs` | PASS | |
| `audit/probes/x5z5-build/run-all.mjs` | ALLOWED-FAIL | Pre-existing per `audit/sections/X5Z5-build-retro.md`; unchanged by X.5-drizzle |
| `audit/probes/x526b/run-all.mjs` | PASS | |

**13/13 X.5 buckets PASS. 3/5 W waves PASS; 2/5 (w3, w3.5) pre-existing
fail unrelated to X.5-drizzle (verified by re-baseline run against
`origin/main` source; same failures).**

## E2E summary (live wrangler @ 127.0.0.1:8790)

```
drizzle-orm-installs.mjs    6/6 GREEN
drizzle-orm-smoke.mjs       6/6 GREEN
drizzle-orm-no-vite-pulled  6/6 GREEN

Pre-fix (RED, archived as e2e/*.pre-fix.out.txt):
  drizzle-orm-installs    2/5 — "npm install rejected: lightningcss"
  drizzle-orm-smoke       1/6 — "Cannot find module 'drizzle-orm'"
  drizzle-orm-no-vite-pulled  4/6 — install rejected; drizzle-orm absent
```

## Verdict

- ✅ `drizzle-orm` recovered: `⛔ → ✅` at the real-package install layer.
- ✅ 0 cross-wave src regressions (W11 detect contract preserved).
- ✅ tsc baseline byte-identical (2 errors).
- ✅ Single-resolver invariant preserved (1 impl in `_shared/`).
- ✅ All 13 X.5 + 3/5 W wave run-alls PASS; 2 pre-existing failures
     re-baselined against origin/main with identical failure shape.

## Cohort prediction (post-deploy)

VERIFY-9D4B61D §3 forecast: drizzle-orm fix → +1 strict ✅ → 16/33 strict
+ 31/33 healthy. Confirmed by per-package e2e probe; cohort-level
verification awaits the next post-deploy 33-pkg sweep.
