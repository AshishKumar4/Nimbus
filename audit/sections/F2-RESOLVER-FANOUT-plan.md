# F-2 Resolver Fan-Out — Plan (IMPLEMENT, no defer)

Status: implement frontier-coordinator wrapping `NimbusFanoutPool`.

## §1 Background

The two-tier-fanout wave (commits `ca6d7c0..e81790b`) deferred F-2 with
the rationale: *"BFS over peer DOs needs frontier coordination across
DOs (level k+1 packuments derive from level k's resolved versions).
Architectural scope > this wave's charter."*

That defer was a vibe. cleanup-not-done's charter (course-corrected
mid-wave): **F-2 must be implemented**. Profiling stays as input to the
width policy, not as a rationale for skipping the work.

## §2 Architecture choice — coordinator at supervisor, fan out per package

The current resolver runs entirely **inside one resolve-facet** (a
single Worker Loader isolate). Inside that facet, a closure-style
`resolveOne` runs with `pLimit(concurrency=4)`. Layer width is bounded
by `Math.min(queue.length, concurrency=4)`. Effective concurrency: 4.

F-2 (this wave) replaces that with:

```
supervisor (NimbusSession DO)
  while frontier non-empty:
    submitMany(layerTasks, resolveOnePackumentTask)   ← fanout-pool routes
      ├── width <  5  →  POC C: in-DO loader-pool, concurrency = width
      └── width >= 5  →  POC B: N peer DOs, each runs its own loader-pool
    merge per-package results → cache writes, messages, events, edges
    build next layer = ⋃ edges \ seen
```

Each submitMany task body is a **self-contained**
`resolveOnePackument(name, range)`:

- Receives `{name, range, cachedHit}` (cachedHit = pre-fetched
  cache entry if supervisor saw one).
- Fetches packument over `fetch()` if `cachedHit` absent.
- Picks version via inlined semver helpers.
- Returns
  `{ pkg: ResolvedPackage|null, deps: [{name,range}], optionalDeps: [...],
     peerDeps: [...], cacheWrites: [...], messages: [], events: [] }`.

Supervisor stitches:

- `seen.add(name)` after each task completes.
- Cache writes batched, flushed once at the end of the entire walk.
- `messages` forwarded to install log.
- `events` forwarded to telemetry sink.
- Next layer = `(union of deps + peerDeps + optionalDeps where in topLevel)
   − seen`.
- Cycle detection unchanged (the `seen` set is supervisor-side now).

Stable-id router: `task.key = packageName` so repeated installs of
the same package map to the same peer DO → warm packument cache wins.

## §3 Width policy

Based on the existing measurement infra (`[f2-layer-width]` diag emit
from src/npm/resolver.ts and src/npm/resolve-facet.ts), the per-layer
width distribution will drive *which* packages benefit most. But the
implementation does NOT condition on width — it always uses
`NimbusFanoutPool.submitMany`, which auto-routes `<5` to in-DO
(concurrency=width, capped at 4) and `>=5` to peer-DO (N = min(width,
32)).

That auto-route IS the width policy. Profile data tells us the
distribution; routing is deterministic from each layer's width at
runtime.

## §4 Anti-requirements

- NO `setTimeout` / `sleep` between layers. The coordinator awaits
  layer N before submitting N+1; that's it.
- NO fallback to the single-facet path on missing bindings — same
  posture as F-1: missing env.LOADER throws at construction; missing
  env.NIMBUS_SESSION (peer-DO leg) throws at submitMany.
- NO `concurrency` knob on the supervisor side. NimbusFanoutPool's
  built-in `IN_DO_THRESHOLD=5` and `MAX_PEER_FANOUT=32` are the only
  knobs.
- NO speculative pre-fetch of layer N+1 during layer N. Frontier
  coordinator IS the architecture; speculation reintroduces the
  cycle-correctness problem the original defer was worried about.
- NO predicted-GREEN claims. Speedup is measured against the serial
  baseline.

## §5 Probes

Phase A — RED:
- `audit/probes/f2-resolver-fanout/functional/f1-frontier-coordinator-shape.mjs`
  asserts the supervisor exports a frontier-coordinator entry point.
  RED before implementation.
- `audit/probes/f2-resolver-fanout/functional/f2-task-shape.mjs`
  asserts the per-package task body is self-contained (no closure
  references) and has the documented return shape.

Phase B — instrumentation already in place (this wave's earlier
commit added `[f2-layer-width]` diag emit lines in resolver.ts and
resolve-facet.ts). Verified working with the zod single-package
profile run.

Phase C — baseline + post-fix profiling:
- `audit/probes/f2-resolver-fanout/profile-layer-widths.mjs`
  (already written) drives an 8-package cohort representative of the
  top-30. Captures `[f2-layer-width]` lines AND wall time per package.
- Run BEFORE the implementation (records `serial` baseline) and
  AFTER (records `frontier-coordinator` numbers). Diff shows speedup.

Phase D — regression: full phase5-regression cohort GREEN at every
commit, +1 X.5-U probe (post-Item-1). tsc baseline (2 errors)
preserved.

## §6 Acceptance gate

- All probes GREEN.
- `phase5-regression/run-all.mjs` 35/35 PASS preserved.
- Measured speedup ≥1.5× on AT LEAST ONE wide-tree package (vite OR
  webpack OR next OR jest), or documented reason why every package's
  resolver wall time was already <5s (in which case there's no room
  for speedup and we accept the routing-correctness win without
  asserting wall-time improvement).
- No tsc regression (baseline 2 errors).

## §7 What this wave deliberately does NOT touch

- `src/loaders/fanout-pool.ts` — primitive is reused as-is. No
  IN_DO_THRESHOLD or MAX_PEER_FANOUT change without a separate audit.
- `src/npm/installer.ts:fetchViaBatchFacet` — F-1 install-batch is
  already two-tier. F-2 is only the resolver leg.
- `src/npm/cache.ts` — NpmCache is supervisor-side; cache writes get
  batched and flushed in one pass at end of resolve, same as today.
