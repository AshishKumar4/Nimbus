# Section D — npm install architecture

> Researched against `wiki.cfdata.org/display/EW/SPEC%3A+Python+Workers+Package+Bundling+System`, `wiki.cfdata.org/display/R2/Open-source+software+mirrors`, `developers.cloudflare.com/r2/`, `developers.cloudflare.com/workers/configuration/placement/`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — npm install levers, ranked

| # | Lever | Expected impact | Effort |
|---|---|---|---|
| **D1** | Add an R2-backed cross-tenant tarball cache (lookup in front of `https://registry.npmjs.org/`) | Cuts cold-install time from ~60s/Mossaic-class to ~5-10s; eliminates cross-region npm-registry RTT | M |
| **D2** | Add an R2-backed package-metadata (packument) cache with 5-minute TTL | Resolver phase drops from ~5-10s to ~200-500ms on hot deps; same shape as the FE/private-npm-registry plan | M |
| **D3** | Adopt the "wheel-per-directory" pattern from Python Workers Package Bundling SPEC (Item 1) for Nimbus's pre-bundle layout | Allows partial-bundle import (don't ship the entire pre-bundle to every facet); saves 2-5 MiB encoded per facet | M (medium scope) |
| **D4** | Add a "registry mirror metadata index" similar to Pyodide's `pyodide-lock.json` for Nimbus's tarball cache → enables determinism + offline-after-cache-warm | Reproducible installs; faster `npm install` on identical lockfile | S |
| **D5** | Smart Placement on the gateway/`fetch-proxy` facet (the one that talks to npm registry) | Cuts cross-continent RTT to npmjs.org from 100-300ms to <50ms | XS (1-line config) |
| **D6** | Use `placement.host = "registry.npmjs.org"` explicitly on the resolve facet | Same as D5 but explicit; works without the heuristic warm-up | XS |

D5 and D6 are XS wins. D1 (R2 cross-tenant cache) is the highest-impact long-term play because it amortises *all* tenants' first-install cost to the platform layer instead of paying it per-tenant.

---

## D.1 The Python Workers Package Bundling pattern — what to borrow

[EW/SPEC: Python Workers Package Bundling System](https://wiki.cfdata.org/display/EW/SPEC%3A+Python+Workers+Package+Bundling+System) is the most directly-applicable internal precedent. Quote:

> *"Currently, Edgeworker and workerd have two separate ways to handle packages. This is because Edgeworker includes a ~30 MB (~8 MB zipped) `pyodide-packages.tar` file (we'll refer to this as a **package bundle**), and people didn't like the increase in binary size when we attached it to workerd."*

> *"On Edgeworker, all packages are present and importable regardless of what the user's `requirements.txt` file says…"*

The wheel-per-directory format proposed (Item 1):

> *"We propose this new format:*
> *- /*
> *  - fastapi/*
> *    - fastapi/*
> *    - fastapi-...-distinfo/*
> *  - typing-extensions/*
> *    - typing-extensions/*
> *    - typing-extensions-...-distinfo/*
> *  - …*
> *  - pyodide-lock.json*
>
> *Notice that each wheel has its own directory in the bundle. At runtime, we can:*
> *1. Look at the user's requirements.txt. Use the lockfile to determine what dependencies they need.*
> *2. Transform the above directory structure so that the user's view of the /site-packages is the same as before, except limited to the requirements they requested.*
> *3. Mount the transformed /site-packages partition (read-only)"*

### D.1.1 Mapping to Nimbus

| Pyodide concept | Nimbus equivalent | Today's state |
|---|---|---|
| `pyodide-packages.tar` (per-package wheels) | `npm-cache.ts` content-addressed SQLite cache | Per-DO cache, not shared across tenants |
| `pyodide-lock.json` (manifest of available wheels) | Nimbus's `.nimbus-lockfile` (per-project) | Nimbus has it; not platform-wide |
| `package recipe` (build instructions) | n/a — npm tarballs are pre-built | n/a |
| Package bundle in EW binary | Pre-bundled facet code (`esbuild-wasm-bundle.generated.ts`, etc.) | Static, in script |
| R2 bucket for wheels | n/a today; D1's proposal | Doesn't exist |

The two-layer pattern that Cloudflare invested in for Pyodide:
1. **Per-package independent wheels in R2** (uploaded once at recipe build time)
2. **Lockfile served from R2** (mutable index, points to wheel R2 keys)
3. **Runtime resolves lockfile → fetches only requested wheels → mounts**

For Nimbus's npm equivalent:
1. **Per-tarball R2 cache** keyed by `sha256(tarball-bytes)` (or by `name@version`)
2. **Per-package packument R2 cache** with 5-min TTL
3. **Resolver consults both before falling through to `registry.npmjs.org`**

### D.1.2 Lever D1 — concrete sketch

```ts
// src/npm-cache.ts (audit-only sketch)
class NpmCache {
- // Today: per-DO SQLite cache
- async getTarball(name: string, version: string): Promise<Uint8Array | null> {
-   return this.sqlite.exec("SELECT data FROM tarballs WHERE name=? AND version=?", name, version)?.one()?.data;
- }
+ async getTarball(name: string, version: string): Promise<Uint8Array | null> {
+   // L1: per-DO SQLite (warmest, ~O(1ms))
+   const local = this.sqlite.exec("...").one()?.data;
+   if (local) return local;
+
+   // L2: cross-tenant R2 cache (~O(20-50ms regional))
+   const r2Key = `npm/${name}/${version}.tgz`;
+   const r2Obj = await this.env.NPM_TARBALL_CACHE.get(r2Key);
+   if (r2Obj) {
+     const bytes = new Uint8Array(await r2Obj.arrayBuffer());
+     this.sqlite.exec("INSERT OR REPLACE INTO tarballs ...", name, version, bytes);
+     return bytes;
+   }
+
+   // L3: registry origin (~O(100-300ms cross-region)
+   const upstream = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
+   const bytes = new Uint8Array(await upstream.arrayBuffer());
+
+   // Async write-back to R2 (don't block the install on this)
+   ctx.waitUntil(this.env.NPM_TARBALL_CACHE.put(r2Key, bytes, {
+     httpMetadata: { contentType: 'application/gzip' },
+   }));
+   this.sqlite.exec("INSERT OR REPLACE INTO tarballs ...", name, version, bytes);
+   return bytes;
+ }
}
```

`wrangler.jsonc` addition:

```jsonc
// wrangler.jsonc (audit-only sketch)
{
+ "r2_buckets": [
+   { "binding": "NPM_TARBALL_CACHE", "bucket_name": "nimbus-npm-tarball-cache" },
+   { "binding": "NPM_PACKUMENT_CACHE", "bucket_name": "nimbus-npm-packument-cache" }
+ ],
}
```

### D.1.3 Quantifying the win

Mossaic-class install: ~248 deps, ~57k files in ~60s on cold cache (per [`README.md`](../../README.md) §Status, "100+ direct deps resolving to ~450+ packages / ~57,000 files in ~60s on a cold cache").

The 60s is dominated by:

| Phase | Cold-cache time | Source |
|---|---|---|
| Resolver (packument fetches) | ~5-10s | `src/npm-resolver.ts` ~250-450 packuments |
| Tarball fetches | ~25-35s | `src/npm-tarball.ts` 450 tarballs × ~50-200KB each |
| Decompress + extract | ~10-15s | `src/npm-tarball-stream.ts` |
| VFS write batches | ~5-10s | `src/sqlite-vfs.ts` `transactionSync` |

After D1 (tarball R2 cache) for warm tenants:
- Phase 2 drops from 25-35s to **~5-10s** (R2 latency dominates over network egress)
- Total installs of ~57k-files projects drop from 60s to **~20-25s**

After D1+D2 (both caches) for warm tenants:
- Phase 1 drops from 5-10s to **~200-500ms**
- Total installs drop to **~15-20s**

After D1+D2+D5 (Smart Placement on gateway/fetch-proxy):
- Phase 1+2 latency further compressed (CDN-like)
- Total installs: **~10-15s** for cold tenant of warm-cache deps; <5s for warm tenant of warm-cache deps

The R2-cache approach also ensures **first install of `react@18` for tenant N is fast even if N has zero local cache**, as long as someone on the platform has installed it before.

⚠️ Caveat: R2 storage cost. 450 packages × avg ~100 KB = ~45 MiB per tenant, with massive overlap across tenants. The shared R2 bucket should grow logarithmically with the npm dep cosmos, not with tenant count. ~5-10 GB R2 covers the 99 % case for typical npm projects. Storage cost: ~$0.01/month/GB on R2 = trivial.

---

## D.2 R2-backed packument cache feasibility

### D.2.1 What's the fetch shape today

Nimbus's resolver ([`src/npm-resolver.ts`](../../src/npm-resolver.ts)) does pipelined packument fetches:

```ts
// src/npm-resolver.ts:540-549 (paraphrasing)
//   for each dep:
//     fetch https://registry.npmjs.org/<name>
//     parse versions, pick range-satisfying one
//     enqueue children
```

Per-packument response sizes range from ~5 KB (small packages) to ~5 MB (e.g. `eslint`, `typescript` — large packument JSONs containing every published version's metadata). Average ~50-200 KB.

### D.2.2 Hit-rate model for R2-backed cache

Most tenants install the same top-1000 packages. [Emerging Tech/I tested 1000 popular npm Packages on Workers (Using AI)](https://wiki.cfdata.org/pages/viewpage.action?pageId=1327289817) confirms:

> *"**992 packages** tested:*
> *Works: 375; Works with caveats: 10; Not applicable: 502; Use alternative: 80; Built-in: 10; Doesn't work: 15"*

That 992 is the entire top-1000 npm. Across all Nimbus tenants, the dependency set will have a heavy long tail but a sharp head. R2 caching captures the head.

⚠️ speculation: a 5-minute TTL cache likely captures **~95 % of resolver requests** across active tenants if Nimbus has more than ~10 active sessions. The `~private/Build a private npm registry` wiki page ([FE/Build a private npm registry](https://wiki.cfdata.org/display/FE/Build+a+private+npm+registry)) uses **5-minute** package-metadata TTL and **1-hour** version-metadata TTL — those numbers transfer.

### D.2.3 Lever D2 — concrete sketch

Same shape as D1, with shorter TTL and JSON content:

```ts
// src/npm-resolver.ts (audit-only sketch)
async function fetchPackument(name: string): Promise<Packument> {
  const r2Key = `packument/${name}.json`;
+ const r2Obj = await env.NPM_PACKUMENT_CACHE.get(r2Key);
+ if (r2Obj) {
+   const meta = await r2Obj.text();
+   const ageS = (Date.now() - Date.parse(r2Obj.uploaded ?? '')) / 1000;
+   if (ageS < 300) return JSON.parse(meta);    // 5-minute TTL
+ }
  const resp = await fetch(`https://registry.npmjs.org/${name}`);
  const text = await resp.text();
+ ctx.waitUntil(env.NPM_PACKUMENT_CACHE.put(r2Key, text, {
+   httpMetadata: { contentType: 'application/json' },
+ }));
  return JSON.parse(text);
}
```

---

## D.3 Cross-region — where does npmjs.org actually serve from?

### D.3.1 What's documented

Per [R2/Open-source software mirrors](https://wiki.cfdata.org/display/R2/Open-source+software+mirrors):

> *"https://deb.debian.org/ — Sponsored by Fastly*
> *https://cloudfront.debian.net/ — Sponsored by AWS"*

Cloudflare ran an experiment to host an OSS mirror in R2 with global cache. **That experiment is the directly applicable precedent for Nimbus's cross-tenant npm cache.** The wiki page sketches the architecture (KV+R2 with content-addressed object store and metadata index — exactly the Pyodide shape).

For npmjs.org specifically: ⚠️ speculation, **npm is hosted on AWS US-East**. Nimbus's facet running in EU/APAC pays a transcontinental RTT every cold tarball fetch. Per [PINGORA-110 / R2 Metadata Caching](https://wiki.cfdata.org/display/R2/R2+Metadata+Caching), the Cloudflare network fronts S3-style origins via tiered cache by default, which would benefit Nimbus *if* Nimbus's fetch went through Cloudflare's CDN to the npmjs.org origin. But Nimbus's facet code currently does:

```ts
// src/npm-tarball.ts (paraphrasing the shape)
fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`)
```

This is a direct origin fetch from a workerd metal. **No CDN benefit** because the request originates *inside* the CF network — Cloudflare CDN doesn't cache its own outbound fetches by default.

### D.3.2 The Cache API workaround

[R2+Cache Investigation (Mark Dembo / Harshal Brahmbhatt)](https://wiki.cfdata.org/pages/viewpage.action?pageId=754397110) and [Saving R2 with Cache (Reducing GetObject Latency by 140ms)](https://wiki.cfdata.org/pages/viewpage.action?pageId=819439999) describe the pattern. The R2 team got a **140 ms** latency reduction by caching upstream objects via Cache API.

Nimbus could do the same:

```ts
// src/npm-tarball.ts (audit-only sketch)
async function fetchTarball(name: string, version: string) {
  const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
+ const cache = await caches.open('npm-tarballs');
+ const cached = await cache.match(url);
+ if (cached) return new Uint8Array(await cached.arrayBuffer());
  const resp = await fetch(url);
+ const cloned = resp.clone();
+ ctx.waitUntil(cache.put(url, cloned));
  return new Uint8Array(await resp.arrayBuffer());
}
```

But [RFC: Caching layers in Cloudchamber managed registry](https://wiki.cfdata.org/display/CC/RFC%3A+Caching+layers+in+Cloudchamber+managed+registry) flags a critical caveat:

> *"Cache API is exposed to the workers runtime, it basically allows you to cache responses within Cloudflare programatically. However, one of the main limitations of this API is that this cache is limited to the location (AKA colo). Not useful for us as we are looking for tiered caching + reserve out-of-the-box."*

So **Cache API is colo-local**, not global. A user on metal X gets the cache; another user on metal Y must re-populate. That's worse than R2 which is **truly global** — colo-local cache is a tier 1 cache; R2 is tier 2.

The proper layering for Nimbus:

1. **L1 (tier 0): in-DO SQLite cache** — per-tenant
2. **L2 (tier 1): Cache API** — per-colo
3. **L3 (tier 2): R2** — global
4. **L4 (origin): registry.npmjs.org**

Each tier captures the cases the next tier missed. After all four are in place, a cold tenant in any colo for any package on the platform's hot list gets ~30 ms to first byte.

### D.3.3 Lever D3.5 — colo-local Cache API

Half-step between D1/D2 and the existing per-DO cache. Free, easy:

```ts
// inside fetchTarball / fetchPackument:
+ const cache = await caches.open('npm-tarballs-v1');
+ const cached = await cache.match(url);
+ if (cached) return cached;
+ const resp = await fetch(url, { cf: { cacheTtl: 86400 } });   // 1 day
+ ctx.waitUntil(cache.put(url, resp.clone()));
+ return resp;
```

Worth noting: `fetch()` from a Worker to a third-party origin already gets edge caching for cacheable responses if `cf.cacheTtl` is set. For `registry.npmjs.org` responses (npm sets reasonable cache headers on tarballs), this likely already works *partially*. Worth measuring.

---

## D.4 Smart Placement for the registry-fetching facet

### D.4.1 What's documented

Per [developers.cloudflare.com/workers/configuration/placement/](https://developers.cloudflare.com/workers/configuration/placement/):

> *"By default, Workers and Pages Functions run in a data center closest to where the request was received. If your Worker makes requests to back-end infrastructure such as databases or APIs, it may be more performant to run that Worker closer to your back-end than the end user."*

Three placement modes:

| Mode | Use |
|---|---|
| `mode: "smart"` | CF heuristics — works for most cases |
| `host: "registry.npmjs.org:443"` | Probe a TCP host |
| `hostname: "registry.npmjs.org"` | Probe via HTTP |

The recent stabilization ([changelog 2025-03-22](https://developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/)) says:

> *"once Smart Placement has identified and assigned an optimal location, temporarily dropping below the heuristic thresholds will not force a return to default locations."*

So Smart Placement is now sticky — useful for low-frequency long-tail tenants.

### D.4.2 The Nimbus-specific gotcha

Nimbus has *two* fetch consumers:
1. **The supervisor DO** itself when serving `/preview/*` to the eyeball — best at the eyeball edge (default placement).
2. **The npm registry fetch facet** (today: same metal as the supervisor) — best near `registry.npmjs.org`.

These are **mutually exclusive** at the wrangler.jsonc level — you can only set one placement strategy per script.

### D.4.3 Lever D5 — split the script

The right architecture: **separate the npm-registry-fetcher into its own Worker (not a facet)** with `placement.host = "registry.npmjs.org:443"`. The supervisor calls into it via service binding.

Today, `npm-resolve-facet` runs inside `LOADER.get()` from the supervisor's metal. The supervisor lives at the user's edge. So `npm-resolve-facet` runs at the user's edge → packument fetch from EU/APAC user → cross-Atlantic RTT to npm. Smart Placement can't help if the supervisor is at the eyeball.

```jsonc
// wrangler.jsonc (audit-only sketch — TWO scripts)
// scripts/nimbus.jsonc — the eyeball-edge supervisor
{
  "name": "nimbus",
  // no placement override → eyeball edge (default)
+ "services": [{ "binding": "NPM_FETCHER", "service": "nimbus-npm-fetcher" }]
}

// scripts/nimbus-npm-fetcher.jsonc — the registry-near worker
{
  "name": "nimbus-npm-fetcher",
+ "placement": { "host": "registry.npmjs.org:443" }
}
```

This is a non-trivial refactor (current `npm-resolve-facet.ts` is loaded via LOADER.get from supervisor and assumes ctx.exports loopback — a service-binding split changes the call shape). Effort: M, not XS.

⚠️ Compromise: a single placement annotation on the supervisor script (`mode: "smart"`) might end up placing Nimbus closer to npm if heuristics see lots of npm traffic. Worth measuring before splitting.

---

## D.5 Lever D4 — registry mirror metadata index

The Pyodide pattern (`pyodide-lock.json`) is more than just caching. It's:

1. A **mutable index** in R2 listing every wheel available
2. **Content-addressed** wheels referenced by the index
3. **Atomic switch** — update the lockfile last; readers see consistent view

For Nimbus, the same pattern means:

```
R2: nimbus-npm-cache/
  ├── manifest.json    # mutable: { "react@18.3.1": "tarballs/sha256-abc.tgz", ... }
  ├── tarballs/
  │   ├── sha256-abc.tgz
  │   ├── sha256-def.tgz
  │   └── ...
  └── packuments/
      ├── react.json
      └── ...
```

Benefits over per-package R2 keys:
- One mutable manifest atomic-replaces; no race between manifest update and tarball availability
- Lets Nimbus periodically *prune* (drop tarballs not in any active tenant lockfile in last 90 days)
- Tracks platform-wide install diversity for analytics / cost attribution
- Mirrors the well-understood Linux distro mirror pattern (per [R2/Open-source software mirrors](https://wiki.cfdata.org/display/R2/Open-source+software+mirrors))

Lever D4 effort: **S** if Nimbus already has `npm-cache.ts` (it does); just add the manifest layer.

---

## D.6 What we're NOT doing

- **Run a full npm registry mirror.** Out of scope; the `private npm registry` wiki page is for first-party Cloudflare packages, not a global npm proxy. R2 cache + origin fallback suffices.
- **Cross-tenant tarball diff/compress.** Already content-addressed (`sha256(bytes)`), so dedup is free; further compression doesn't pay.
- **Smart Placement of the supervisor DO.** DOs don't move once placed (Section G covers this). Smart Placement applies to Workers, not the supervisor DO directly.
- **Pre-warm the facets at session boot.** Per [DO data location docs](https://developers.cloudflare.com/durable-objects/reference/data-location/), "It can negatively impact latency to pre-create Durable Objects prior to the first client request." Same logic suggests pre-warming a facet before a real install request is *slower*, not faster.

---

## D.7 Concrete diff, prioritised

### Lever D5 (XS, ship today)

Try Smart Placement on the supervisor script first. One line:

```jsonc
// wrangler.jsonc
{
+ "placement": { "mode": "smart" }
}
```

Measure with `cf-placement` header; revert if `UNSUPPORTED_APPLICATION` or no improvement.

### Lever D6 (XS, alternative to D5)

Explicit host probe:

```jsonc
"placement": { "host": "registry.npmjs.org:443" }
```

### Lever D3.5 — Cache API tier (XS)

Wrap fetch() calls with `cf.cacheTtl`:

```ts
// src/npm-tarball.ts (audit-only sketch)
- const resp = await fetch(url);
+ const resp = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
```

### Lever D2 (M)

Add `NPM_PACKUMENT_CACHE` R2 binding. ~50 LOC patch in `npm-resolver.ts`.

### Lever D1 (M)

Add `NPM_TARBALL_CACHE` R2 binding. ~50 LOC patch in `npm-tarball.ts` + `npm-cache.ts`.

### Lever D3 (M)

Adopt wheel-per-directory layout in pre-bundle generated files. Allows partial-bundle facets.

### Lever D4 (S, after D1/D2)

Add manifest layer over R2-backed cache.

---

## D.8 Citations summary

Wiki pages:
- EW/SPEC: Python Workers Package Bundling System (the canonical pattern)
- EW/SPEC: Deploy Python code directly to Workers
- EW/SPEC: Pyodide + Python package versioning and loading
- R2/Open-source software mirrors (Linux distro mirror precedent)
- R2/R2 Metadata Cache (production architecture)
- pages/viewpage.action?pageId=754397110 (Harshal R2+Cache investigation)
- pages/viewpage.action?pageId=819439999 (Saving R2 with Cache; 140ms reduction)
- CC/RFC: Caching layers in Cloudchamber managed registry (Cache API colo-local caveat)
- FE/Build a private npm registry (TTL choices: 5min metadata / 1hr version)
- FE/Now Playing Mario: How to Switch (your npm config) (internal CF npm registry context)

Public docs:
- developers.cloudflare.com/workers/configuration/placement/
- developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/
- developers.cloudflare.com/r2/

Nimbus src/ citations:
- `src/npm-resolver.ts:540-549` (resolveTree breadth-first walk)
- `src/npm-resolver.ts:625-688` (resolveExports — already correct)
- `src/npm-installer.ts:419-451` (facet-pool fetch concurrency rationale)
- `src/npm-installer.ts:1233-1289` (concurrency=2/3 calculation around RPC clone cost)
- `src/npm-cache.ts` (content-addressed SQLite cache, per-DO scope today)
- `src/npm-tarball.ts` (tarball fetch path)
- `src/npm-tarball-stream.ts` (gzip decompression path)
- `src/npm-resolve-facet.ts:13-44` (one-facet pattern — the natural call-site for D5/D6 split)
- `src/parallel/facet-pool.ts:328-348` (dispose lifecycle)
- `src/sqlite-vfs.ts` — write-batch path; already mitigates VFS-write storms
- `wrangler.jsonc` (placement target)
- `README.md` §Status (Mossaic-class benchmark numbers)
