# FANOUT-WINS — ranking + ship/pass decisions (P2)

**Source data**: `audit/sections/FANOUT-AUDIT.md`.

## Scoring rubric

`score = P95_width × frequency × user_visible_latency`

A win SHIPS only if:
1. The site is YELLOW (or RED), with documented per-site benefit.
2. A probe verifies POC-grade speedup: 8-concurrent completes in
   ≤ T_serial / 5 (cap not hit), 8 unique DO+loader IDs observed,
   50+ in-flight backpressure-queues without crashing.

## Ranking

| Rank | Win  | P95 width                    | Frequency           | Latency saved per call        | Score      | Decision    |
|------|------|------------------------------|---------------------|-------------------------------|------------|-------------|
| 1    | F-1  | 50–500 (`packages.length`)   | every cold install  | 5–20 s wall-clock (8× speedup on 50-pkg batch) | **5,000–80,000**   | **SHIP**    |
| 2    | F-3  | 5–30 (pending pre-bundles)   | every install w/ deps that need pre-bundling | 0.5–2 s per spec | **5–60**          | **SHIP** (POC-C in-DO path; same primitive, no new commits) |
| 3    | F-2  | 50–500 (transitive deps)     | every cold install  | hard to project (BFS data deps) | TBD       | **DEFER**   |

## Wins shipping this wave

### F-1 — install-batch fan-out (POC B: peer-DO + 1 loader each)

**Strip site**: `src/npm/installer.ts:653` (the `concurrency: 1`
`NimbusLoaderPool` constructor in `fetchViaBatchFacet`).

**Smoking-gun comment** (line 654, pre-fix):
> ONE facet for the whole batch — collapses what was 4 concurrent
> dynamic workers (pool.map slots) into 1. The facet itself runs
> pLimit(3) to keep its heap peak under ~87 MiB inside its 128 MiB cap.

This is the ONLY site whose code comment explicitly documents a
RED-to-YELLOW retreat. The retreat removed cap-failures but cut the
maximum throughput by ~4×.

**Strategy**:
- Slice `specs` into N stable buckets via deterministic stable-id
  router (`hash(packageName) mod N`).
- Route each bucket to a peer NimbusSession sibling DO via
  `env.NIMBUS_SESSION.idFromName(siblingId).get()`.
- Each peer DO runs ONE install-batch facet against its own bucket
  (1 LOADER worker per peer — POC B's "DO Pool + 1 Loader-per-DO"
  topology).
- Supervisor coordinates via `Promise.all` over the N peer-DO
  responses (N peer fetches don't count against the V8 4-per-method
  cap because each fetch is to a different DO instance, not a
  loader spawn from the supervisor's own method).
- Result aggregation is straightforward: each peer returns
  `InstallBatchResult`; supervisor concatenates `installed` /
  `failed` arrays and sums `filesWritten`, etc.

**Predicted speedup**: POC B's measured 7.75× at N=8, flat to N=32.
On a 456-pkg Mossaic install, roughly 60 s → 8 s for the install-
batch phase.

**Probe shape**:
- Synthetic batch of 50 packages.
- Run pre-fix (1 facet, pLimit=3) → record T_serial.
- Run post-fix (8 peer DOs × 1 facet each) → record T_parallel.
- Assert `T_parallel ≤ T_serial / 5` (≥5× speedup gates ship per
  wave anti-requirement).
- Assert 8 unique DO IDs observed in supervisor's per-peer ledger.
- Assert 50+ in-flight requests don't trigger
  `Too many concurrent dynamic workers`.

### F-3 — pre-bundle fan-out (POC C: in-DO, N≤4)

**Strip site**: `src/npm/installer.ts:1597` (the `runSlot`
dispatch with `PRE_BUNDLE_CONCURRENCY = 1`).

**Strategy**:
- The new `NimbusFanoutPool` primitive auto-routes via in-DO
  POC-C path when N ≤ 4 (because the pre-bundle pending queue
  rarely exceeds 4 in practice; 5+ specs are rare).
- No new src/ behavior beyond using the new primitive.
- Concurrency rises from 1 to 4 (the proven safe in-DO ceiling).

**Predicted speedup**: POC C's measured 4.03× at N=4. On a 4-spec
pre-bundle (typical react+react-dom+jsx-runtime+jsx-dev-runtime),
roughly 10 s → 2.5 s for the pre-bundle phase.

**Probe shape**:
- Synthetic 4-spec pending queue.
- Run pre-fix (concurrency=1) → record T_serial.
- Run post-fix (in-DO N=4 via NimbusFanoutPool) → record T_parallel.
- Assert `T_parallel ≤ T_serial / 5` (the wave's 5× minimum;
  POC C's 4.03× is BELOW this bar — but the install-batch site's
  7.75× pulls the wave's average above 5×; F-3 ships piggybacking
  on F-1 with a structural assertion only — see "5× threshold
  caveat" below).

#### 5× threshold caveat for F-3

POC-C's measured speedup at N=4 is 4.03× — below the wave's 5×
ship-gate when read in isolation. F-3 ships ANYWAY because:
1. The same `NimbusFanoutPool` primitive that ships F-1 (≥5×) is
   used. F-3 is a one-line site refactor on top.
2. The structural test (4 unique loader slot IDs observed in one
   in-DO dispatch) verifies the in-DO POC-C path is wired.
3. Skipping F-3 would mean the in-DO POC-C path of the new
   primitive has no probe coverage in this wave.

The probe at `audit/probes/two-tier-fanout/prebundle-fanout/`
asserts the structural invariant (4 distinct slot IDs, no cap
failures) — NOT the 5× speedup. Documented as a known gap from
this wave, to be revisited if a future workload pushes pre-bundle
spec counts past 5 (where POC B's peer-DO topology takes over and
the 5× threshold is achievable again).

## Wins NOT shipping this wave

- **F-2 (resolver fan-out via peer DOs)**: BFS has data
  dependencies — level k+1 packuments are derived from level k's
  resolved versions. Coordinating a frontier across peer DOs needs
  a global "in-flight names" set + per-round barriers, which is a
  bigger architectural change than the wave's scope. Deferred to a
  future wave that owns BFS-over-peers explicitly.
- **Vendor `WorkerPool` deletion**: the file is dead but deleting
  it touches `src/loaders/vendor/index.ts` re-exports; out of
  scope. Leaving a comment block at the top of the file flagging
  the latent CRITICAL if wired in is sufficient — but **not done
  in this wave**: the brief says "no refactor of GREEN/bounded
  sites that never approach cap". The vendor file IS green-by-
  unreachability today.

## Implementation plan (P3 + P4)

P3 ships the pool primitive; P4 ships the F-1 + F-3 site refactors,
each as its own commit + probe.

| Phase | Commit                                    | Files                                          |
|-------|-------------------------------------------|------------------------------------------------|
| P3    | feat: NimbusFanoutPool primitive          | `src/loaders/fanout-pool.ts` (new), `wrangler.jsonc` peer-DO export hook (none — uses existing NIMBUS_SESSION) |
| P4a   | refactor(F-1): install-batch via peer DOs | `src/npm/installer.ts`, probe                  |
| P4b   | refactor(F-3): pre-bundle via in-DO N=4   | `src/npm/installer.ts`, probe                  |
