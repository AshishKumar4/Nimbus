# CACHE-AUDIT — Workers Cache API audit (Part A, P1)

**Branch**: `cache-and-scrub`
**Base**: `origin/main` @ `5dc9a54`
**Date**: 2026-05-08
**Scope**: every R2 read site, every recompute path, every existing
Cache API touchpoint. Output drives the wins ranking in
`audit/sections/CACHE-WINS.md`.

## TL;DR

Honest answer to "are we using `caches.default` properly?": **no — we
aren't using it at all.** Zero `caches.default` / `caches.open` /
`CacheStorage` references in `src/`. The L2 layer documented in
`src/npm/r2-cache.ts:14-17` is a stub:

```
* L1 — per-DO SQLite (NpmCache)              [active]
* L2 — Workers Cache API (`caches.default`)  [NOT WIRED — gated on D3.5]
* L3 — R2 (`NPM_TARBALL_CACHE` / `NPM_PACKUMENT_CACHE`)  [active]
* L4 — registry.npmjs.org origin (fallback)
```

Every L3 read in production today hits R2 even when the same key was
fetched 30 s earlier from the same colo by another tenant.

## Layer summary

| Layer | Backing                         | Status                              | Locality          |
|------|----------------------------------|-------------------------------------|-------------------|
| L1   | per-DO SQLite (`NpmCache`)       | active                              | per-tenant        |
| L2   | Workers Cache API                | **NOT WIRED**                       | per-colo          |
| L3   | R2 (NPM_TARBALL_CACHE + PACKUMENT)| active (W4)                         | global            |
| L4   | `registry.npmjs.org`             | active fallback                     | external          |

## R2 bindings declared (`wrangler.jsonc`)

| Binding              | Bucket                        | Lines              | Notes                                    |
|----------------------|-------------------------------|--------------------|------------------------------------------|
| NPM_TARBALL_CACHE    | `nimbus-npm-cache`            | 134-138, 188-192   | tarballs; immutable; schema-bump invalidation |
| NPM_PACKUMENT_CACHE  | `nimbus-npm-packument-cache`  | 139-142, 193-196   | packument JSON; 5-min TTL via `customMetadata.expiresAt` |

Both graceful-degrade: missing → reads return `null`, writes are
no-ops. No third R2 binding (no esbuild-bundle bucket, no lockfile
bucket).

## R2 read sites

| #  | File:line                                | Function                               | Binding              | Key                              | Frequency                                  |
|----|------------------------------------------|----------------------------------------|----------------------|----------------------------------|--------------------------------------------|
| R1 | `src/npm/r2-cache.ts:162`                | `R2CacheClient.getTarball()`           | NPM_TARBALL_CACHE    | `v1/t/<name>/<version>.tgz`      | **Hot during install**; 20–200 GETs/install |
| R2 | `src/npm/r2-cache.ts:222`                | `R2CacheClient.getPackument()`         | NPM_PACKUMENT_CACHE  | `v1/p/<name>.json`               | **Hot during resolve**; 100–300 GETs/install|
| R3 | `src/session/supervisor-rpc.ts:249-258`  | `SupervisorRPC.getCachedTarball`       | (delegates to R1)    | same                             | called from `install-batch-facet.ts:194`   |
| R4 | `src/session/supervisor-rpc.ts:286-303`  | `SupervisorRPC.getCachedPackument`     | (delegates to R2)    | same                             | called from `resolve-facet.ts:384`         |

**Determinism**:
- Tarball — fully content-addressed (immutable npm contract since 2018).
- Packument — mutable origin; 5-min TTL bounds staleness.

**Cache state**: none. **No `caches.default` wrap. No `cf:` cache hooks.**

## R2 write sites

| #  | File:line                          | Function                          | Binding              | Body                                     | Trigger                              |
|----|------------------------------------|-----------------------------------|----------------------|------------------------------------------|--------------------------------------|
| W1 | `src/npm/r2-cache.ts:192`          | `putTarball()`                    | NPM_TARBALL_CACHE    | `Uint8Array` (≤30 MiB)                   | post-fetch + integrity-verify        |
| W2 | `src/npm/r2-cache.ts:247`          | `putPackument()`                  | NPM_PACKUMENT_CACHE  | JSON, `customMetadata.expiresAt = +5min` | post-fetch                           |
| W3 | `src/npm/r2-cache.ts:205`          | `deleteTarball()`                 | NPM_TARBALL_CACHE    | —                                        | admin (incident response)            |
| W4 | `src/npm/r2-cache.ts:261`          | `deletePackument()`               | NPM_PACKUMENT_CACHE  | —                                        | admin                                |

W1/W2 are awaited (write-back lifecycle correctness). Tarballs without
a registry-supplied integrity field are NOT written back (poisoning
defense — caps the cache hit-rate at the integrity-coverage floor,
which is ~all modern packages but not 100%).

## Expensive recompute paths (deterministic, not yet at-edge cached)

### 4.1 npm packument fetches (`https://registry.npmjs.org/<name>`)

| Site                                       | Determinism                  | Cached? | Payload          |
|--------------------------------------------|------------------------------|---------|------------------|
| `src/npm/resolver.ts:312` (legacy)         | mutable origin; TTL-bounded  | L1+L3   | 50 KB – 5 MiB    |
| `src/npm/resolve-facet.ts:359` (active)    | same                         | L1+L3   | same             |

**Win shape**: `caches.default` wrap of L3 read (W-A) + `cf:` cache
hooks on the origin fetch (W-C). The L3 read has 30–100 ms regional
RTT; an L2 hit is sub-10 ms.

### 4.2 npm tarball SHA verification

| Site                                       | Determinism | Cached? | Cost per call |
|--------------------------------------------|-------------|---------|---------------|
| `install-batch-facet.ts:343-372` (network) | yes         | no      | 5–50 ms       |
| `install-batch-facet.ts:241-251` (R2 hit)  | yes         | no      | 5–50 ms       |

Defense-in-depth: re-verifies even when reading from a bucket WE wrote.
**Win W-G**: trust-on-first-write tag in `customMetadata`; skip digest
on reads we wrote ourselves. CPU win, not I/O.

### 4.3 Pre-bundle ESM output (esbuild)

| Site                                       | Determinism                                                        | Cached?                | Payload          |
|--------------------------------------------|--------------------------------------------------------------------|-------------------------|------------------|
| `src/npm/installer.ts:1500-1572`           | `(specifier, slice, externals, define, BUNDLER_VERSION) → esmCode` | **L1 only**, broken key | 5–500 KiB ESM    |
| `src/facets/vite-dev-server.ts:1853, 1913` | same                                                               | same                    | same             |

**Critical correctness bug**: `inputHash` is hard-coded to `''`
everywhere (`installer.ts:1571`, `vite-dev-server.ts:1918`). Stale
inputs hit the L1 cache silently across version bumps.

**Win W-E**: fix `inputHash` (correctness — out of scope for cache
wave but flagged), then add R2 binding `NPM_BUNDLE_CACHE` keyed
`v1/b/<specifier>/<sliceHash>/<BUNDLER_VERSION>.esm.js`. Cross-tenant
share opportunity.

### 4.4 Resolver tree (deterministic by lockfile / package.json hash)

| Site                                       | Determinism | Cached?                |
|--------------------------------------------|-------------|-------------------------|
| `installer.ts:212` (lockfile read+validate)| yes (warm DO) | L1 only (SQLite `pkg_lockfile`) |

**Win W-F**: cross-tenant lockfile cache keyed by
`sha256(package.json)`. Skips entire resolve+fetch phase for repeat
installs of identical `package.json`. Not in scope this wave (needs
new bucket + correctness considerations).

### 4.5 Barrel-synth output

| Site                                       | Determinism                              | Cached?                                  |
|--------------------------------------------|------------------------------------------|------------------------------------------|
| `installer.ts:1224` (`buildSyntheticEntry`)| `(pkgName, sortedNamedImports[]) → code` | written into VFS, wiped per install      |
| `vite-dev-server.ts:1761`                  | same                                     | same                                     |

**Win W-H**: memoize on hash. Small wall-clock win (~10 ms each), but
multiplies during dev-server cold starts.

### 4.6 esbuild-wasm asset fetch

| Site                                       | Determinism             | Cached?                          | Payload    |
|--------------------------------------------|-------------------------|-----------------------------------|------------|
| `src/runtime/esbuild-wasm-bytes.ts:78-91`  | yes (version-pinned URL)| **no supervisor-side cache**     | **11.9 MiB** |

Comment at lines 7-32 explicitly removed supervisor-side caching to
reclaim 16 MiB heap. workerd's loader cache covers dynamic-worker
isolates only — so each pool construction (3-4× per install) does an
internal `env.ASSETS.fetch()`.

**Win W-D**: `caches.default` wrap. Pulls the bytes from colo cache on
warm calls (~300 µs to ~5 ms for an 11.9 MiB hit). The Cache API
holds a separate ref so the supervisor heap doesn't grow.
**BUT 11.9 MiB > 50 MiB cap is not violated**, but we must verify
caches.default doesn't insist on a 25 MiB limit on a per-object basis.
Workers Cache API hard limits **per object 5GB enterprise / 512MB
default** for paid plans (per Workers docs); 11.9 MiB is well under.

### 4.7 Tailwind Play / vendored bundles served to iframe

| Site                                          | Determinism | Cached?                                | Payload  |
|-----------------------------------------------|-------------|-----------------------------------------|----------|
| `src/facets/vite-dev-server.ts:1495-1506`     | yes (build-pinned) | `Cache-Control: max-age=31536000, immutable` (browser) | ~426 KB  |

Already browser-cached. No edge layer in front. Lower priority.

## HTTP fetchers — deterministic external endpoints

| #   | File:line                          | URL                                      | Cached state                                 | Frequency                |
|-----|------------------------------------|------------------------------------------|----------------------------------------------|--------------------------|
| H1  | `src/npm/resolver.ts:312`          | `https://registry.npmjs.org/<name>`      | L1+L3, no L2, no `cf:`                       | 100–300/install          |
| H2  | `src/npm/resolve-facet.ts:359`     | same                                     | same                                         | same                     |
| H3  | `src/npm/install-batch-facet.ts:278`| `<registry>/-/<name>-<ver>.tgz`         | L1+L3, no L2, no `cf:`                       | 20–200/install           |
| H4  | `src/runtime/esbuild-wasm-bytes.ts:83`| `env.ASSETS.fetch(/_assets/esbuild-…wasm)`| no                                       | 1–4/install              |
| H5  | `src/runtime/node-shims.ts:1947`   | `https://cloudflare-dns.com/dns-query?…` | no                                           | rare (user `dns.resolve`)|
| H6  | `src/session/nimbus-session.ts:815`| dynamic (proxy in dev)                   | no                                           | dev only                 |

Zero `cf: { cacheTtl, cacheEverything }` hooks anywhere.

## Existing Cache API usage

**None.** Confirmed by grep:

```
$ rg 'caches\.default|caches\.open|CacheStorage' src/
(no matches)
$ rg '\bcache\.put\b|\bcache\.match\b' src/
(only NpmCache SQLite methods — same name, different class)
```

The only `Cache-Control` headers on `Response`s:
- `public, max-age=31536000, immutable` on `/__nimbus_assets/tailwind-play.js`.
- `no-store` on every other route.

## Frequency × payload table (Mossaic-class install, ~250 deps)

| Site                              | Heat | Per-install | Avg payload    |
|-----------------------------------|------|-------------|----------------|
| R2.getPackument                   | hot  | 100–300     | 50 KB – 5 MiB  |
| R2.getTarball                     | hot  | 20–200      | 100 KB – 10 MiB|
| H1/H2 (registry packument)        | hot  | 0–300       | same           |
| H3 (registry tarball)             | hot  | 0–200       | same           |
| H4 (esbuild-wasm fetch)           | warm | 1–4         | 11.9 MiB       |
| SHA digest (4.2)                  | hot  | 20–200      | per package    |
| Pre-bundle output (4.3)           | cold | 5–30        | 5 KB – 500 KB  |
| Resolver tree (4.4)               | cold | 1           | ~250 × 500 B   |
| Barrel synth (4.5)                | warm | 1–10        | < 5 KB code    |
| Tailwind Play bundle (4.7)        | warm | per preview | 426 KB         |

## Win-shape summary

(Detailed ranking lives in `audit/sections/CACHE-WINS.md`.)

| Win  | Layer       | Determinism                  | Est. impact                                         |
|------|-------------|------------------------------|-----------------------------------------------------|
| W-A  | L2 in front of R2 packument | TTL-bounded            | 30–100 ms × 100–300 calls/install = 3–30 s saved    |
| W-B  | L2 in front of R2 tarball   | full (immutable)        | 30–100 ms × 20–200 calls/install = 0.6–20 s saved   |
| W-C  | `cf:` hooks on H1/H2/H3     | full / TTL-bounded      | softens L4 misses; free                              |
| W-D  | L2 wrap of esbuild-wasm     | full                    | 11.9 MiB asset-fetch → cache hit, 1–4×/install       |
| W-E  | Cross-tenant ESM bundle R2  | requires inputHash fix  | high — pre-bundle is long pole on barrel-heavy work  |
| W-F  | Cross-tenant lockfile R2    | full                    | skips entire resolve phase                           |
| W-G  | Trust-on-first-write integrity | full                  | 5–50 ms × 20–200 packages CPU                        |
| W-H  | Barrel synth memoize         | full                   | ~10 ms each; multiplies on dev cold starts           |
