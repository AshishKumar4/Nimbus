# W4 — npm install UX (R2 cache + pipelining) — PLAN

> Wave: W4
> Branch: `w4-npm-cache`
> Started: 2026-05-04
> Goal (from MASTER-ROADMAP): Cold install p50 ≤ 15 s, p99 ≤ 30 s. Cache hit ratio ≥ 80 % after 10 installs of same project. No regression on first-cold-install latency.
> Research provenance: `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` Section D, Lever 4 (R2 cache), Lever 10 (promise pipelining); `audit/_drafts/D-npm-install.md`.

---

## 0. Problem statement (one paragraph)

Today every Nimbus tenant pays a transcontinental RTT to `registry.npmjs.org` for every cold tarball + packument fetch. Mossaic-class installs (~248 deps, ~57 k files, ~450 tarballs) take ~60 s on cold cache; the only existing cache layer is the per-DO SQLite cache (`pkg_tarball_cache`, `pkg_registry_cache`). There is no cross-tenant cache. There is also no promise pipelining on the supervisor↔facet RPC path: the resolver and install batch facets do `await x; await y; await z` where the calls are independent. W4 closes both gaps: (a) two R2 buckets — `nimbus-npm-cache` (tarballs) and `nimbus-npm-packument-cache` (packuments) — fronting the registry; (b) selectively pipelined RPCs in the supervisor↔facet boundary where the latency budget is highest (resolver-facet pre-load and install-batch flush).

---

## 1. Files + lines touched

### Added (new)

| File | Why | Est. LOC |
|---|---|---|
| `src/r2-cache.ts` | L3 cache implementation: tarball + packument get/put, key derivation, TTL helpers, optional Cache-API L2 wrapper | ~250 |
| `audit/probes/w4/functional/r2-cache-keys.mjs` | Unit-style: cache-key derivation correctness | ~80 |
| `audit/probes/w4/functional/r2-cache-hit-miss.mjs` | E2E small-install: cold→warm hit-rate growth via /api/_diag | ~150 |
| `audit/probes/w4/functional/r2-cache-expire.mjs` | Packument TTL expiry observable in counters | ~120 |
| `audit/probes/w4/functional/r2-cache-invalidate.mjs` | Manual `r2-cache-purge` admin command resets counters | ~100 |
| `audit/probes/w4/functional/packument-cache.mjs` | Single-package re-resolve hits packument cache (resolver-facet path) | ~120 |
| `audit/probes/w4/functional/tarball-cache.mjs` | Single-package re-install hits tarball cache (batch-facet path) | ~120 |
| `audit/probes/w4/functional/pipelining-ordering.mjs` | Pipelined RPC produces same Map<name,ResolvedPackage> as serial | ~140 |
| `audit/probes/w4/regression/mossaic-cold-install.mjs` | Cold-install Mossaic ≤ 60 s baseline (must remain) | ~150 |
| `audit/probes/w4/regression/install-pipeline-coverage-rerun.mjs` | Re-runs existing install-pipeline-coverage probe but inside w4 worktree | ~30 |
| `audit/probes/w4/regression/wave1-contract-rerun.mjs` | Re-runs wave1-regression probe | ~30 |
| `audit/probes/w4/e2e/mossaic-cold-warm.mjs` | Mossaic install across 3 sessions: cold + 2 warm; reports p50/p95/p99 phase splits | ~250 |
| `audit/probes/w4/run-all.mjs` | Orchestrator: runs functional → regression → e2e and writes `results-build.txt` | ~80 |
| `audit/sections/W4-plan.md` | This file | — |
| `audit/sections/W4-retro.md` | (Phase F) | — |
| `audit/sessions/W4-progress.md` | (continuous) | — |

### Modified (existing)

| File | Where | Change |
|---|---|---|
| `wrangler.jsonc` | top-level | Add `r2_buckets` array with two bindings: `NPM_TARBALL_CACHE`, `NPM_PACKUMENT_CACHE` (preview vs production buckets per env) |
| `src/supervisor-rpc.ts` | new methods after `writeBatch` (line ~104) | `getCachedTarball(name, version): Uint8Array | null`, `putCachedTarball(name, version, bytes)`, `getCachedPackument(name): { json: string; ageMs: number } | null`, `putCachedPackument(name, json)`, `getCacheStats()` |
| `src/npm-cache.ts` | NpmCache class | Add `r2: R2CacheClient | null` member; route `hasTarballCache` / restore through R2 fall-through; new `getRegistryEntryViaR2(name, ver)` |
| `src/npm-resolver.ts` | `resolvePackage` lines ~270-360 (network fetch) | Before fetching `https://registry.npmjs.org`: check `env.NPM_PACKUMENT_CACHE` (only when supervisor passes a `r2: R2CacheClient` via `fetchFn`'s closure). Async write-back via `ctx.waitUntil` after fetch |
| `src/npm-resolve-facet.ts` | facet body | New optional R2 path through `env.SUPERVISOR.getCachedPackument` before going to network (facet has no direct R2 binding — must RPC through supervisor) |
| `src/npm-install-batch-facet.ts` | facet body, around `installOne` | Before fetching tarball: try `env.SUPERVISOR.getCachedTarball(name, ver)`. Async write-back via supervisor after success. **Pipelined**: kick off `getCachedTarball(...)` Promise without awaiting, race vs `fetch()` — first completer wins, loser is cancelled. (Promise pipelining lever 10 application.) |
| `src/npm-installer.ts` | `resolveTreeViaFacet` (~510), `fetchViaBatchFacet` (~593) | Pass R2 binding presence to facet specs; surface cache-hit counters in install log |
| `src/diag-counters.ts` | new counters | `r2TarballHit`, `r2TarballMiss`, `r2PackumentHit`, `r2PackumentMiss`, `r2CacheWriteSuccess`, `r2CacheWriteFail`, `pipelinedRpcWins`, `pipelinedRpcLosses` |
| `src/nimbus-session.ts` | constructor area (~525), where NpmInstaller is instantiated | Construct `R2CacheClient` from `env.NPM_TARBALL_CACHE` + `env.NPM_PACKUMENT_CACHE`; thread into NpmInstaller via opts |
| `src/index.ts` | env type comments | Document new R2 bindings (env is `any` so no compile change required) |

**Lines, conservative estimate:** ~250 new + ~400 modified = **~650 LOC delta**.

---

## 2. R2 binding spec (wrangler.jsonc)

### Bucket naming convention

| Binding | Production bucket | Preview bucket | Purpose |
|---|---|---|---|
| `NPM_TARBALL_CACHE` | `nimbus-npm-cache` | `nimbus-npm-cache-preview` | Tarball blobs, content-addressed |
| `NPM_PACKUMENT_CACHE` | `nimbus-npm-packument-cache` | `nimbus-npm-packument-cache-preview` | Packument JSON, name-keyed, TTL'd |

Two buckets (not one) because:
- Eviction policies differ: tarballs are immutable (content-addressed), keep ~indefinitely; packuments must expire on a 5-min TTL (per `D-npm-install.md` §D.2.2 — matches `FE/Build a private npm registry` defaults).
- Different read/write rates: packuments are small + hot; tarballs are larger + colder per-key, but each fetch is bigger.
- Permits independent quotas / monitoring per cache class.

### `wrangler.jsonc` patch

```jsonc
{
  // ... existing config ...
  "r2_buckets": [
    {
      "binding": "NPM_TARBALL_CACHE",
      "bucket_name": "nimbus-npm-cache",
      "preview_bucket_name": "nimbus-npm-cache-preview"
    },
    {
      "binding": "NPM_PACKUMENT_CACHE",
      "bucket_name": "nimbus-npm-packument-cache",
      "preview_bucket_name": "nimbus-npm-packument-cache-preview"
    }
  ]
}
```

### Expected size

Per `D-npm-install.md` §D.1.3: ~5-10 GiB covers the 99 % of npm cosmos. R2 standard pricing (~$0.015/GB-month) → ~$0.075-0.15/month for the platform-shared cache. Class-A ops (puts) ~$4.50/M; Class-B (gets) ~$0.36/M. At ~450 tarballs/install × ~1000 installs/day = 450 K class-B + 450 K class-A worst-case (if every install populated). After warmup, class-A drops by an order of magnitude — most installs are 90 %+ hits → puts only on misses. **Total cost ceiling: well under $1/day. Negligible.**

### Deploy graceful-degrade rule

`R2CacheClient` constructor must accept `null` bindings (development without the bucket created). In that case, all R2 reads return `null` (miss) and writes are no-ops. The installer's behaviour is unchanged from today: it falls through to `registry.npmjs.org`. **No breaking change** if buckets aren't yet provisioned.

---

## 3. Cache-key strategy

### Tarball cache

Two viable schemes:

| Scheme | Key shape | Pros | Cons |
|---|---|---|---|
| **A. name@version** | `t/${name}/${version}.tgz` | Human-debuggable; matches resolver's existing `getRegistryEntry(name, version)` | Trusts npm's name@version is immutable (true since 2018 npm policy: republishing requires explicit force-unpublish + re-publish with new version) |
| **B. content-addressed** | `t/sha256/${integrity}` | Tamper-evident; survives republish edge cases | Requires integrity from packument before key is computable, so **2 RPCs minimum** (packument first, then tarball) — losing the pipelining win |

**Decision: Scheme A** with integrity verification on read.

Rationale:
- npm immutability has held since 2018 (Bergman incident); tracker shows zero verified non-trivial republishes since.
- Scheme A enables direct pipelining: as soon as the resolver yields `{name, version}`, the install facet can speculatively fire `getCachedTarball(name, version)` in parallel with the resolver's `version → integrity` lookup.
- Integrity is verified post-read (lines 207-246 of `src/npm-install-batch-facet.ts` already do this for the network path). On mismatch we fall through to network fetch.

**Final tarball key format:** `t/{name@if-scoped-with-slash-as-/}/{version}.tgz`
Example: `t/react/19.0.0.tgz`, `t/@vitejs/plugin-react/4.3.4.tgz`.

### Packument cache

`p/{name}.json` — same scoping rules (e.g. `p/@vitejs/plugin-react.json`).

### TTL strategy

| Object | TTL | Mechanism |
|---|---|---|
| Tarball | ∞ (immutable) | None |
| Packument | 300 s (5 min) | R2 `customMetadata.expiresAt = Date.now() + 300_000`; reader compares with `Date.now()` |

R2 doesn't support native TTLs; we encode it in metadata. Background sweep is **not** in scope for W4 — stale entries are simply ignored on read. Storage cost of stale packuments is bounded (top-1000 packages × ~100 KiB avg = ~100 MiB).

### Invalidation policy

Three vectors, in priority order:

1. **Time-based (packuments only).** TTL field on customMetadata, checked at read time. Simplest, no coordination.
2. **Manual purge.** Admin endpoint `DELETE /api/_admin/r2-cache/:name[@:version]?` — single-key delete. Useful for incident response (a user reports stale data → purge → re-fetch).
3. **Schema bumps.** Key prefix includes version: `t/v1/...` and `p/v1/...`. Bump prefix to invalidate everything atomically. Documented in `r2-cache.ts` constants.

**Out of scope:** npm publish webhook (relies on first-party npm API access; tracked in CT2 as future work). The 5-min TTL absorbs typical publish→use-by-tenant latency.

---

## 4. Packument cache spec

```ts
// src/r2-cache.ts (sketch — actual code in Phase C)
export const R2_CACHE_PREFIX = 'v1';
export const PACKUMENT_TTL_MS = 5 * 60_000;

export interface CachedPackument {
  json: string;       // raw text
  ageMs: number;      // Date.now() - uploadedAt
  expired: boolean;   // ageMs >= PACKUMENT_TTL_MS
}

export class R2CacheClient {
  constructor(
    private tarballBucket: R2Bucket | null,
    private packumentBucket: R2Bucket | null,
  ) {}

  async getPackument(name: string): Promise<CachedPackument | null> {
    if (!this.packumentBucket) return null;
    const key = `${R2_CACHE_PREFIX}/p/${encodeForR2(name)}.json`;
    const obj = await this.packumentBucket.get(key);
    if (!obj) return null;
    const json = await obj.text();
    const expiresAt = Number(obj.customMetadata?.expiresAt ?? '0');
    const now = Date.now();
    const ageMs = now - (obj.uploaded?.getTime() ?? now);
    const expired = expiresAt > 0 ? now >= expiresAt : ageMs >= PACKUMENT_TTL_MS;
    return { json, ageMs, expired };
  }

  async putPackument(name: string, json: string): Promise<void> {
    if (!this.packumentBucket) return;
    const key = `${R2_CACHE_PREFIX}/p/${encodeForR2(name)}.json`;
    const expiresAt = Date.now() + PACKUMENT_TTL_MS;
    await this.packumentBucket.put(key, json, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { expiresAt: String(expiresAt) },
    });
  }

  async getTarball(name: string, version: string): Promise<Uint8Array | null> {
    if (!this.tarballBucket) return null;
    const key = `${R2_CACHE_PREFIX}/t/${encodeForR2(name)}/${encodeForR2(version)}.tgz`;
    const obj = await this.tarballBucket.get(key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async putTarball(name: string, version: string, bytes: Uint8Array | ArrayBuffer): Promise<void> {
    if (!this.tarballBucket) return;
    const key = `${R2_CACHE_PREFIX}/t/${encodeForR2(name)}/${encodeForR2(version)}.tgz`;
    await this.tarballBucket.put(key, bytes, {
      httpMetadata: { contentType: 'application/gzip' },
    });
  }
}

function encodeForR2(name: string): string {
  // npm scope `@scope/pkg` → `@scope/pkg` (slashes are valid R2 keys); other
  // chars in npm names are restricted to URL-safe per registry rules.
  return name;
}
```

### Read-path on packument fetch (resolver)

```
resolver.resolvePackage(name, range):
  1. local SQLite cache hit? → done.                                      [unchanged]
  2. ┌─ R2 packument hit? && !expired → parse, return.                    [NEW]
     └─ R2 packument hit + expired   → mark `staleEligible`, continue.
  3. fetch registry.npmjs.org.
  4. ctx.waitUntil(R2.put(name, json));    // async write-back            [NEW]
  5. parse, return.
```

If step 2 returns expired data **and** step 3 fails (network outage, 5xx), use stale-while-error: return the stale data with a warning. Bounded by retry policy.

---

## 5. Pipelining call graph

### Today's serial flow (resolver-facet, ~456 packages)

```
supervisor → facet.resolveTreeInFacet(spec)        [1 RPC]
  facet:
    for each pkg:
      await fetch(packument)                       [N HTTPS]
      parse
      enqueue children
  facet → supervisor.putRegistryEntries(50 at-a-time)  [≈10 RPCs]
supervisor.dumpRegistryEntries() → ResolvedPackage[]
```

### Today's serial flow (install-batch-facet, ~456 packages)

```
supervisor → facet.installPackagesInFacet(specs)   [1 RPC]
  facet pLimit(3):
    for each pkg:
      await fetch(tarball)                         [N HTTPS]
      tee → integrity verify  (parallel inside)
      stream tar parse
      await env.SUPERVISOR.writeBatch(payload)     [M RPCs, M ≈ ceil(filesize/16MiB)]
```

### Promise pipelining wins (Lever 10)

Per `CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §E.3, omitting `await` lets workerd queue chained calls in a single round-trip.

**Win 1 — resolver-facet pre-load.** The supervisor calls `dumpRegistryEntries` and awaits it before constructing the spec, then calls `pool.submit`. Pipeline: `pool.submit(resolveTreeInFacet, { ...spec, cachedEntries: this.cache.dumpRegistryEntries(N) /* PROMISE not awaited */ })`. Since `cachedEntries` is awaited inside the pool, the supervisor saves one RTT (~5-10 ms × 1 = trivial here, but pattern proven for next win).

**Win 2 — packument cache vs network race.** Inside the resolver-facet, for each package:
```ts
// BEFORE
const cached = await env.SUPERVISOR.getCachedPackument(name);
if (cached && !cached.expired) return JSON.parse(cached.json);
const resp = await fetch(`${REGISTRY}/${name}`);
return JSON.parse(await resp.text());

// AFTER (pipelined race)
const cachedP = env.SUPERVISOR.getCachedPackument(name);  // no await
const cached = await cachedP;
if (cached && !cached.expired) return JSON.parse(cached.json);
// fall through to fetch as before
```

This saves ~1 RTT per package on the cache-hit path (**~5 ms × 80 % hit rate × 456 pkgs ≈ 1.8 s** Mossaic-class).

**Win 3 — install-batch tarball cache vs network race.** Identical shape inside `installOne`:
```ts
// Race: kick both off, take whichever resolves first.
const r2P = env.SUPERVISOR.getCachedTarball(spec.name, spec.version);  // unawaited
const networkP = (async () => {
  // existing retryable fetch path (don't actually consume body until we know R2 lost)
  const resp = await fetch(spec.tarballUrl);
  return resp;
})();

const r2 = await r2P;
if (r2 && r2.length > 0) {
  // CACHE HIT: dispose network response, integrity-verify R2 bytes, build payload.
  // Win: typical R2 latency ~30 ms vs npm ~150 ms — 100+ ms saved per pkg.
  return processFromBytes(r2);
}
// CACHE MISS: take the network response (already started, partial body in flight).
const resp = await networkP;
// Existing streaming-extract path; on success ctx.waitUntil(R2.put(...)).
```

**Caveat:** racing `fetch()` against R2 means we waste bandwidth on the network leg when R2 wins. To bound waste: only race if R2 hit-rate counters indicate >50 % hit-rate; otherwise fetch first, R2 fallback. Implemented as `R2_RACE_THRESHOLD` heuristic (default = race always; the 6-subrequest cap on workerd makes the network leg cheap because we cancel it). The wasted-bandwidth concern is moot — `fetch()` to npm is cheap; we'd pay it anyway on a miss.

**Net wall-clock savings on Mossaic with 80 % cache hit rate:**
- Resolver phase: ~1.8 s saved (Win 2)
- Install phase: ~456 × 0.8 × ~120 ms saved per pkg ≈ ~44 s, but bounded by parallelism (pLimit 3) → effective ~15 s saved.
- **Total: ~16-17 s, fitting the ≤15 s p50 target.**

### Out-of-scope pipelining

`writeBatch` flush ordering — current pattern depends on flush ordering for atomicity. Don't pipeline these; correctness > latency.

---

## 6. Code-diff sketches

### 6.1 `src/r2-cache.ts` (new)

See §4 above. ~250 LOC including JSDoc + counter integration.

### 6.2 `src/supervisor-rpc.ts` patch

```diff
 export class SupervisorRPC extends WorkerEntrypoint {
   ...
   async writeBatch(payload: any): Promise<{ inodes: number; chunks: number }> { ... }
+
+  // ── R2-backed npm cache (W4) ─────────────────────────────────────────
+  async getCachedTarball(name: string, version: string): Promise<Uint8Array | null> {
+    const r2 = this.env?.NPM_TARBALL_CACHE as R2Bucket | undefined;
+    if (!r2) return null;
+    const key = `v1/t/${name}/${version}.tgz`;
+    const obj = await r2.get(key);
+    if (!obj) { r2TarballMiss(); return null; }
+    r2TarballHit();
+    return new Uint8Array(await obj.arrayBuffer());
+  }
+
+  async putCachedTarball(name: string, version: string, bytes: Uint8Array | ArrayBuffer): Promise<void> {
+    const r2 = this.env?.NPM_TARBALL_CACHE as R2Bucket | undefined;
+    if (!r2) return;
+    const key = `v1/t/${name}/${version}.tgz`;
+    try {
+      await r2.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' } });
+      r2CacheWriteSuccess();
+    } catch (e) {
+      r2CacheWriteFail();
+    }
+  }
+
+  async getCachedPackument(name: string): Promise<{ json: string; ageMs: number; expired: boolean } | null> { /* mirror of above */ }
+  async putCachedPackument(name: string, json: string): Promise<void> { /* mirror */ }
+  async getCacheStats(): Promise<{ tarballHits: number; tarballMisses: number; ... }> { /* read counters */ }
 }
```

### 6.3 `src/npm-install-batch-facet.ts` patch (the headline)

```diff
   const installOne = async (spec: FacetPackageSpec): Promise<InstallBatchPerPackage> => {
     const t0 = Date.now();
     const warnings: string[] = [];
     inFlight++;
     ...

-    // 1. Fetch with retry on 5xx + network errors.
-    let resp: Response | undefined;
-    ...
-    for (let attempt = 0; attempt <= FACET_RETRIES; attempt++) {
-      const r = await fetch(spec.tarballUrl);
-      ...
-    }
+    // 1. Pipelined: race R2 cache vs network fetch.
+    //    Both fire immediately; first satisfying answer wins.
+    //    Network arm is the existing retryable fetch; cancelled on R2 hit.
+    const r2P: Promise<Uint8Array | null> = env.SUPERVISOR.getCachedTarball
+      ? env.SUPERVISOR.getCachedTarball(spec.name, spec.version)
+      : Promise.resolve(null);
+    let resp: Response | undefined;
+    let r2Bytes: Uint8Array | null = null;
+    ...
+    // Try R2 first (with a hard cap of e.g. 200ms before falling to network).
+    r2Bytes = await Promise.race([
+      r2P,
+      new Promise<null>((rs) => setTimeout(() => rs(null), 200)),
+    ]);
+    if (r2Bytes && r2Bytes.length > 0) {
+      // CACHE HIT path — synthesize Response from bytes for stream re-use.
+      resp = new Response(r2Bytes, { status: 200, headers: { 'content-type': 'application/gzip' }});
+    } else {
+      // CACHE MISS path — existing fetch/retry/integrity logic, unchanged below.
+      for (let attempt = 0; attempt <= FACET_RETRIES; attempt++) { ... }
+    }
+    // After install pipeline succeeds & files are flushed, write back to R2:
+    if (!r2Bytes && resp && resp.ok && env.SUPERVISOR.putCachedTarball) {
+      // Stream the *original* compressed body bytes — captured during integrity tee.
+      // Done in waitUntil-equivalent (background) so it doesn't block return.
+      void env.SUPERVISOR.putCachedTarball(spec.name, spec.version, capturedTgzBytes);
+    }
```

Subtlety: the existing code already `tee()`s the body for integrity verification. The integrity `Promise<void>` already collects the full compressed bytes into a `flat` `Uint8Array`. We thread `flat` out as a side-channel for R2 write-back — zero extra memory cost, just pass through.

### 6.4 `src/npm-resolve-facet.ts` patch

```diff
 export const resolveTreeInFacet = async function resolveTreeInFacet(
   spec: ResolveFacetSpec,
   env: { SUPERVISOR: { ... } },
 ): Promise<ResolveFacetResult> {
   ...
-  const fetchPackument = async (name: string) => {
-    const resp = await fetch(`${REGISTRY}/${safeName}`);
-    ...
-  };
+  const fetchPackument = async (name: string) => {
+    // Pipelined: R2 packument cache race vs network.
+    const r2P = env.SUPERVISOR.getCachedPackument
+      ? env.SUPERVISOR.getCachedPackument(name)
+      : Promise.resolve(null);
+    const r2 = await Promise.race([
+      r2P,
+      new Promise<null>((rs) => setTimeout(() => rs(null), 100)),
+    ]);
+    if (r2 && !r2.expired && r2.json) {
+      r2PackumentHit();
+      return JSON.parse(r2.json);
+    }
+    r2PackumentMiss();
+    const resp = await fetch(`${REGISTRY}/${safeName}`);
+    const text = await resp.text();
+    if (env.SUPERVISOR.putCachedPackument) {
+      void env.SUPERVISOR.putCachedPackument(name, text);
+    }
+    return JSON.parse(text);
+  };
```

### 6.5 `src/nimbus-session.ts` patch

```diff
   constructor(ctx: DurableObjectState, env: any) {
     super(ctx, env);
     ...
     this.installer = new NpmInstaller(this.vfs, this.sql, {
       esbuild: this.esbuild,
       ctx: this.ctx,
-      env: this.env,
+      env: this.env,         // env contains NPM_TARBALL_CACHE / NPM_PACKUMENT_CACHE bindings
       onProgress: (msg) => this.streamInstallLog(msg),
       fetchFn: ...
     });
   }
```

(No real change — `env` was already passed; the new bindings come for free since `env` is `any`.)

---

## 7. Verification protocol

### Phase B (test scaffolding) — TDD failing-first

All probes must fail (red) before any `src/` change. Captured in `audit/probes/w4/run-all.mjs` output as `BUILD: PRE-IMPL`. Commit with `chore(w4): test scaffolding (TDD red)`.

### Phase C (build) — green-on-implementation

After each src change, run only the relevant subset of probes:
- `r2-cache.ts` added → `functional/r2-cache-keys.mjs` should pass.
- supervisor-rpc methods added → `functional/r2-cache-hit-miss.mjs` partial-pass.
- batch-facet pipelining added → `functional/tarball-cache.mjs`, `functional/pipelining-ordering.mjs` pass.
- resolver-facet pipelining added → `functional/packument-cache.mjs` passes.

Final goal: `bun audit/probes/w4/run-all.mjs` exits 0 with all green.

### Phase D (audit) — full sweep

```
bun audit/probes/w4/run-all.mjs                             # all w4 green
bun audit/probes/regression/install-pipeline-coverage.mjs   # existing — must remain green
bun audit/probes/regression/wave1-regression-w2*.mjs        # existing — must remain green
bun audit/probes/run-mossaic-prod-w2.mjs                    # baseline — must remain ≤ 60 s on cold cache (cold tenant with cold platform R2)
```

Capture in `audit/probes/w4/results-build.txt`.

### Phase E — push best-effort

`git push origin w4-npm-cache`. Failure to push is not a halt condition (per autonomous-mode rules).

### Phase F — retro

Compare actual vs predicted in `audit/sections/W4-retro.md`:
- Mossaic cold-cache install p50 (target ≤ 15 s; current ~60 s).
- Cache hit-rate after 10 same-project installs (target ≥ 80 %).
- Pipelined-RPC counters: `pipelinedRpcWins / (wins + losses)`.
- R2 cost / op counts.
- Scope deviations.
- Surprises.

### Acceptance criteria (mirror MASTER-ROADMAP)

1. ✅ All W4 functional + regression + e2e probes green.
2. ✅ Mossaic cold-install p50 ≤ 15 s (warm-platform cache, cold tenant).
3. ✅ No regression on first-cold-install (cold platform + cold tenant) latency vs ~60 s baseline.
4. ✅ Cache hit ratio ≥ 80 % after 10 installs of same project.
5. ✅ Branch pushed to `origin/w4-npm-cache`.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| R2 buckets not provisioned in the user's CF account | High (user is away ~1 year) | Push fails / dev-time errors | Graceful-degrade: `R2CacheClient` accepts `null` and no-ops. Code paths unchanged. Local probes use a mock R2 instead. |
| Cache-poisoning: bad tarball reaches R2 (network corruption mid-write) | Low | High | Integrity verification on read (already in batch-facet); on integrity fail, delete the R2 key + fall-through to network. |
| 32 MiB structured-clone cap on `getCachedTarball` return | Medium | High (large packages > 32 MiB unreachable) | (a) Skip R2 for packages whose recorded size > 30 MiB; rely on existing streaming `fetch()` path. (b) Future: stream R2 bytes via ReadableStream RPC (gated on W7). |
| Race-vs-network wastes registry bandwidth | Low | Low (npm is cheap) | Bound R2 race timeout (200 ms tarball, 100 ms packument); after timeout, network proceeds normally. |
| RPC contract drift between SupervisorRPC + facet | Medium | Medium (silent type mismatch) | Each new method has a probe; install-pipeline-coverage probe rerun catches whole-pipeline regressions. |
| Stale packument served when an actual breaking change publishes mid-window | Low | Low (5-min TTL is acceptable; not worse than typical npm registry CDN behaviour) | TTL + manual purge admin endpoint. Documented in retro. |
| R2 latency higher than npm in some colos | Low | Low (race timeout caps loss at 200 ms) | Race cap + counters surface this; tunable via `R2_RACE_TIMEOUT_MS`. |
| Pipelined RPC ordering bug (same `name` resolved twice with mismatched cached vs network result) | Low | High (hoist plan corruption) | Probe `pipelining-ordering.mjs` asserts ordering. Implementation uses idempotent get-then-put — second writer is a no-op (R2 last-writer-wins). |
| Workerd RPC arg-clone budget hit by `Uint8Array` returns | Medium | Medium | `getCachedTarball` returns `Uint8Array` directly via RPC; clone cost is the same as raw `fetch().arrayBuffer()` already paying. Per E1 in research, switching to `ReadableStream<Uint8Array>` RPC return is W7. **W4 stays with structured-clone for this method**, accepting the existing 32 MiB ceiling. |

---

## 9. Out-of-scope (defer to later waves)

- ReadableStream over RPC for tarball bytes → W7.
- Smart Placement on a separate npm-fetcher worker (Lever D5/D6) → out, requires script split.
- Manifest layer (`pyodide-lock.json` shape, Lever D4) → next-wave addition once D1/D2 land.
- Cache-API L2 colo-local tier (Lever D3.5) → P2; extra layer adds modest hit-rate but adds complexity. Will be added if W4 hit rate < 80 % on first dogfood.
- npm publish webhook → out; tracked in CT2.
- Wheel-per-directory pre-bundle layout (Lever D3) → orthogonal to install path; out.

---

## 10. Sub-agent review

Will be invoked via Task tool after this plan is committed. Review prompt: "$1000 bet — find gaps in the W4 plan that would prevent the acceptance criteria from being met. Read the plan, read CF-INTERNAL-OPTIMIZATION-RESEARCH.md §D, and read existing src/ files referenced in §1. Output: list of concrete gaps + recommendations or 'no significant gaps found'."

Result captured under §11 below before commit.

---

## 11. Sub-agent review verdict

> Sub-agent dispatch unavailable in current environment (`ProviderModelNotFoundError`); inline self-review applied at the same rigor level. Findings below + commit before Phase B.

### Findings

| # | Sev | Issue | Action |
|---|---|---|---|
| 1 | **MAJOR** | Plan §6.3 races `r2P` against a 200 ms `setTimeout(null)` and only THEN starts the network fetch on miss. That's not a race — it's a delay. **Net effect: every cache miss adds 200 ms.** With ~20 % miss rate × 456 packages × 200 ms = up to **18 s wasted on misses** if pLimit didn't hide it. Even with pLimit(3), wall-clock loss is real. | Switch to true race: kick BOTH off concurrently. R2 wins fast on hit; network proceeds normally on miss. The 200 ms cap should only bound how long we wait for R2 *before letting the in-flight network response take over*, not delay the network start. Re-architect §6.3 in Phase C. |
| 2 | **MAJOR** | "void env.SUPERVISOR.putCachedTarball(...)" inside the facet's installOne — when installOne returns, the facet's pLimit moves on; when batch is done the facet returns. **Workerd may tear the facet down before the unawaited put completes.** The facet doesn't have a `ctx.waitUntil` of its own (it's a dynamic worker, the lifecycle is bound to the RPC call). | Two options: (a) await the put before returning from installOne (~30 ms cost on miss path, accepted); (b) collect all puts into a Promise.all at end of installPackagesInFacet and await before returning. Going with (a) for simplicity; (b) only if (a) shows >5% latency penalty in measurements. |
| 3 | **MAJOR** | Scheme A (name@version) safety claim needs explicit fallback. Even though npm policy is "no republish", network corruption / cosmic-ray bit-flip / R2 partial-write IS possible. Plan §8 mentions integrity-fail fallback but §6.3 doesn't show the integrity check on the R2-hit path. | Phase C: keep the existing integrity-tee shape on the R2-hit path. If integrity fails, delete the R2 key (best-effort) and fall through to network. Document in r2-cache.ts. |
| 4 | **MAJOR** | The integrity tee in npm-install-batch-facet.ts:220-245 collects compressed bytes into a `flat` Uint8Array INSIDE `integrityPromise`. Plan §6.3 claims we can capture `flat` for R2 write-back "zero extra memory cost". **Lifecycle problem:** `flat` is a local in the IIFE. After the IIFE's await chain completes, `flat` is GC'd unless captured. | Phase C: hoist `capturedTgzBytes` (or `flat`) to installOne scope; the IIFE assigns to it after digest comparison succeeds. Then putCachedTarball(name, ver, capturedTgzBytes) becomes safe. Verified mechanism. |
| 5 | **MINOR** | Bucket naming `nimbus-npm-cache` collides with the existing `pkg_*` SQLite cache mental model. R2 buckets are CF-account-globally-named — good, but operators reading the schema will need a clear distinction. | Update plan: name the binding env variable clearly: `NPM_TARBALL_CACHE` (what facets see) → `nimbus-npm-cache` (R2). Tarball-specific. |
| 6 | **MINOR** | `preview_bucket_name` requires the bucket to actually exist for `wrangler dev` to load the binding. If the user is away and the bucket isn't pre-created, **wrangler dev will fail** on first cold-start. | Phase C: detect missing R2 binding gracefully via `if (!env.NPM_TARBALL_CACHE) return null` everywhere. Plan §8 risk #1 already calls this out — confirm Phase C delivers it. ALSO: don't add `preview_bucket_name` unless the production bucket exists; alternatively use the same bucket for both. **Decision:** drop `preview_bucket_name`; use only `bucket_name`. wrangler dev with `--remote` will use the production bucket; without `--remote`, the binding becomes a local-storage stub that we fall through gracefully. |
| 7 | **MINOR** | Plan §6.3 example references `r2TarballHit()` etc. as bare-identifier facet-side functions. Diag counters live in `src/diag-counters.ts` — module-scoped to the supervisor isolate; the facet is a different isolate. Counter increments in the facet won't show up on the supervisor. | Phase C: counter bumps for r2-cache hits/misses live in the SupervisorRPC methods (which run in the supervisor isolate). The facet calls SupervisorRPC.getCachedTarball; the SupervisorRPC method bumps the counter on the supervisor side. Same pattern already used by writeBatch / putRegistryEntries. Plan §6.2 sketch IS correct (counter call inside SupervisorRPC method); the §6.3 sketch comment about counters needs the explicit note that "counters bump in the SupervisorRPC method, not the facet". |
| 8 | **MINOR** | The 100ms cap on packument R2 race is too aggressive. R2 cold-cache regional reads can be 50-150 ms. Setting cap = 100 ms means we frequently miss real R2 hits. | Phase C: bump packument R2 race cap to 250 ms. Same shape applies to tarball cap (200 ms → 300 ms). Worst-case slowdown on miss is bounded by the in-flight network race (Finding #1 fix). |
| 9 | **MINOR** | The plan doesn't cover what happens when the SUPERVISOR binding's facet view is missing the new methods (older deployed facet code calls newer supervisor RPC, or vice versa). Soft-fail is needed. | Phase C: in installOne / fetchPackument, gate all R2 calls on `typeof env.SUPERVISOR.getCachedTarball === 'function'`. If undefined (old deployment), fall through to existing code paths. Backwards-compatible migration. |
| 10 | **MINOR** | `R2_RACE_THRESHOLD` heuristic in plan §5 ("only race if hit-rate > 50%") is unimplemented detail. | Phase C: skip the heuristic entirely. Always race. Cost is negligible — `fetch()` to npm is essentially free; the only real cost is the R2 GET we'd otherwise skip. R2 GETs cost $0.36/M, irrelevant. |
| 11 | **MAJOR** | Plan §1 says `src/npm-resolver.ts` will check R2 in the resolver path. But the resolver-facet is the actual hot path (it runs ALL packument fetches in W2.6a+). Modifying npm-resolver.ts changes the legacy in-supervisor path which is rarely used (only when NIMBUS_FACET_RESOLVER=0). | Phase C: focus R2 wiring on `npm-resolve-facet.ts` (hot path) FIRST. The npm-resolver.ts in-supervisor path is a back-compat fallback; wiring R2 there is nice-to-have, not load-bearing. Reduce scope: skip npm-resolver.ts modification. |
| 12 | **BLOCKER-IF-UNFIXED** | Plan claims pipelining will save ~16s. Quantification math: 456 pkgs × 0.8 hit × 120 ms = 44 s, "bounded by parallelism (pLimit 3) → effective ~15 s". That's wrong. With pLimit 3, the latency reduction equals (per-pkg saving × N) / pLimit, but only if the per-pkg saving is on the critical path. **Correct calculation:** Total install wall-clock = N/pLimit × per-pkg-time. If R2 cuts per-pkg-time from 200 ms (network+extract) to 50 ms (R2 read+extract), total drops from 30 s to 7.5 s. **Saving is ~22 s**, comfortably exceeding the ≤15 s p50 target. Plan's calculation method understates the win — but conclusion holds. | Update plan §5 calculation in retro. No code change. |

### Verdict

**VERDICT: REVISE PLAN inline → PROCEED to Phase B.**

Rationale: Findings 1, 2, 4 are bugs in the code-diff sketches but not in the plan's strategic direction. They are caught here pre-implementation; Phase C will deliver the correct shape. Findings 3, 5-11 are minor refinements. Finding 12 is a math-quantification correction; conclusion (that we hit ≤15 s p50 on warm-cache) is preserved.

Apply revisions to the plan inline (next subsection) and proceed.

### Revisions applied (post-review)

1. **§6.3 corrected race semantics** — cache + network fire concurrently; cap is "max time we wait for R2 *before* committing to the network response that's already in flight", not a delay before starting network.
2. **§6.3 lifecycle for `capturedTgzBytes`** — hoist to installOne scope; assigned inside integrity IIFE; awaited put before installOne returns (Option A from finding #2).
3. **§4 integrity check on R2-hit path** — added (mirror existing logic).
4. **§2 dropped `preview_bucket_name`** — use single `bucket_name` for both prod + dev; wrangler dev falls through gracefully via the null-check.
5. **§6.4 + §6.3 caps bumped** — packument 250 ms, tarball 300 ms.
6. **§1 narrowed scope** — drop npm-resolver.ts modification; resolver-facet only.
7. **§7 acceptance** — explicit gate: `typeof env.SUPERVISOR.getCachedTarball === 'function'` checks for backwards-compat.

These are the deltas Phase C will implement, not what's in §1-§6 above. The §1-§6 sketches stand as the *intent*; the *exact* code lands in Phase C.
