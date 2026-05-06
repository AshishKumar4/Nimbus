# X.5-drizzle — Phase D audit results

> Branch: `x5-drizzle` @ `5c3d61f` (Phase D fix)
> Audit date: 2026-05-06 (resumed session)
> Driver: live wrangler @ `127.0.0.1:8790` (x5-drizzle worktree)

## Done-condition checklist

| # | Criterion | Verdict |
|---|---|---|
| 1 | drizzle-orm install succeeds (no REJECT) | ✅ `e2e/drizzle-orm-installs.audit.out.txt` 6/6 GREEN |
| 2 | `require('drizzle-orm')` returns expected keys | ✅ `e2e/drizzle-orm-smoke.audit.out.txt` 6/6 GREEN; keys include `ColumnAliasProxyHandler`, `TableAliasProxyHandler` matching verify-700420f / verify-90993b3 baseline |
| 3 | vite + lightningcss correctly absent | ✅ `e2e/drizzle-orm-no-vite-pulled.audit.out.txt` 6/6 GREEN |
| 4 | x5-drizzle functional probes 3/3 GREEN | ✅ |
| 5 | x5-drizzle regression probes 5/5 GREEN | ✅ |
| 6 | All 12 W11 framework-detect probes still PASS | ✅ Next/Astro/Nuxt/Remix/SK + wrangler-on-fw + wrangler + vite-generic + precedence + remix-bare-react + unknown + shim-modules-loadable |
| 7 | Single-resolver invariant preserved | ✅ 10/10 single-resolver-source probes PASS (x5f/x5g/x5j/x5m/x5s/x5npqo/x5m3/x5z5-build/x526b/x5-drizzle) |
| 8 | Install-pipeline-coverage canonical probe | ✅ 4/4 (fastify/express/ts-jest/redis) |
| 9 | Mossaic shape probes (data-only) | ✅ w12 + w7 + x5-drizzle, 3/3 PASS |
| 10 | Wave 1 contract (external-host=0) | ✅ `audit/probes/w4/regression/wave1-contract-rerun.mjs` PASS, external=0 |
| 11 | tsc baseline byte-identical (2 errors) | ✅ src/esbuild-service.ts(153,28) + src/nimbus-session-init.ts(74,39); identical to VERIFY-9D4B61D §2 |
| 12 | Forbidden files untouched | ✅ `git diff origin/main..HEAD src/node-shims.ts src/wasm-swap-registry.ts src/parallel/npm-resolve-preamble.ts` empty |
| 13 | All 13 X.5 wave run-alls (J/L/M/NPQO/Z5/R/Z3/M3/S/26b/peer-gap/T/C+F+G) | 12/13 PASS; x5z5-build is documented pre-existing fail (probe self-marks "out of Z5 scope") |
| 14 | x5peer-gap-investigation probes (peer-gap is plan-only — no run-all) | ✅ 3/3 PASS (p1-defu / p2-tailwindcss-skip / p3-greedy) |

X.5-T (parallel branch per prompt) is a SEPARATE wave; no overlap with X.5-drizzle.

## Cross-wave invariants

- **Forbidden-files-untouched:** `git diff origin/main..HEAD src/` shows `+87 LOC` across exactly `src/npm-resolver.ts` and `src/npm-resolve-facet.ts`. `src/node-shims.ts`, `src/wasm-swap-registry.ts`, `src/parallel/npm-resolve-preamble.ts` all unchanged.
- **W11 framework-detect contract:** 12/12 detect probes PASS. `framework-detect.ts` was NOT modified; `frameworkAware` flag semantics unchanged.
- **X.5-J optional-peer enqueue:** semantically extended via `bestEffortNames` set; the existing X.5-J `lookupReject` carve-out for direct-rejected peers (sql.js, sqlite3, etc.) is preserved verbatim. The new branch adds *transitive* reject swallowing for descendants of best-effort peers — orthogonal addition.
- **W6 `__w6_reject` contract:** registered rejects still throw at any depth in REQUIRED subtrees (top-level + required peer subtrees). Only best-effort optional-peer subtrees swallow them.

## Pre-existing failures (verified NOT introduced by x5-drizzle)

| Probe | Failure shape | Re-baseline verdict |
|---|---|---|
| `audit/probes/w3/run-all.mjs` | node:vm/http2/diagnostics_channel/repl module gaps; fastify/jsdom/axios/redis fail to load | Reproduces against `origin/main` source (verified Phase E re-baseline) |
| `audit/probes/w3.5/run-all.mjs` | Same shape: directory-as-index, esm-in-bundle, http2/vm/diagnostics_channel | Reproduces against origin/main: 0/7 same as ours |
| `audit/probes/x5z5-build/run-all.mjs` | tailwindcss-vite e2e fails on lightningcss native binding — probe self-marks `[downstream — out of Z5 scope]` | Documented in `audit/sections/X5Z5-build-retro.md`; whitelisted in our `prior-x5-runalls-shim.mjs` |

These are environmental / pre-existing per VERIFY-9D4B61D §1 & §2; not regressions from this wave.

## Verdict

**ALL DONE-CONDITIONS MET.** drizzle-orm recovers ⛔→✅ at the real-package install layer. 0 cross-wave src regressions. W11 framework-detect contract fully preserved.
