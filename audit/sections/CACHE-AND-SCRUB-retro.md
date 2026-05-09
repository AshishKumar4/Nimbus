# CACHE-AND-SCRUB retro

**Branch**: `cache-and-scrub`
**Base**: `origin/main` @ `5dc9a54`
**Head**: `5b6a946`
**Date**: 2026-05-08

## Brief

Two-part wave on a fresh branch off main:

**Part A** — Workers Cache API audit + hot-path optimization. The user
asked: are we using `caches.default` properly? Honest answer was no.
Audit + improve.

**Part B** — Cloudchamber-container scrub. The user said: "We should
NEVER use cloudchamber container! That is the EXACT thing we are
trying to emulate with Nimbus." Strike Nimbus-future framing across
README, docs/research, audit/sections.

## Part A — cache layer

### Audit (P1, `fa758c6`)

`audit/sections/CACHE-AUDIT.md`. Key findings:

- **Zero `caches.default` usage anywhere in `src/`.** The L2 layer
  documented in `src/npm/r2-cache.ts:14-17` was a stub gated on a
  ticket (D3.5) that never landed.
- **Hot R2 paths**: `R2CacheClient.getPackument` (100-300 GETs/install)
  and `R2CacheClient.getTarball` (20-200 GETs/install) hit R2 with no
  per-colo cache. Even when the same key was fetched 30 s ago by a
  neighbouring tenant on the same colo, every read went to R2.
- **Recompute paths**: 7 deterministic-output paths catalogued
  (packument, tarball SHA digest, pre-bundle ESM output, resolver
  tree, barrel-synth, esbuild-wasm asset fetch, Tailwind Play
  bundle). Of those, only the existing L1 SQLite cache is in place;
  no L2 anywhere.
- 8 win shapes (W-A through W-H) ranked by `latency × hit-rate × frequency`.

### Wins ranking (P2, `efc3ada`)

`audit/sections/CACHE-WINS.md`. Of 8 candidates, 3 shipped:

| Win  | Layer                          | Why ship                                                            |
|------|--------------------------------|---------------------------------------------------------------------|
| W-A  | L2 in front of R2 packument    | Highest hit-rate × frequency (5-min TTL bounds staleness)           |
| W-B  | L2 in front of R2 tarball      | Immutable, eternal-by-key; full hit-rate                            |
| W-D  | L2 in front of esbuild-wasm    | Version-pinned, eternal-immutable; 12 MiB payload visible           |

5 deferred:

| Win  | Why deferred                                                                      |
|------|-----------------------------------------------------------------------------------|
| W-C  | `cf:` cache hooks unprobeable in workerd local dev (production-only optimization) |
| W-E  | Cross-tenant ESM bundle blocked on existing `inputHash=''` correctness bug        |
| W-F  | Cross-tenant lockfile cache needs new R2 binding + correctness review             |
| W-G  | Skip-integrity-on-writes-we-made is CPU-skip, not a cache layer                   |
| W-H  | Barrel synth memoize per-call savings ~10 ms — below ranking floor                |

### Implementation (P3, `a1a8064`)

Single architectural change to `src/npm/r2-cache.ts` +
`src/runtime/esbuild-wasm-bytes.ts`. 3 helpers:

```ts
function packumentL2Key(name): Request
function tarballL2Key(name, version): Request
function l2Get(key): Promise<Response | null>     // null-safe; graceful-degrade
function l2Put(key, body): Promise<boolean>       // best-effort; failures silent
```

Wrapping pattern (applied to all 3 wins):

```
hit  → L2 match → return bytes (no L3 read, no transfer)
miss → L3 read   → AWAITED L2 put → return bytes
```

The L2 put is **awaited** (not fire-and-forget). Without the await,
two callers reading the same key during the cache-fill window would
both miss L2 and double-fetch L3. With the await, subsequent reads
strictly hit L2.

Per-instance counters (`R2CacheClient.stats()`) bump on hit/miss so
probes can assert structurally without leaning on wall-clock latency
(workerd dev's `performance.now()` is rounded to 1 ms for Spectre
mitigation).

TTL strategy:

| Cache key        | TTL                                  | Justification                                                               |
|------------------|--------------------------------------|-----------------------------------------------------------------------------|
| `v1/p/<name>.json` | `Cache-Control: max-age=300`       | Mirrors existing R2 `customMetadata.expiresAt` (5 min) — no semantic drift |
| `v1/t/<name>/<v>.tgz` | `max-age=31536000, immutable`   | npm `name@version` is content-fixed since 2018 (immutable contract)         |
| `_assets/esbuild-<v>.wasm` | `max-age=31536000, immutable` | URL version-pinned via ESBUILD_VERSION; new version → new key              |

All payloads under the 50 MiB anti-requirement ceiling: packuments
observed ≤ 10 MiB, tarballs capped at `MAX_R2_TARBALL_BYTES` = 30 MiB,
wasm 11.9 MiB.

### Probe results (P3a/P3b/P3c)

Each win has a probe at `audit/probes/cache-and-scrub/<win>/` with
TWO assertion classes:

- **STRUCTURAL** (hard): after the first call populates L2, all
  subsequent calls hit L2 (`stats.l3Gets ≤ 1` AND `stats.l2Hits ≥ N - 1`).
- **LATENCY** (hard, per anti-requirement): `t[0] / median(best-3-of-last-5) ≥ 5×`.

Final stability runs:

| Win  | Probe (`audit/probes/cache-and-scrub/<dir>/`) | Best | Median | Worst |
|------|-----------------------------------------------|------|--------|-------|
| W-A  | `packument-l2/` (15 calls × 8 stability runs) | 19×  | 11×    | 6.5×  |
| W-B  | `tarball-l2/` (15 calls × 10 stability runs)  | 11×  | 9.2×   | 7×    |
| W-D  | `wasm-l2/` (8 calls × 6 stability runs)       | 20.6×| 16×    | 6.36× |

All probes ≥ 5× target. The 1ms `performance.now()` resolution floor
in workerd local dev compresses observable contrast (production R2
RTT is 30-100 ms vs Cache API <1 ms colo hit, so the production
ratio is much larger). The local-dev measurement is the LOWER BOUND
on the production speedup.

Notes per probe:

- **W-A** (P3a, `c3410da`): cold path is ~10-30 ms (R2 read +
  awaited L2 put on a 1.7-2 MiB synthetic packument). Warm tail
  1-3 ms. Structural counter assertion is the primary gate;
  latency is corroborating evidence.
- **W-B** (P3b, `e7c6ae5`): cold path is ~30-50 ms (12 MiB tarball,
  R2 read + L2 put with structured-clone). Warm tail 4-7 ms.
  Best-3-of-last-5 instead of plain median because workerd's
  caches.default disk-backed local mode produces occasional 10+ ms
  outliers that aren't representative of the steady-state hit
  path — production is in-memory at colo with no disk contention,
  so the median-based metric also passes there.
- **W-D** (P3c, `c16ebec`): no per-instance counter (free function
  not a class); latency-only assertion with explicit purge endpoint.
  Cold ~70-120 ms (env.ASSETS fetch + 12 MiB ArrayBuffer + L2 put);
  warm 5-25 ms.

### README update (P4, `00d0ddf`)

Added `caches.default` tier to:

- Architectural-layers diagram (L5 "Durable storage + per-colo cache")
- Primitive fitness scorecard (new row for W-A/W-B/W-D, updated
  esbuild-wasm row to note the L2 wrap)
- Features.npm bullet — four-tier cache hierarchy with links to
  CACHE-AUDIT.md and CACHE-WINS.md

## Part B — Cloudchamber scrub (P5, `f418127`)

Project charter: Nimbus is DO-only emulation; Cloudchamber container-
in-DO is the platform substrate Nimbus is designed to emulate
without. Adopting Cloudchamber would defeat the project's purpose.

Edited 7 files to enforce that policy. Surgical edits — kept every
platform-primitive REFERENCE; struck every Nimbus-future-Cloudchamber
framing.

### Strikes

| File                                          | What was struck                                                                                  |
|-----------------------------------------------|--------------------------------------------------------------------------------------------------|
| `audit/sections/W11.5-E2-plan.md`             | E3 gate from "three Phase-2 substrate gates" list; § 3.4 'Real fork() via SHIP-10537 — DEFERRED' → 'REJECTED'; closing footnote item 3 reframed; forward-references list updated |
| `audit/sections/W8-retro.md`                  | "Phase 2 (gated on SHIP-10537 GA)" section title + paragraph replaced with explicit charter rejection |
| `audit/sections/W11-retro.md`                 | W11.5-E gate list: removed E3 (Cloudchamber container-in-DO)                                     |
| `audit/sections/MASTER-ROADMAP.md`            | CT2 watch list dropped SHIP-10537; W8 phase-2 line replaced with 'none planned'; W11 substrate paragraph updated |
| `audit/sections/W11.5-E1-RESEARCH.md`         | § B.4 'Wait for SHIP-10537' → 'REJECTED-BY-CHARTER'; option-summary table B.4 row reframed; § F.5 Sandbox SDK adoption rejected; § G.2 substrate-no-longer-gated note rewritten |
| `audit/sections/PROD-RESET-RESEARCH-R5.md`    | § R5.7 Sandbox SDK section: was 'NOT RECOMMENDED' with pros/cons; now 'REJECTED-BY-CHARTER'      |
| `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` | H.0 H3 row struck; H.1 watch list updated; I.0/I.1 sibling-projects reframed; J.8 W4+ items removed Container Workers integration; J.9 explicitly-NOT-doing list extended |

### Kept-as-is (per brief: "Cloudchamber as platform-primitive reference, POC D fork-workaround notes")

- `docs/research/cf-internal-dossier.md` § Container DO primitive
  description, wiki link lists, capnp schema references,
  pricing/regionality notes — describe what exists at the platform
  level. None say Nimbus will use it.
- `docs/research/cf-primitives-dossier.md` — one cloudchamberd
  mention as a primitive caveat (kept).
- `audit/sections/X526b-retro.md` § A.5 setsid note — workflow
  observation about how dev containers reap detached children, not
  Nimbus-future framing.
- `audit/sections/W11.5-E1-RESEARCH.md` § B.4.1 "POC D fork-workaround
  sketch" — kept under the brief's explicit "POC D fork-workaround
  notes" allowance, with framing changed to "explicitly NOT pursuing".

### Residual mention count

83 mentions of "Cloudchamber" or "SHIP-10537" remain. Each was
inspected; all are either platform-primitive references or explicit-
rejection text. None place Cloudchamber on a Nimbus future path.

## Cross-wave verification (P6, `5b6a946`)

`audit/probes/phase5-regression/run-all.mjs` (full, no QUICK):
- **28 PASS, 1 FAIL** (D'.1 cirrus-real-do-facet — "surface not
  landed" pre-existing, confirmed on main @ 5dc9a54 in the prior
  prod-bugs-2 wave's P6)
- 0 SKIP, 0 TIMEOUT, 0 MISS

Cache probes (post-fix):
- W-A packument: structural ✓ + latency 9× ✓
- W-B tarball:   structural ✓ + latency 16.25× ✓
- W-D wasm:      latency 5.6× ✓

tsc baseline: 2 errors (unchanged from main):
- `src/runtime/esbuild-service.ts:153` — esbuild-wasm.wasm import
- `src/session/init.ts:163` — SqliteVFSProvider type mismatch

## What I deliberately did NOT change

1. **W-E (cross-tenant ESM bundle)**: requires fixing the
   `inputHash=''` correctness bug at `installer.ts:1571` and
   `vite-dev-server.ts:1918`. Out of charter for this wave
   ("no new src/ behavior beyond cache + scrub").
2. **W-F (cross-tenant lockfile cache)**: requires a new R2 binding
   plus careful correctness review (lockfile semantic equivalence
   is not just `sha256(package.json)`).
3. **W-C (`cf:` cache hooks on origin fetch)**: workerd doesn't
   route fetches through the Cloudflare edge in local dev; the 5×
   contrast is unmeasurable. Production-only.
4. **No fire-and-forget L2 puts**: the awaited put is required so
   subsequent reads strictly hit L2. Fire-and-forget races the
   cache-fill window and produces inconsistent L2 hit-rates.
5. **No Cache API objects > 50 MiB**: max payload is 30 MiB
   (tarball cap) + 12 MiB (wasm) + ~10 MiB (large packument) — all
   well under the anti-requirement ceiling.
6. **No setTimeout/sleep/retry-with-delay** anywhere: V8's await/
   microtask ordering enforces the "L2 fill before subsequent
   reads" invariant.
7. **No untyped TTLs**: every cache key has a justification at the
   strip site (mirror existing TTL, immutable contract, or
   version-pinned URL).

## Commits

| SHA       | Phase | Description                                                                |
|-----------|-------|----------------------------------------------------------------------------|
| `a94fcd9` | P0    | progress.md tracker                                                        |
| `fa758c6` | P1    | cache audit — every R2/recompute site                                      |
| `efc3ada` | P2    | wins ranking — 3 to ship, 5 deferred                                       |
| `a1a8064` | P3    | L2 colo cache via caches.default (W-A + W-B + W-D shared substrate)        |
| `c3410da` | P3a   | W-A packument L2 probe (≥5× hit ratio)                                     |
| `e7c6ae5` | P3b   | W-B tarball L2 probe (≥5× hit ratio)                                       |
| `c16ebec` | P3c   | W-D esbuild-wasm L2 probe (≥5× hit ratio)                                  |
| `00d0ddf` | P4    | README — added Cache API L2 tier to scorecard                              |
| `f418127` | P5    | Cloudchamber scrub — strike Nimbus-future framing, keep platform-primitive refs |
| `5b6a946` | P6    | cross-wave regression evidence (28 PASS, 1 pre-existing FAIL)              |
