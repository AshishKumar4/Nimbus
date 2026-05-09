# FANOUT-AUDIT — every Promise.all-style fan-out (P1)

**Branch**: `two-tier-fanout`
**Base**: `origin/main` @ `5995e15`
**Date**: 2026-05-08
**Scope**: every fan-out call site under `src/` whose width can scale
with input size. Output drives the wins ranking in `FANOUT-WINS.md`.

## TL;DR

The audit's surprising headline: **zero RED, zero CRITICAL sites
exist in live code today**. Every fan-out is currently safe — but
that safety is by **strategic retreat to `concurrency: 1`** rather
than by proven fan-out infrastructure. Three sites collapsed
multi-loader fan-outs to single-facet-with-internal-limiter
specifically because the supervisor DO has no way to safely fan
beyond the V8 4-loaders-per-method cap.

This wave's `NimbusFanoutPool` primitive lets those sites go wide
again — via in-DO fan-out for N≤4 and peer-DO fan-out for N>4 —
without re-introducing the cap risk.

## Charter recap

Per `docs/research/poc-multi-backend-findings.md` (referenced in the
brief; the cap is also documented at
`docs/research/cf-internal-dossier.md` under
`dynamicWorkersPerOwnerLimit @215 :UInt32 = 50` for the per-owner
default and the V8-level 4-per-method invariant noted there):

- V8 hard cap: **4 concurrent loaders per DO method** (3 from a
  Worker handler context).
- Two validated topologies:
  - **In-DO fan-out (POC C)** — 1 coordinator DO + N≤4 loaders inside
    (4.03× at N=4).
  - **DO Pool + 1 Loader-per-DO (POC B)** — N peer worker DOs, each
    spawning 1 loader (7.75× at N=8, flat to N=32).

## Methodology

Ripgrep over `Promise\.(all|allSettled)`, `\.LOADER\.get\(`,
`pLimit`, `runSlot`, plus targeted reads of every match's
surrounding 30 lines. Test files (`audit/probes/...`) and generated
bundles (`*.generated.ts`) excluded. Fixed-arity tuples
(`Promise.all([a(), b()])`) excluded.

## Classification

- **RED**: width can exceed 4 in normal operation, but the path
  serializes against `NimbusLoaderPool` (concurrency=4) hidden cap.
  User-visible latency penalty.
- **YELLOW**: width is currently 1 (`concurrency: 1` in the LOADER
  pool config) **specifically because** going wider risks the cap.
  Latent-RED — would benefit from two-tier fan-out.
- **GREEN**: width is naturally ≤ 4 by code construction or by
  problem domain.
- **CRITICAL**: unbounded width with no concurrency wrapper —
  risks `Too many concurrent dynamic workers`.

## Live-code fan-out sites

### 1. `src/loaders/loader-pool.ts:646` — `NimbusLoaderPool.map`

```ts
await Promise.all(
  Array.from({ length: concurrency }, (_, slotIndex) => runSlot(slotIndex)),
);
```

- **Function**: `NimbusLoaderPool.map`.
- **Fans out**: dispatches user fn over an item array via N
  `runSlot` workers awaiting at end. Each slot does sequential
  `loader.get(id, ...).getEntrypoint().execute(...)` — exactly
  one in-flight dynamic worker per slot.
- **Width formula**: `min(opts.concurrency ?? this.concurrency, items.length)`;
  `this.concurrency = Math.max(1, opts.concurrency ?? 4)` at
  constructor:232.
- **Live callers in production**: NONE. Grep over `installer.ts`,
  `vite-dev-server.ts`, etc. shows every caller uses `pool.submit`
  (single-shot) — `pool.map` is a defined-but-unused API surface.
- **Classification**: **GREEN** (cap = 4; default never exceeded).

### 2. `src/npm/installer.ts:1597` — pre-bundle `runSlot` dispatch

```ts
// PRE_BUNDLE_CONCURRENCY = 1 (line 1324)
await Promise.all(
  Array.from({ length: PRE_BUNDLE_CONCURRENCY }, (_, i) => runSlot(i)),
);
```

- **Function**: `NpmInstaller.prebundleUsedModules`.
- **Fans out**: per-spec slice-build + `pool.submit(prebundleOne, spec)`.
- **Width formula**: `PRE_BUNDLE_CONCURRENCY = 1`; pending spec
  count ranges 0–~30 specs, but width is fixed.
- **Live pool config** (installer.ts:1373): `concurrency: 1`.
- **Reasoning** (per comments at 1280–1303): was 2, dropped to 1
  after Mossaic-scale crash. **Direct quote** (line 1287):
  > Cutting concurrency to 1 halves the peak slice footprint
  > (28 MiB vs 56 MiB) at the cost of doubled wall-clock time —
  > acceptable because pre-bundle is fire-and-forget and runs in
  > the background.
- **Classification**: **YELLOW**. Width is by-construction 1, but
  the comments document it as a heap-budget tradeoff specifically
  forced by single-isolate constraints. Two-tier fan-out (each
  slice → its own peer DO) sidesteps the supervisor heap pressure
  entirely.

### 3. `src/npm/installer.ts:541` — resolver pool construction

```ts
// installer.ts:541-553
const pool = new NimbusLoaderPool(this.env, this.ctx!, {
  // One facet for the whole walk — the facet itself runs pLimit(6)
  // internally. Per the plan's topology choice; per-spec dispatch
  // would multiply cold-start costs across 456+ transitive deps.
  concurrency: 1,
  ...
  tag: 'npm-resolve',
});
```

- **Function**: `NpmInstaller.resolveTreeViaFacet`.
- **Fans out**: ONE facet runs the entire BFS over 50–500
  transitive deps, with internal `concurrency: 4` pLimit
  (clamped to ≤ 16, see resolve-facet.ts:226) over the
  `fetch()` to npm registry.
- **Width formula**: outer = 1 LOADER worker; inner =
  `min(queue.length, 4)` HTTP fetches inside that one facet.
- **Reasoning** (lines 542-544):
  > One facet for the whole walk — the facet itself runs pLimit(6)
  > internally. Per the plan's topology choice; per-spec dispatch
  > would multiply cold-start costs across 456+ transitive deps.
- **Classification**: **YELLOW**. The collapse-to-one-facet
  decision was a mitigation for the 4-per-method cap — fanning
  the BFS out to N peer DOs (each running its own resolver
  sub-tree) would scale linearly until N=8 (POC B's measured
  flat-to-32 zone).

### 4. `src/npm/installer.ts:653` — install-batch pool construction

```ts
// installer.ts:653-670
const pool = new NimbusLoaderPool(this.env, this.ctx!, {
  // ONE facet for the whole batch — collapses what was 4 concurrent
  // dynamic workers (pool.map slots) into 1. The facet itself runs
  // pLimit(3) to keep its heap peak under ~87 MiB inside its 128 MiB cap.
  concurrency: 1,
  ...
  tag: 'npm-install-batch',
});
```

- **Function**: `NpmInstaller.fetchViaBatchFacet`.
- **Fans out**: ONE facet processes the entire 50–500-package
  install batch with internal `pLimit(3)` over `fetch + gunzip + tar`
  pipelines.
- **Width formula**: outer = 1; inner = 3 (per
  install-batch-facet.ts:135).
- **Reasoning** (line 654 comment, EXPLICIT):
  > ONE facet for the whole batch — **collapses what was 4 concurrent
  > dynamic workers (pool.map slots) into 1**. The facet itself runs
  > pLimit(3) to keep its heap peak under ~87 MiB inside its 128 MiB cap.
- **Classification**: **YELLOW**. Strongest evidence in the codebase
  that a previously-RED site was retreated to YELLOW. Two-tier
  fan-out lets us go back to wide-and-fast: 8 peer DOs × 1 facet
  each = 8 concurrent install-batch workers, each handling its own
  package slice.

### 5. `src/npm/install-batch-facet.ts:534` — installPackagesInFacet body

```ts
// install-batch-facet.ts:534-536
const perPackage = await Promise.all(
  batch.packages.map((spec) => limit(() => installOne(spec))),
);
```

- **Function**: `installPackagesInFacet` (runs INSIDE the
  install-batch facet).
- **Fans out**: ONE Promise per package in the batch (50–500
  thunks), in-flight bodies gated by inline `pLimit(3)`.
- **Width formula**: Promise array length = `batch.packages.length`
  (unbounded by code); in-flight bodies = `min(spec.concurrency=3, 8)`.
- **Classification**: **GREEN** for the cap question. Runs inside
  one facet; `installOne` does `fetch` + `gunzip` + supervisor RPC,
  not LOADER spawns. Limiter strictly serializes the bodies.

### 6. `src/npm/resolve-facet.ts:670` — resolveTreeInFacet body

```ts
// resolve-facet.ts:668-739
while (queue2.length > 0) {
  const batch = queue2.splice(0, Math.min(queue2.length, concurrency));
  const results = await Promise.all(
    batch.map(([name, range]) => limit(async () => { ... }))
  );
}
```

- **Function**: `resolveTreeInFacet` (runs INSIDE the resolver facet).
- **Fans out**: per-BFS-round, fan-out over `min(queue.length, concurrency=4)`.
- **Width formula**: 4 (clamped, supplied by installer.ts:536).
- **Classification**: **GREEN**. Internal to ONE facet; doesn't
  multiply LOADER workers.

### 7. `src/npm/resolver.ts:637` — legacy in-supervisor resolver

```ts
// RESOLVE_CONCURRENCY = 6
const batch = queue.splice(0, Math.min(queue.length, RESOLVE_CONCURRENCY));
const results = await Promise.all(
  batch.map(([name, range]) => limit(async () => { ... }))
);
```

- **Function**: `resolveTree` (legacy, not on production path —
  installer.ts:237 calls `resolveTreeViaFacet` unconditionally).
- **Width formula**: ≤ 6.
- **Classification**: **GREEN** (≤ 6 by construction; supervisor-
  level `fetch()`, no LOADER multiplication).

### 8. `src/runtime/node-shims.ts:1743` — `__cpDrainAllChildren`

```ts
async function __cpDrainAllChildren() {
  const drains = [];
  for (const [pid, child] of __cpChildren) {
    drains.push((async () => { await __supervisor.cpDrainOutput(pid); ... })());
  }
  await Promise.allSettled(drains);
}
```

- **Function**: facet-side child-process drain (string-included into
  facet code via the SHIMS template).
- **Width formula**: N = live `__cpChildren.size` (typ. 1–8).
- **Classification**: **GREEN**. RPC fan-out, not LOADER spawn.

### 9. `src/facets/manager.ts:346, 357, 529, 536` — facet-template `Promise.allSettled(__pendingIO)`

These are all string templates embedded into generated facet code:

```ts
await Promise.allSettled(__pendingIO);
```

- **Function**: facet `run()` method (per-facet drain of supervisor RPC writes).
- **Width formula**: `__pendingIO.length` = total queued supervisor
  RPC writes (stdout/stderr lines + VFS writes) accumulated during
  one user-script run inside the facet — unbounded by user output.
- **Classification**: **GREEN**. Supervisor RPC drain, not LOADER
  spawn. The supervisor side serializes these on its single inbox
  per facet.

## Latent (vendored / dead-code) fan-out sites

`src/loaders/vendor/pool.ts` (`WorkerPool` class, vendored from
cloudflare-parallel) contains 9 `Promise.all` sites at lines 265,
297, 331, 358, 429, 438, 461, 528, 579. **None are reachable from
runtime code** — verified by grepping `import.*vendor` against the
worktree (only `loader-pool.ts` imports from `vendor/`, and only
`serializeFunction`, `hashSource`, error classes, and the
`WorkerLoader` type — never `WorkerPool`).

If wired in, lines 265 (`map` fast path) and 358 (`pmap`) would be
**CRITICAL** by code construction — uncapped `Promise.all` over
`items` / `chunks`. Today: **GREEN — DEAD CODE**. (Mitigation:
either delete the file or annotate the top with a "// LATENT —
wiring would risk Too many concurrent dynamic workers" block.)

## Summary table

| #  | File:Line                                  | Function                          | Width formula                                | Classification          |
|----|--------------------------------------------|-----------------------------------|----------------------------------------------|-------------------------|
| 1  | `src/loaders/loader-pool.ts:646`           | `NimbusLoaderPool.map`            | `min(concurrency=4 default, items.length)`   | **GREEN** (unused today)|
| 2  | `src/npm/installer.ts:1597`                | pre-bundle `runSlot` dispatch     | `PRE_BUNDLE_CONCURRENCY = 1`                 | **YELLOW** (heap-budget retreat from 2) |
| 3  | `src/npm/installer.ts:541`                 | resolveTreeViaFacet pool          | 1 outer × 4 inner pLimit                     | **YELLOW** (collapsed for cold-start cost) |
| 4  | `src/npm/installer.ts:653`                 | fetchViaBatchFacet pool           | 1 outer × 3 inner pLimit                     | **YELLOW** (explicit "collapsed from 4" comment) |
| 5  | `src/npm/install-batch-facet.ts:534`       | installPackagesInFacet body       | unbounded array, pLimit(3) bodies            | **GREEN** (in-facet, no LOADER fan-out) |
| 6  | `src/npm/resolve-facet.ts:670`             | resolveTreeInFacet body           | ≤ 4 per round                                | **GREEN** (in-facet)    |
| 7  | `src/npm/resolver.ts:637`                  | legacy resolveTree (off path)     | ≤ 6                                          | **GREEN**               |
| 8  | `src/runtime/node-shims.ts:1743`           | __cpDrainAllChildren (template)   | live child count, typ. 1–8                   | **GREEN** (RPC drain)   |
| 9  | `src/facets/manager.ts:346, 357, 529, 536` | facet-template `__pendingIO`      | total queued RPC writes (unbounded)          | **GREEN** (RPC drain)   |
| 10 | `src/loaders/vendor/pool.ts:265, 358, ...` | `WorkerPool.{map,pmap,...}`       | uncapped (when wired)                        | **DEAD** (CRITICAL if wired)|

## Headline findings

1. **Three YELLOW sites in `installer.ts` (#2, #3, #4)** are mitigations
   for the 4-per-method cap. Each collapses what could be a wide
   fan-out into a `concurrency: 1` LOADER pool with internal
   limiter. The mitigation works (zero-cap-failures observed in
   prod) but constrains throughput. Two-tier `NimbusFanoutPool`
   replaces the mitigation with a substrate that scales beyond 4
   safely.

2. **The strongest signal** is at site #4 (install-batch). The code
   comment at line 654 EXPLICITLY says "collapses what was 4
   concurrent dynamic workers (pool.map slots) into 1" — this site
   was previously RED, was retreated to YELLOW, and is the prime
   candidate for two-tier fan-out re-expansion.

3. **No CRITICAL sites in live code.** The `concurrency: 1` retreat
   forecloses the failure mode entirely.

4. **Vendor pool is latent risk.** If `WorkerPool` is ever
   wired in (e.g. by a contributor unaware of the cap), lines 265
   and 358 produce `Too many concurrent dynamic workers` immediately
   on a 5+ item input. Document or delete.

## Win-shape preview

(Detailed ranking lives in `audit/sections/FANOUT-WINS.md`.)

| Win  | Site            | Strategy                                                                  | Predicted speedup |
|------|-----------------|---------------------------------------------------------------------------|-------------------|
| F-1  | installer.ts:653 (install-batch) | 1 LOADER pool → N peer-DO siblings (POC B), 1 loader each      | up to 7.75× at N=8 |
| F-2  | installer.ts:541 (resolver)      | same; BFS sub-tree per peer DO                                  | similar (network-bound, expect ~3-5×) |
| F-3  | installer.ts:1597 (pre-bundle)   | per-spec → peer DO (POC B); supervisor heap pressure drops to 0 | 4× at N=4 (POC C in-DO is sufficient — 5+ specs are rare) |
