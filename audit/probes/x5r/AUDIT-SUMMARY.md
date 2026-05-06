# X.5-R Audit summary (Phase E)

> Branch `x5r-events-class` HEAD `ea88891`. Date 2026-05-05.

## tsc baseline

```
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm'…
src/nimbus-session-init.ts(74,39): error TS2345: SqliteVFSProvider not assignable to MountProvider…
```

Exit 0, 2 errors, **byte-identical to verify-700420f baseline**. No
new errors from X5R src/ change. ✓

## X.5-R run-all

`BASE=http://127.0.0.1:8787 NIMBUS_X5R_E2E=1 bun audit/probes/x5r/run-all.mjs`:

| Tier | Probe | Result |
|---|---|---|
| functional | r-stream-eventemitter-shape.mjs | PASS (was RED pre-fix) |
| functional | r-stream-prototype-still-pointed.mjs | PASS (Z5 invariant guard) |
| functional | r-ee-lazy-init-still-works.mjs | PASS (Z5-build invariant guard) |
| regression | r-single-resolver-source.mjs | PASS (3 sub-probes: x5f + x5j + x5npqo) |
| regression | r-install-pipeline-coverage.mjs | PASS |
| e2e | r-cache-class-extends.mjs | PASS (was RED pre-fix; smallest reproducer) |
| e2e | r-redis-loads.mjs | PASS (was RED pre-fix) |
| e2e | r-fastify-still-loads.mjs | PASS |

**8/8.** Snapshot: `run-all-GREEN-post-fix.txt`.

## Cross-wave probe suite parity

`bun audit/probes/<wave>/run-all.mjs`:

| Wave | Result | Notes |
|---|---|---|
| X.5-F | 7/7 PASS | including install-pipeline-coverage-shim |
| X.5-G | 11/11 PASS | local default; e2e gated |
| X.5-C | 10/10 PASS | all 3 e2e PASS |
| X.5-J | 9/9 PASS | e2e gated |
| X.5-L | 10/10 PASS | including 3 e2e |
| X.5-M | 9/9 PASS (functional only) | with BASE: **9/9 + 3 e2e PASS** including **redis e2e ✅ success** (was ⚠ install OK runtime fail pre-X5R) |
| X.5-NPQO | 6/6 PASS (functional only) | with BASE: **10/10 PASS** including **redis e2e ✅** |
| X.5-Z5-build | 7/8 PASS | tailwindcss-vite e2e fails — **pre-existing**, lightningcss native binding (out of Z5 scope per X5Z5-build-retro §1). Verified by checking out 4dd336e (pre-X5R) src/node-shims.ts and re-running: same FAIL. **NOT a X5R regression.** |

## Heavy-regression probes

| Probe | Result | Pre-X5R | Δ |
|---|---|---|---|
| `audit/probes/run-wave1-regression-w2.mjs` | PASS (external=0, status=200, twOk=true) | not measured this session | — |
| `audit/probes/run-mossaic-prod-w2.mjs` | FAIL (`playwright — Bundled browsers (~300 MB)` REJECT_INSTALL) | **same FAIL** verified by stashing X5R src/ change and re-running | NOT a X5R regression — pre-existing wasm-swap-registry / REJECT_INSTALL behavior |

## External-validation parity (third-party probes that ALSO test redis)

The wave-M and wave-NPQO suites have their own redis e2e probes with
their own classification logic:

- **X5M `e2e/redis.mjs`**: `[X5M E2E] redis → ✅ success` (was `⚠
  install OK runtime fail` at HEAD a571079 pre-X5R)
- **X5NPQO `e2e/redis.mjs`**: PASS in run-all summary (which includes
  `redis e2e` line)

Both confirm: **redis flips from ⚠ → ✅ at the e2e layer**, which is
exactly the dispatch's "+1 ✅ for redis" prediction.

## Phase E verdict

- All X5R probes: 8/8 GREEN
- All other waves' probe suites: parity preserved (no regressions)
- tsc: 2 baseline errors, byte-identical
- W1: PASS
- Mossaic: pre-existing FAIL (playwright REJECT) — verified pre-X5R by stash+re-run
- X5Z5-build's 1 failing probe: pre-existing (lightningcss) — verified pre-X5R by stash+re-run
- External validation: X5M + X5NPQO redis e2e probes both flip ✅

**0 regressions. +1 ✅ flip (redis). 2/2 dispatch packages (fastify + redis) green at HEAD ea88891.**
