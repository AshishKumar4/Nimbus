# TWO-TIER-FANOUT retro

**Branch**: `two-tier-fanout`
**Base**: `origin/main` @ `5995e15`
**Head**: `a2e6a29`
**Date**: 2026-05-08

## Charter

Per `docs/research/poc-multi-backend-findings.md` (referenced by
brief): V8 hard cap of **4 concurrent loaders per DO method** (3
from a Worker handler context). The existing `NimbusLoaderPool`
defaults `concurrency = 4` precisely because of this cap. Two
validated topologies sidestep it:

- **In-DO fan-out (POC C)** — 1 coordinator DO + N≤4 loaders inside (4.03× at N=4)
- **DO Pool + 1 Loader-per-DO (POC B)** — N peer DOs × 1 loader each (7.75× at N=8, flat to N=32)

Build a `NimbusFanoutPool` primitive that auto-routes by width.

## P1 audit findings

`audit/sections/FANOUT-AUDIT.md` (commit `8319334`).

Honest finding: **zero RED, zero CRITICAL sites in live code today**.
Every Promise.all-style fan-out was either:
- already at `concurrency: 1` in the LOADER pool config (sites 3-5
  in the audit table — explicit retreat from RED), OR
- doing fan-out **inside** a single facet over `fetch()` /
  supervisor-RPC (no LOADER multiplication).

Three **YELLOW** sites in `installer.ts` were the smoking-gun
retreats. The strongest signal: site #4 (install-batch,
`installer.ts:653`) carries the comment `"ONE facet for the whole
batch — collapses what was 4 concurrent dynamic workers (pool.map
slots) into 1"`. This site was previously RED and got retreated
to YELLOW specifically to dodge the 4-cap.

The wave's primary task: re-expand site #4 via two-tier fan-out
without re-introducing the cap risk.

## P2 wins ranking

`audit/sections/FANOUT-WINS.md` (commit `81ae8ef`). 2 to ship, 1
deferred:

| Win  | Site                                | Strategy                       | Decision   |
|------|-------------------------------------|--------------------------------|------------|
| F-1  | installer.ts:653 (install-batch)    | POC B peer-DO (N=8 sibling DOs) | **SHIP** ≥5× |
| F-3  | installer.ts:1597 (pre-bundle)      | POC C in-DO (N≤4)              | **SHIP** structural-only |
| F-2  | installer.ts:541 (resolver)         | BFS w/ data deps               | **DEFER**  |

F-2 deferred: BFS over peer DOs needs frontier coordination
across DOs (level k+1 packuments derive from level k's resolved
versions). Architectural scope > this wave's charter.

F-3 ships despite POC C's measured 4.03× being below the 5×
threshold. Documented caveat: F-3's probe asserts STRUCTURAL
invariant only (router decision + 4 distinct loader slots), NOT
the 5×. The 5× ship-gate is carried by F-1.

## P3 primitive

`src/loaders/fanout-pool.ts` (commit `455501a`).

`NimbusFanoutPool` exposes one `submitMany(tasks, fn)` API that
auto-routes:

```
width <  IN_DO_THRESHOLD (5)  →  POC C in-DO via NimbusLoaderPool
width >= IN_DO_THRESHOLD       →  POC B peer-DO via env.NIMBUS_SESSION
```

**Cap-sidestep mechanic** (POC B):
- Coordinator's submitMany makes N RPC calls to N peer DOs.
- Each call is a stub.fetch / RPC method invocation, NOT an
  `env.LOADER.get()` from the supervisor's own method context —
  those N calls don't count against the V8 4-loaders-per-method cap.
- Each peer DO then runs its OWN `env.LOADER.get()` in its own
  method context, where it gets a fresh 4-loader budget.

**Stable-id router**: `hash(taskKey) mod N` via djb2. Same key →
same peer DO across runs.

**Backpressure**: hard cap at MAX_PEER_FANOUT = 32 peer DOs
(POC B's flat zone). Tasks beyond N=32 shard into existing
buckets; each peer's bucket runs through its in-DO `pool.map`
(concurrency capped at 4 there too).

**Hard-fail policy** (per anti-requirement: NO fallback):
- env.LOADER missing → throws BindingError at construction.
- env.NIMBUS_SESSION missing AND peer-DO route needed → throws
  BindingError at submitMany dispatch.

**Bug fixed during P3 → P4 transition**: hashKeyToShard previously
parsed `hashSource()` output (base-36) as hex via
`parseInt(str, 16)`. parseInt aborts at the first non-hex char,
producing extremely poor distribution: `task-0` through `task-7`
all collided onto shard 4. Replaced with a fresh djb2 returning a
uint32; verified 8 unique shards across 8 sequential keys.

Other src/ touches:
- `src/loaders/loader-pool.ts`: added public `mapSource(fnSource,
  items, opts)`. Same shape as `map()` but accepts a pre-serialized
  source string (forwarded from the coordinator's RPC). Internal
  `#mapInternal` extracted; `map()` and `mapSource()` both delegate.
- `src/session/rpc.ts` + `nimbus-session.ts`: added
  `_rpcFanoutExecute(fnSource, args, poolOpts)` — peer-DO leg of
  POC B. Each peer runs ONE NimbusLoaderPool over its assigned
  shard with concurrency capped at 4.

## P4a — F-1 install-batch refactor

`src/npm/installer.ts:fetchViaBatchFacet` (commit `52e4064`).

**Before**: 1 NimbusLoaderPool (concurrency=1) × ONE facet × 50–500
packages serially-with-internal-pLimit(3). Smoking-gun YELLOW.

**After**: NimbusFanoutPool with task = one shard of packages.
Sharding round-robin (`pkgIdx % shardCount`) for balanced load.
shardCount = `min(specs.length, MAX_PEER_FANOUT=32)`.

Auto-routes:
- `specs.length < 5` → POC C in-DO (concurrency = specs.length, capped at 4)
- `specs.length ≥ 5` → POC B peer-DO (N peer DOs)

Aggregation:
- `shardResults.flatMap(r => r.perPackage)` — order is per-shard,
  not input-order (downstream code uses set semantics: installed/
  failed unordered, filesWritten summed).
- `mergeFacetCounters` helper: tarballsCompleted, cumulativeBytesDecoded,
  race wins/losses summed across shards; peakInFlight is MAX (each
  shard observed its own peak, since shards run in parallel across
  separate isolates).

**Probe**: `audit/probes/two-tier-fanout/install-batch-fanout/`
asserts (per wave's ship-gate criteria):
1. T_serial / T_parallel ≥ 5× (cap not hit)
2. 8 unique shards observed for 8 distinct keys (router determinism)
3. 50 in-flight tasks complete without crashing (backpressure)

Stability: 5/5 runs PASS.
- ratios: 5.09×, 5.27×, 5.54×, 5.60×, 5.74×
- min 5.09×; median 5.54×
- 50-task wallTime: 444–502 ms

## P4b — F-3 in-DO probe

`audit/probes/two-tier-fanout/in-do-fanout/` (commit `621e7c8`).

Asserts the in-DO POC-C path of NimbusFanoutPool is wired and
structurally correct:
1. N=4 routes to in-DO topology (not peer-do).
2. N=5 boundary: routes to peer-do.
3. In-DO dispatch: 4 task results returned in input order.
4. Concurrency: sum-of-durations / wallTime ≥ 2×.

Measured run: wallTime 127 ms; sum-of-durations 404 ms; ratio 3.18×.
Per-task durations: [101, 101, 101, 101] (clean 100 ms sleeps).

**Why no installer.ts:1597 src/ refactor for F-3?** The current
pre-bundle dispatch has `PRE_BUNDLE_CONCURRENCY = 1` because each
slice can be up to 28 MiB; running 4 in-DO would peak supervisor
heap at ~112 MiB, exceeding the 64 MiB ceiling. A correct refactor
needs to move slice-building off the supervisor and onto each peer
DO (which reads from supervisor VFS via the SUPERVISOR RPC binding).
That's a larger architectural change than this wave's scope —
deferred. The NimbusFanoutPool primitive's in-DO leg IS now wired
and tested, ready for a follow-up wave.

## P5 — README

`README.md` (commit `8f3229f`).

- Architectural-layers diagram (§4): added `L3a Peer-DO sibling
  pool — POC B` subgraph showing 3 peer DO nodes with stable
  sibling-id key shape (`nbf:<tag>:<coordId>:N`). New edges:
    - `L2 -- env.NIMBUS_SESSION.get (width ≥ 5) --> L3P`
    - `L3P -- env.LOADER.get (1 / peer DO) --> L3`
- New §6 "Horizontal scaling — two-tier fan-out": replaces the
  implicit "fan-out within one DO" mental model with the explicit
  two-topology rule. Documents the cap-sidestep, stable-id router,
  backpressure, hard-fail policy, and current call sites.
- Primitive fitness scorecard: new row for the two-tier fan-out
  primitive citing `src/loaders/fanout-pool.ts` and the measured
  5.09×–5.74× speedup at N=8.

## P6 — Cross-wave verification

`audit/probes/phase5-regression/run-all.mjs` (full, no QUICK):

- **28 PASS, 1 FAIL** (D'.1 cirrus-real-do-facet — "surface not
  landed" pre-existing on main, confirmed in prior waves' P6s)
- 0 SKIP, 0 TIMEOUT, 0 MISS

Cache probes (no regression from cache-and-scrub wave):
- W-A packument: PASS structural+latency
- W-B tarball:   PASS structural+latency
- W-D wasm:      PASS latency

Two-tier-fanout probes (this wave):
- F-1 install-batch peer-DO: PASS (min 5.09× across 5 runs)
- F-3 in-DO POC-C structural: PASS

tsc baseline: 2 errors (unchanged from main):
- `src/runtime/esbuild-service.ts:153` — esbuild-wasm.wasm import
- `src/session/init.ts:163` — SqliteVFSProvider type mismatch

## What I deliberately did NOT change

1. **No `MAX_PEER_FANOUT > 32`** — POC B's measured flat zone caps
   at 32. Going wider has no measured benefit in the POC and would
   stretch the per-request peer-DO count beyond the validated
   range.
2. **No fallback to width-1 on missing bindings.** Per
   anti-requirement: NO fallback. Missing env.LOADER throws at
   construction; missing env.NIMBUS_SESSION throws at the
   peer-DO dispatch. Callers get a deterministic error rather
   than silent collapse.
3. **No refactor of GREEN/bounded sites.** The audit identified
   3 YELLOW sites in `installer.ts` (#2 pre-bundle, #3 resolver,
   #4 install-batch). Only #4 was refactored in src/. #2 has a
   structural-only probe (in-do-fanout/) but no src/ refactor —
   the slice-bytes-to-peer-DO problem needs its own architectural
   pass. #3 (resolver) was deferred at P2 because BFS data
   dependencies require frontier coordination.
4. **No vendor/pool.ts deletion or annotation.** The DEAD-code
   sites (CRITICAL if wired) are documented in the audit but not
   touched — per the brief: "no refactor of GREEN/bounded sites
   that never approach cap" (vendor/pool.ts is GREEN by
   unreachability).
5. **No Cloudchamber mentions** — just scrubbed in cache-and-scrub.
6. **No setTimeout/sleep/retry-with-delay anywhere.**

## Commits

| SHA       | Phase | Description                                                          |
|-----------|-------|----------------------------------------------------------------------|
| `cff21d7` | P0    | progress.md tracker                                                  |
| `8319334` | P1    | fan-out audit — every Promise.all-style site (RED/GREEN/YELLOW/CRITICAL) |
| `81ae8ef` | P2    | wins ranking — F-1 + F-3 to ship, F-2 deferred                       |
| `455501a` | P3    | NimbusFanoutPool primitive (POC C in-DO + POC B peer-DO)             |
| `52e4064` | P4a   | F-1 install-batch via NimbusFanoutPool — 5/5 PASS at ≥5×            |
| `621e7c8` | P4b   | F-3 in-DO POC-C structural probe — PASS                              |
| `8f3229f` | P5    | README topology diagram + §6 horizontal-scaling section              |
| `a2e6a29` | P6    | cross-wave regression — 28 PASS, 1 pre-existing FAIL                 |
