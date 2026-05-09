# cache-and-scrub progress

## Brief
Two-part wave on `cache-and-scrub` off `origin/main` @ `5dc9a54`.

**Part A** — Workers Cache API audit + hot-path optimization.
**Part B** — Cloudchamber-container scrub.

## Phases
- [x] Setup worktree + wrangler dev on 8793 (tsc baseline: 2)
- [x] P0 progress.md (a94fcd9)
- [x] P1 cache audit (fa758c6) — `audit/sections/CACHE-AUDIT.md`
- [x] P2 wins ranking (efc3ada) — `audit/sections/CACHE-WINS.md`
- [x] P3 L2 cache impl (a1a8064) — shared W-A + W-B + W-D substrate
- [x] P3a W-A packument probe (c3410da) — 6.5×–19× ratios
- [x] P3b W-B tarball probe (e7c6ae5) — 7×–11× ratios
- [x] P3c W-D esbuild-wasm probe (c16ebec) — 6.36×–20.6× ratios
- [x] P4 README scorecard update (00d0ddf)
- [x] P5 Cloudchamber scrub (f418127) — 7 audit/sections/* files
- [x] P6 cross-wave + tsc + bug 1/2 probes (5b6a946) — 28/1 (1 pre-existing)
- [x] P7 retro at `audit/sections/CACHE-AND-SCRUB-retro.md`

## Final state
- tsc baseline: 2 errors (unchanged from main)
- 3 cache probes GREEN (W-A, W-B, W-D)
- Phase 5 regression: 28 PASS, 1 FAIL (D'.1 pre-existing on main),
  0 SKIP, 0 TIMEOUT
- src/ touch: 3 files (npm/r2-cache.ts, runtime/esbuild-wasm-bytes.ts,
  session/routes.ts — last is test endpoint only)
- 7 docs files scrubbed of Nimbus-future-Cloudchamber framing
- 0 cross-wave regressions

## Anti-requirements honored
- ≥5× latency drop measured per win on hit (probe stability runs
  consistently above target)
- TTLs justified at strip site (packument 5min mirroring R2 customMetadata;
  tarball/wasm eternal immutable per content-addressed semantics)
- All payloads under 50 MiB (max 30 MiB tarball cap, 12 MiB wasm,
  ~10 MiB observed packument)
- No new src/ behavior beyond cache + scrub
- No setTimeout / sleep / retry — V8 microtask ordering enforces
  L2-fill-before-subsequent-reads via awaited L2 put
- No fire-and-forget L2 writes
- Branch ready for merge to main
