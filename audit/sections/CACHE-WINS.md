# CACHE-WINS — ranking + ship/pass decisions (Part A, P2)

**Source data**: `audit/sections/CACHE-AUDIT.md`.

## Scoring rubric

`score = latency_saved_ms × hit_rate × frequency_per_install`

A win SHIPS if and only if a probe shows a **measured ≥5× latency
drop on hit** (per the wave's anti-requirements). No measurement,
no ship.

## Ranking

| Rank | Win  | Predicted hit-rate | Per-install freq | Saved per hit                  | Score                  | Decision                |
|------|------|--------------------|------------------|--------------------------------|------------------------|-------------------------|
| 1    | W-A  | 0.9 (5-min TTL)    | 100–300          | 30–100 ms (R2 RTT)             | **5,400 – 27,000**     | **SHIP**                |
| 2    | W-B  | 0.8 (immutable, eternal) | 20–200    | 30–100 ms × payload (RTT + transfer) | **480 – 16,000**  | **SHIP**                |
| 3    | W-D  | 0.95 (version-pinned) | 1–4           | 5–50 ms (ASSETS fetch)         | **5 – 190**            | **SHIP** if probe ≥5×; small but pure-cache shape |
| 4    | W-C  | 0.5 (origin TTL coverage)| 100–500    | 50–500 ms (origin RTT) when L1+L3 miss | **2,500 – 125,000** in cold-DO scenario | **SKIP — Cf-cache hooks unproven in workerd local dev**; can't measure ≥5× without a deployed test |
| 5    | W-G  | 1.0 on R2 hits we wrote | 20–200       | 5–50 ms CPU                    | **100 – 10,000**       | **SKIP — CPU-bound, not a cache layer** (would need separate measurement protocol; out of charter) |
| 6    | W-H  | 0.7 (per-session)  | 1–10             | ~10 ms                         | **7 – 70**             | **SKIP — too low** |
| 7    | W-E  | high but blocked   | 5–30             | 100–1000 ms (esbuild bundle CPU)| —                      | **SKIP — blocked on `inputHash=''` correctness fix; out of charter** |
| 8    | W-F  | high               | 1                | ~1–5 s (whole resolve phase)   | —                      | **SKIP — needs new R2 binding + correctness considerations; out of charter** |

## Top three to implement

### W-A — `caches.default` in front of R2 packument GET

**Strip site**: `src/npm/r2-cache.ts:222` (`getPackument`).

**Cache key**: `https://nimbus-cache.invalid/v1/p/<encodeURIComponent(name)>.json`
(Cache API requires `Request` keys; we synthesize a synthetic URL).

**TTL justification**:
- The R2 object already encodes the TTL via `customMetadata.expiresAt`.
- We mirror that on the cache layer with `Cache-Control: public, max-age=300`.
  5 min matches the existing R2 TTL (no semantic drift).
- On hit, we also re-check the wrapped Response for stale-by-`expiresAt`
  to guarantee the cached bytes still satisfy the freshness invariant
  (defense if the colo cache extends the entry beyond `max-age`).

**Hit path**: `caches.default.match()` → 200 → return bytes (no R2 GET).
**Miss path**: R2 GET → on hit, populate `caches.default.put()` (write-through).

**Probe predictions**:
- Pre-fix: every `getPackument` call is one R2 round-trip even on
  warm-colo same-key reads.
- Post-fix: second + subsequent reads in the same isolate session
  hit `caches.default` (no R2 GET).

**Probe shape**: time N=10 sequential `getPackument` calls for the
same key; assert `t[1..N]` median is ≥5× faster than `t[0]`.

### W-B — `caches.default` in front of R2 tarball GET

**Strip site**: `src/npm/r2-cache.ts:162` (`getTarball`).

**Cache key**: `https://nimbus-cache.invalid/v1/t/<encodeURIComponent(name)>/<version>.tgz`.

**TTL justification**:
- Tarballs are content-addressed by `name@version` (immutable npm contract).
- `Cache-Control: public, max-age=31536000, immutable`.
- No risk of staleness; eternal-by-key is the correct semantics.

**Hit path**: `caches.default.match()` → 200 → bytes (no R2 GET, no
egress).
**Miss path**: R2 GET → write-through.

**Size cap**: tarballs are bounded at 30 MiB by R2.put policy; well
under the 50 MiB ceiling. Workers Cache API per-object cap is much
higher (512 MiB default).

**Probe shape**: time N=5 sequential `getTarball` calls for the same
small known tarball; assert second-and-after are ≥5× faster.

### W-D — `caches.default` in front of `env.ASSETS.fetch(esbuild-wasm)`

**Strip site**: `src/runtime/esbuild-wasm-bytes.ts:78-91`.

**Cache key**: `https://nimbus-cache.invalid/_assets/esbuild-${ESBUILD_VERSION}.wasm`.

**TTL justification**:
- Asset bytes are version-pinned via `ESBUILD_VERSION` baked into the
  URL. New ESBUILD_VERSION → new cache key, old key naturally evicts
  on TTL.
- `Cache-Control: public, max-age=31536000, immutable`.
- 11.9 MiB is well under the 50 MiB anti-requirement ceiling.

**Hit path**: `caches.default.match()` → 200 → ArrayBuffer.
**Miss path**: `env.ASSETS.fetch()` → write-through.

**Probe shape**: time `fetchEsbuildWasmBytes()` call N=3; assert calls
after the first are ≥5× faster.

## Wins NOT shipping this wave (and why)

- **W-C** (`cf:` cache hooks on origin fetch): the `cf:` request init
  is silently ignored in `wrangler dev` local mode (workerd doesn't
  route through Cloudflare's edge). Cannot be probe-verified locally
  per the wave's "5× drop on hit" requirement. Production-only
  optimization; deferred.
- **W-E** (cross-tenant ESM bundle): blocked on the existing
  `inputHash=''` correctness bug at `installer.ts:1571` and
  `vite-dev-server.ts:1918`. Fixing that bug is correctness work
  outside the cache wave's "no new src/ behavior beyond cache + scrub"
  charter. Flagged in the audit; would be a high-leverage follow-up.
- **W-F** (cross-tenant lockfile cache): requires a new R2 binding
  (`NPM_LOCKFILE_CACHE` or similar) and careful correctness review
  (lockfile semantic equivalence is not just `sha256(package.json)` —
  npm's resolution depends on the registry state at resolve time). Not
  a drop-in cache layer; out of charter.
- **W-G** (skip integrity verify on writes-we-made): not a cache layer
  per se — a CPU-skip via metadata. Out of charter.
- **W-H** (barrel synth memoize): per-call savings (~10 ms) below the
  5× threshold meaningfully — the work is small enough that even a
  full memoization wins only sub-second per install. Below the
  ranking floor.

## Post-implementation summary template

| Win  | Probe path                                            | Pre-fix t (ms) | Post-fix t (ms) | Drop ratio |
|------|-------------------------------------------------------|----------------|-----------------|------------|
| W-A  | `audit/probes/cache-and-scrub/packument-l2/`          | TBD            | TBD             | TBD        |
| W-B  | `audit/probes/cache-and-scrub/tarball-l2/`            | TBD            | TBD             | TBD        |
| W-D  | `audit/probes/cache-and-scrub/esbuild-wasm-l2/`       | TBD            | TBD             | TBD        |

(Filled in P3 retro.)
