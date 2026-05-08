# Phase 2 retro — Track A' memory-pressure containment shipped

Branch: `prod-reset-investigation`. Phase 2 of the architectural rebuild,
following Phase 1 (C' observability foundation, retro at
`PROD-RESET-INVESTIGATION-PHASE1-RETRO.md`).

## What landed

Five sub-phases per the user's order:

| Sub-phase | Verdict | Net LOC | Notes |
|---|---|---:|---|
| A'.5 esbuild → env.ASSETS | ✅ GREEN | -16 MiB worker bundle (gzipped) | idle 71.9% → 14.1% of ceiling |
| A'.1 single-resolver / single-fetcher | ✅ GREEN | -560 LOC | three feature flags + three legacy paths gone |
| A'.2 streamingBuffers attribution | ✅ GREEN | +60 LOC | new heap-attribution slot for in-flight RPC payloads |
| A'.3 barrel-synth bound verified | ✅ GREEN | 0 LOC src/ | probe-only; existing path is bounded better than expected |

A'.4 (cirrus-real → DO Facet) was deferred to Phase 4 D' per the
original Phase 2 charter — combined with the rename
NimbusFacetPool → NimbusLoaderPool there.

## Cumulative heap impact

| Component | Pre-Phase-2 | Post-Phase-2 | Delta |
|---|---:|---:|---:|
| supervisorBaselineBytes | 30 MiB | 9 MiB | -21 MiB |
| esbuildResidentBytes | 16 MiB | 0 MiB | -16 MiB |
| vfsLruBytes (idle) | 0 | 0 | 0 |
| vfsInFlightBytes (idle) | 0 | 0 | 0 |
| resolverInFlightBytes (idle) | 0 | 0 | 0 |
| preBundleSliceBytes (idle) | 0 | 0 | 0 |
| streamingBuffersBytes (idle) | (invisible) | 0 (new slot) | +visibility |
| **idle total** | **46 MiB** | **9 MiB** | **-37 MiB** |
| **idle % of 64 MiB ceiling** | **71.9%** | **14.1%** | **-57.8 pp** |
| peak under 1-min smoke | 81.6% | 23.8% | -57.8 pp |

The 64 MiB ceiling now has 86% of headroom at idle and 76% under
realistic install + vite load. The Phase 2 cumulative bar (idle ≤
50% / peak ≤ 95%) is met by a substantial margin.

## Architectural shape change

Pre-Phase-2 the supervisor isolate held three classes of bulk bytes
permanently or near-permanently:

1. The esbuild-wasm base64 string (~21 MiB UTF-16 in worker bundle).
2. The decoded esbuild-wasm ArrayBuffer (~16 MiB module-scope cache).
3. Optional fallback paths that, IF the env-flag flipped or a guard
   tripped, would materialise packument JSON / tarball bytes /
   batch-write payloads in supervisor heap.

Post-Phase-2 all three are gone:

1. esbuild-wasm bytes live in `env.ASSETS`, fetched only at pool
   construction. No supervisor residency.
2. The decoded ArrayBuffer cache no longer exists. Every
   `fetchEsbuildWasmBytes(env)` call is a fresh asset fetch with
   no module-scope memoisation.
3. There are NO fallback branches in `runInstall`. `env.LOADER` is
   a hard requirement; the install fails loud on its absence.

The supervisor's role is now purely **routing + control flow**. Bulk
bytes flow through it transiently (RPC payloads, attributed via
`streamingBuffersBytes`) but do not reside.

## Per-sub-phase verdict

### A'.5 — `heap.breakdown.esbuildBytes ≤ 1 MiB`

Met (= 0 MiB). The ESBUILD_RESIDENT_BYTES constant is now hard-wired
to 0. The base64 string in the generated module is also gone, taking
~21 MiB out of the worker bundle. Generated file shrunk from 16 MiB
to 123 KiB.

No fallback: a missing wasm asset is a deploy bug. The
`fetchEsbuildWasmBytes` function throws on non-200; the install
log surfaces the error.

### A'.1 — single-resolver / single-fetcher invariant

Met. ~560 LOC of dead code removed:
- `shouldUseFacetResolver` / `shouldUseFacetPool` / `shouldUseBatchFacet`
  methods + their env-flag plumbing (`NIMBUS_FACET_RESOLVER`,
  `NIMBUS_FACET_NPM_INSTALL`, `NIMBUS_FACET_NPM_INSTALL_BATCH`).
- `fetchViaFacetPool` (the per-package pool.map path).
- `fetchWaves` async generator + `buildBatchPayload` BatchWritePayload
  builder + `WaveResult` interface in `npm-tarball.ts`.
- `fetchAndStagePackage` + `FacetPackageResult` in `npm-install-facet.ts`
  (module shrank from 406 LOC to 41 LOC).

Diag taxonomies narrowed:
- `resolverPath`: `'in-supervisor' | 'in-facet' | 'unset'` →
  `'in-facet' | 'unset'`.
- `installFacet.path`: 4-value union → `'batch-facet' | 'unset'`.

### A'.2 — streamingBuffers ≤ 1 MiB at idle

Met (= 0 at idle). New attribution slot in the heap-estimate
breakdown counts in-flight supervisor RPC payload bytes (writeBatch
/ writeBatchStream / putRegistryEntries). The C'.1 estimator now
has 7 components instead of 6, with sum-equals-total invariant
preserved.

Streamed payloads (writeBatchStream over W7 frames) report the W7
highwater (256 KiB) rather than total payload, since the bytes flow
with backpressure.

### A'.3 — barrel-synth bound

Met by audit. The synthesis path's `transitiveCap = 800` plus
typical icon-file size ~5 KiB yields a ~4 MiB worst-case supervisor
heap — already 7× tighter than the regular slice walker's
SLICE_CAP_BYTES = 28 MiB envelope. Synthesis is the GOOD path.

Probe locks in the bound (transitiveCap ≤ 1000, synthesis-only gate,
SLICE_CAP_BYTES = 28 MiB, idle preBundleSliceBytes = 0).

The wholesale "move synthesis into the facet" rewrite from the
original plan §3.2.2 is deferred to Phase 3+ where it lands together
with the slice-streaming RPC architecture.

## Cross-wave regression check

All probes GREEN at end of Phase 2:

| Probe | Status |
|---|---|
| `c-prime/heap-estimator` (Phase 1) | ✅ 20/20 |
| `c-prime/recovery-events` (Phase 1) | ✅ 13/13 |
| `interactive-liveness/long-form-replay` (Phase 1, 1-min smoke) | ✅ 6/6 (peak 23.8%) |
| `interactive-liveness/walltime-distribution` (Phase 1) | ✅ 4/4 (p99 13 ms) |
| `interactive-liveness/error-recovery` (Phase 1) | 🔴 RED-by-design (Phase 3 B' gate) |
| `a-prime/a5-esbuild-bytes` (Phase 2) | ✅ 3/3 |
| `a-prime/a1-resolver-fallback` (Phase 2) | ✅ 17/17 |
| `a-prime/a2-streaming-buffers` (Phase 2) | ✅ 3/3 |
| `a-prime/a3-barrel-synth` (Phase 2) | ✅ 5/5 |
| `w5/functional/ring-persistence` (existing) | ✅ 16/16 |
| `w5/functional/lru-shrink-restore` (existing) | ✅ 11/11 |
| `w5/functional/sqlite-nomem-retry` (existing) | ✅ 13/13 |
| `bun x tsc --noEmit` | ✅ 2 baseline errors only |

Zero regressions caused by Phase 2.

## Surprises

- **A'.3 turned out to be a probe-only sub-phase.** The original plan
  framed barrel synthesis as a wasteful supervisor-heap path. Reading
  the actual implementation showed `transitiveCap = 800` already
  bounds it to ~4 MiB worst-case. Moving it to the facet would
  trade supervisor 4 MiB for facet 4 MiB + per-file RPC chatter —
  net heap-budget impact zero. The right action was to lock in the
  existing bound with a probe and defer the wholesale rewrite.

- **The supervisor baseline dropped 21 MiB just by moving the
  esbuild base64 string out of the worker bundle.** That's not
  about the cache or the runtime path — it's about what gets
  bundled at deploy time. A shocking amount of supervisor heap was
  permanently allocated to a string the supervisor itself never
  touched (only the facet did, indirectly via the LOADER modules
  map).

- **Removing the legacy fallback branches in A'.1 surfaced ~900 LOC
  of dead code.** The pool.map + fetchWaves + buildBatchPayload
  paths had been superseded for a while but never deleted. Net
  cleanup more than the architectural change itself.

## Recommended Phase 3 entry point — B'.1 shell-state-to-SQL

Per the user's reduction charter and Phase 1 retro's recommendation,
Phase 3 is **Track B' (recovery correctness)**. The first sub-phase
should be **B'.1 — persist shell state to DO SQLite** because:

1. **It's the smallest unit of state.** cwd + env vars per shell
   process, ~few KiB. Easy to design the SQL schema for.
2. **It unblocks the C'.3 error-recovery probe.** The probe at
   `audit/probes/interactive-liveness/error-recovery/` is currently
   RED-by-design; the assertions about cwd preservation and silent
   re-init flip GREEN when shell state persists.
3. **It establishes the rehydrate pattern.** B'.2 (kernel mounts),
   B'.3 (terminal scrollback), B'.4 (initSession reentrant), and
   B'.5 (`/ws` upgrade joins existing session) all follow the same
   read-from-SQL-on-rehydrate pattern. Getting it right for cwd
   first sets the template.

Alternative: Bug B (deterministic heap estimator) was already shipped
in Phase 1 C'.1. The "Bug B fix" line in the original §6 plan is
done.

Phase 3 dispatch criteria:
- Acceptance bar: `audit/probes/interactive-liveness/error-recovery/`
  flips from RED-by-design to GREEN.
- Cumulative bar: idle ≤ 50% (already 14.1% post-Phase-2, easily
  preserved); peak ≤ 95% under realistic load including a forced
  `webSocketError` trigger.
- Cross-wave: zero regressions (every Phase 1 + 2 probe still GREEN).

## Branch state

- 9 commits on top of Phase 1 (4 + 1 P0 + 4 build × 2 sub-commits each).
- All pushed via `GIT_SSL_NO_VERIFY=1`.
- src/ touches: 7 files modified, 1 file shrunk by 90% (
  `npm-install-facet.ts` 406 → 41), 1 file shrunk by 50% (
  `npm-tarball.ts` 396 → 232), 0 files added.
- public/ touches: 1 asset added (`public/_assets/esbuild-0.24.2.wasm`).
- audit/probes/ touches: 4 new probe directories under `a-prime/`,
  1 updated in `c-prime/`.
- audit/sections/ touches: 4 retro sub-sections + this Phase 2 retro.

Ready for Phase 3 (Track B' recovery correctness) dispatch.
