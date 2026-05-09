# F-2 Resolver Fan-Out — Retro

Status: SHIPPED. Two-tier-fanout's deferred F-2 is closed.

## §1 What landed

| File | Lines | Purpose |
|------|-------|---------|
| `src/npm/resolve-one-facet.ts` (new) | 350 | Per-package fanout task body — self-contained, exported as `resolveOnePackumentInFacet`. Fetches packument (R2 race + retry), picks version via preamble RESOLVE_VERSION, returns `{pkg, deps, peerDeps, optionalDeps, allPeerDependencies, cacheWrites, messages, events, packumentBytesDecoded, packumentSource, error?}`. W6 swap/warn/reject decisions inside the task. |
| `src/npm/installer.ts` | +290 / 0 deletions | New private `resolveTreeViaFanout`. Frontier loop: for each BFS layer, dedupe + pre-load per-name cache slice (top-16) → build fanout tasks (key=name) → `await NimbusFanoutPool.submitMany` → stitch results into supervisor state. End-of-walk: ONE batched `cache.putRegistryEntries` flush. |
| `src/npm/installer.ts` | dispatcher | `install()` switches between `resolveTreeViaFacet` (legacy single-facet) and `resolveTreeViaFanout` (F-2) via env `NIMBUS_RESOLVER_PATH=facet|fanout`. Default `fanout`. The legacy path lives ONLY for A/B profile measurement; not a runtime auto-fallback. |
| `src/npm/resolver.ts`, `src/npm/resolve-facet.ts` | minimal | `[f2-layer-width]` diag emit for measurement (kept for future audits; not required by F-2 path). |
| `audit/probes/f2-resolver-fanout/` | 6 files | Functional shape probes (RED → GREEN), profile + comparison drivers, per-package logs and rendered SUMMARY/COMPARISON.md. |

## §2 Architecture

```
supervisor (NimbusSession DO)
  while frontier non-empty:
    layer = dedupe(frontier)                                    ← supervisor-side seen set
    tasks = [{ key: name, args: { name, range, cachedEntries:
                                  cache.getRegistryVersions(name).slice(0,16),
                                  topLevel, isOptional, frameworkAware,
                                  fetchTimeoutMs, retries } } …]
    results = await fanoutPool.submitMany(tasks, resolveOnePackumentInFacet)
    for each result:
      forward messages + events
      apply X.5-G G1 native-binding silent-skip
      apply X.5-drizzle best-effort silent-skip on W6 reject
      apply X.5-F R2.5 + X.5-J optional-peer enqueue when topLevel
      enqueue (deps + required-peerDeps + optionalDeps) \ seen
  flush cache.putRegistryEntries(cacheWritesPending)
```

NimbusFanoutPool's auto-route handles the width policy:

- `width < 5`  → POC C in-DO loader-pool (concurrency = width, capped at 4).
- `width >= 5` → POC B peer-DO (N peers = `min(width, MAX_PEER_FANOUT=32)`),
                each peer runs its own loader-pool (concurrency 4) over its shard.

Stable-id router: `task.key = packageName` so re-installs hit warm peers
(R2 packument cache locality).

## §3 Measurements

### §3.1 Layer-width distribution (5-package representative cohort)

`audit/probes/f2-resolver-fanout/SUMMARY.md` (auto-generated):

| Package | Layers | Max width | p95 width | Avg width | Resolver wall (s) |
|---------|--------|-----------|-----------|-----------|-------------------|
| vite | 2 | 18 | 18 | 9.5 | (n/a — first-cold-install lost diag line) |
| webpack | 5 | 24 | 24 | 14 | 2.4 |
| drizzle-orm | 12 | 156 | 156 | 51.92 | 20.5 |
| express | 7 | 28 | 28 | 9.71 | 1.0 |
| zod | 1 | 1 | 1 | 1 | 0.1 |

Aggregate over 27 measured BFS layers: **max width 156, p95 134, median
12, mean 28.93**. Of 27 layers, 16 (59%) routed peer-DO, 11 (41%) in-DO.

### §3.2 Speedup vs serial baseline

`audit/probes/f2-resolver-fanout/COMPARISON.md` (auto-generated):

| Package | facet (baseline) | fanout (F-2) | Speedup × |
|---------|------------------|--------------|-----------|
| webpack | 2.6 s | 1.1 s | **2.36×** |
| drizzle-orm | 28.4 s | 9.0 s | **3.16×** |
| express | 1.0 s | 0.8 s | 1.25× |
| zod | 0 s | 0 s | n/a (sub-second on both) |

Measurements taken against in-tree wrangler-dev with `NIMBUS_DEBUG=1
NIMBUS_DIAG_INSTALL_PIPELINE=1` and a flipped `NIMBUS_RESOLVER_PATH=facet`
binding for the baseline pass. Average speedup across measurable rows:
**2.26×**. drizzle-orm — the wave's regression target with X.5-drizzle
best-effort optional-peer subtree handling — is **3.16×** faster.

The acceptance gate (≥1.5× on at least one wide-tree package) is met
by webpack AND drizzle-orm.

## §4 Anti-requirements observed

- ✅ **No setTimeout/sleep between layers.** The frontier loop awaits
  `submitMany` and synchronously builds the next layer.
- ✅ **No fallback to single-facet on missing bindings.**
  NimbusFanoutPool throws BindingError at construction (missing
  env.LOADER) or at the first wide submitMany (missing
  env.NIMBUS_SESSION). There is no try/catch that drops to
  `resolveTreeViaFacet` on bind failure.
- ✅ **Speedup measured, not predicted.** The COMPARISON.md table is
  generated from real wrangler-dev runs; numbers above are verbatim.
- ✅ **No new files outside the worktree until merge-ready.**
- ✅ **No silent completion.** Per-layer diag + per-walk summary in
  install log when NIMBUS_DIAG_INSTALL_PIPELINE=1.

## §5 What this wave deliberately did NOT touch

- `NimbusFanoutPool` primitive (`src/loaders/fanout-pool.ts`). Reused as-is.
  IN_DO_THRESHOLD=5 and MAX_PEER_FANOUT=32 unchanged.
- `src/npm/resolve-facet.ts`. Retained for the A/B baseline measurement
  path; will be deleted in a follow-up retro commit once F-2 has
  multi-day prod soak.
- `src/npm/resolver.ts:resolveTree`. Old supervisor-side BFS path, not
  reachable in production (every install path goes through
  resolveTreeViaFacet/Fanout). Kept for the X.5-F single-resolver
  invariant probe; deletion is a separate audit.
- F-1 install-batch-facet pipeline. F-2 is only the resolver leg.
- F-3 in-DO POC-C structural site (already shipped two-tier-fanout).

## §6 Risks accepted

| Risk | Mitigation |
|------|------------|
| Per-package R2 cache writes from N peers can race on the same name across layers | The cache is supervisor-owned; each peer-DO returns its `cacheWrites` array, the supervisor batches them and flushes ONCE at end-of-walk. No cross-peer race. |
| NIMBUS_SESSION binding missing in older deploys | Throws BindingError at first wide-layer submitMany. Anti-requirement: no fallback. Matches F-1 posture. Action: deploy time fixes wrangler.jsonc; if a deploy ships without it, install fails loud. |
| Cycle in dep graph → infinite frontier | `seen` is supervisor-side, `seen.add(name)` happens BEFORE the layer's submit. Identical cycle invariant to legacy resolveTreeViaFacet. |
| W6 reject inside a best-effort subtree fires after task return | Supervisor inspects `result.error.type === 'w6-reject'`, checks `bestEffortNames.has(taskName)`, silent-skips OR throws. Mirrors resolve-facet.ts:716. |
| Ordering: layer task results land out-of-order | NimbusFanoutPool returns results in input order. Edge extraction iterates `for (let i; …; i++)` over `results[i]` paired with `layer[i]` — order is preserved. |
| `__allPeerDependencies` non-stripped on cache hits | Task result returns the field on `pkg` (rebuilt via `versionToResolved`); supervisor reads `(pkg as any).__allPeerDependencies` — same shape as legacy facet. |

## §7 Probes

| Probe | Tier | Verdict |
|-------|------|---------|
| `f1-frontier-coordinator-shape.mjs` | functional | 7/7 PASS |
| `f2-task-shape.mjs` | functional | 17/17 PASS |
| `profile-layer-widths.mjs` | profiling | 27 layers captured, all 5 packages on `path=fanout` |
| `compare-paths.mjs` (facet+fanout+summary) | A/B | 2.26× average, 3.16× peak (drizzle-orm) |

Wired into `audit/probes/phase5-regression/run-all.mjs` as the F-2 pair
(structural). Phase5-regression: **37/37 PASS** preserved.

tsc baseline: 2 errors preserved (esbuild-wasm.wasm + SqliteVFSProvider).

## §8 Commits

| SHA | Phase | Description |
|-----|-------|-------------|
| `32a3e79` | A+C-RED | plan + RED probes + diag emit (resolver.ts, resolve-facet.ts) |
| `e2a6544` | B | implement frontier-coordinator (resolve-one-facet.ts + resolveTreeViaFanout) + wire +2 probes into phase5-regression |
| (this) | D | retro + COMPARISON + env-toggle for A/B baseline + 2.26× measured speedup |
