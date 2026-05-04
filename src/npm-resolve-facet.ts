/**
 * npm-resolve-facet.ts — NimbusFacetPool entry for the npm resolver phase.
 *
 * Why this exists
 * ───────────────
 * The resolver crashes the supervisor DO during `npm install` of any
 * non-trivial app:
 *   1. `await resp.json()` at src/npm-resolver.ts:306 deserializes the
 *      ENTIRE packument as a JS object. Packuments for widely-versioned
 *      packages (lucide-react, react-router-dom, framer-motion, …) can
 *      be 5–20 MB; parsed object expands ~3× in V8. With pLimit(6),
 *      6 concurrent slots can hold ~360 MB transient peak — well over
 *      the 128 MB DO heap cap.
 *   2. The fetch-proxy worker (src/nimbus-session.ts:1666-1714) is a
 *      singleton that buffers each response via `resp.arrayBuffer()`.
 *      With 6 concurrent calls in flight, ONE 128 MB isolate holds
 *      6 × packument-bytes simultaneously.
 *
 * The fix is to dispatch the entire resolver phase to a NimbusFacetPool
 * isolate. The facet has its own 128 MB; the supervisor's heap stays
 * flat through phase 1 (the smoking gun: cumulativePackumentBytesDecoded
 * stays near 0 in the supervisor counters post-fix).
 *
 * Topology choice (per /workspace plan): ONE facet for the whole walk,
 * not pool.map per-spec. Rationale:
 *   - 456-spec walk × per-spec dispatch overhead = excessive cold-starts.
 *   - The CPU work per spec is small; the heap is the issue.
 *   - A single facet running the breadth-first walk has its own 128 MB,
 *     reuses the same fetch handle, batches RPC writes back via
 *     env.SUPERVISOR.putRegistryEntries, and has its heap fully released
 *     when the facet returns.
 *
 * Concurrency inside the facet uses pLimit(6) — same value as today's
 * in-supervisor resolver, but now with a fresh 128 MB to absorb the
 * transient parse spikes.
 *
 * Worst-case facet heap budget (with concurrency 4, set by the
 * supervisor dispatcher):
 *   - cachedEntries map: ≤ 2.5 MiB (capped at 5000 × ~500 B)
 *   - 4 concurrent packument text+parse buffers: up to 4 × ~20 MiB
 *     for pathologically large packuments = 80 MiB transient peak.
 *     For typical npm packages (<2 MiB packument), this is ~8 MiB.
 *   - resolved Map: ~228 KiB for a 456-package install.
 *   - Total worst-case: ~85 MiB. Comfortably under the 128 MB cap with
 *     ~40 MiB headroom for V8 overhead + esbuild-runtime shim.
 *
 * Stability invariants (cloudflare-parallel serialises via fn.toString):
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - All helpers (semver match, exports field, skip list) live in the
 *     preamble (src/parallel/npm-resolve-preamble.ts) so the facet has
 *     them in its lexical scope.
 *
 * Cache strategy:
 *   The supervisor pre-loads cached registry entries (already-resolved
 *   packages from prior installs) and ships them in the spec. The facet
 *   reconstructs a name → versions[] map and uses it to short-circuit
 *   fetches on hits. For cold sessions, the cache is empty (~0 bytes
 *   over the wire). For warm sessions, ~500 B per cached entry × at
 *   most 5000 entries = 2.5 MB, well under the 32 MB RPC cap.
 *
 *   Cache writes flow back via env.SUPERVISOR.putRegistryEntries in
 *   waves (every 50 resolved packages or end-of-phase, whichever first).
 *   Doesn't block forward progress.
 */

import type { ResolvedPackage } from './npm-resolver.js';

// ── Types exchanged between supervisor and facet ─────────────────────────

export interface FacetCachedEntry {
  /** Same shape as RegistryCacheEntry from src/npm-cache.ts. JSON-only
   *  fields so the structured-clone over RPC doesn't choke. */
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  depsJson: string;
  exportsJson: string;
  main: string;
  moduleField: string;
  binJson: string;
  fetchedAt: number;
}

export interface ResolveFacetSpec {
  /** Root specs from the caller's package.json — { name → semver range }. */
  specs: Record<string, string>;
  /** Cached registry entries the supervisor already has. The facet uses
   *  these to skip fetches for packages whose resolved version is
   *  already known. Empty on cold sessions. */
  cachedEntries: FacetCachedEntry[];
  /** Concurrency cap (default 6 — same as in-supervisor RESOLVE_CONCURRENCY). */
  concurrency: number;
  /** Per-fetch timeout (ms). */
  fetchTimeoutMs: number;
  /** Cap on retries for transient failures. */
  retries: number;
}

export interface ResolveFacetResult {
  /** Resolved packages, lean (no packument retained). */
  resolved: ResolvedPackage[];
  /** Per-spec status messages — surfaced into the install log as
   *  `[resolve-facet] <line>`. Bounded to ~one line per resolved spec. */
  messages: string[];
  /** Counter snapshot at end of phase. Mirrors src/diag-counters.ts shape
   *  for the resolver subset, so the supervisor can fold these into its
   *  own counters before responding to /api/_diag/memory. */
  facetCounters: {
    inFlightPeak: number;
    cumulativeBytesDecoded: number;
    packumentsDecoded: number;
    lastPackumentName: string;
    lastPackumentBytes: number;
  };
  /** Wall-clock elapsed inside the facet. */
  elapsed: number;
  /** Cache writes the facet flushed back via env.SUPERVISOR.putRegistryEntries. */
  cacheWriteCount: number;
}

// ── Facet function ──────────────────────────────────────────────────────
//
// `resolveTreeInFacet` is serialised via fn.toString() and run inside a
// NimbusFacetPool isolate. It references the following symbols by bare
// identifier; they are declared in the preamble
// (src/parallel/npm-resolve-preamble.ts) at facet-load time:
//
//   - SHOULD_SKIP_PACKAGE(name) → boolean
//   - PARSE_SEMVER(v) → [maj, min, patch] | null
//   - COMPARE_SEMVER(a, b) → number
//   - SATISFIES_RANGE(version, range) → boolean
//   - RESOLVE_VERSION(versions, range) → string | null
//
// The function does NOT import them statically — that would pull the
// entire npm-resolver.ts into the supervisor's bundle, defeating the
// point of moving the work elsewhere.

export const resolveTreeInFacet = async function resolveTreeInFacet(
  spec: ResolveFacetSpec,
  env: {
    SUPERVISOR: {
      putRegistryEntries(entries: any[]): Promise<{ written: number; failed: number }>;
    };
  },
): Promise<ResolveFacetResult> {
  const t0 = Date.now();
  const messages: string[] = [];

  if (!spec || typeof spec !== 'object') {
    throw new Error('resolveTreeInFacet: missing spec');
  }
  if (!env || !env.SUPERVISOR || typeof env.SUPERVISOR.putRegistryEntries !== 'function') {
    throw new Error('resolveTreeInFacet: env.SUPERVISOR.putRegistryEntries missing');
  }

  // ── In-memory cache reconstructed from the spec ─────────────────────
  // Map: name → { version → FacetCachedEntry }
  const cacheByName = new Map<string, Map<string, FacetCachedEntry>>();
  for (const entry of spec.cachedEntries || []) {
    if (!entry || !entry.name || !entry.version) continue;
    let inner = cacheByName.get(entry.name);
    if (!inner) {
      inner = new Map();
      cacheByName.set(entry.name, inner);
    }
    inner.set(entry.version, entry);
  }

  // ── Counters (facet-local; copied into result.facetCounters at end) ──
  let inFlight = 0;
  let inFlightPeak = 0;
  let cumulativeBytesDecoded = 0;
  let packumentsDecoded = 0;
  let lastPackumentName = '';
  let lastPackumentBytes = 0;

  // ── Concurrency limiter (inline; preamble doesn't carry pLimit) ─────
  // Identical semantics to npm-resolver.ts:31-50.
  const concurrency = Math.max(1, Math.min(spec.concurrency || 6, 16));
  let active = 0;
  const queue: (() => void)[] = [];
  const limit = <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        active++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          active--;
          if (queue.length > 0) queue.shift()!();
        }
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };

  // ── Cache write batcher ──────────────────────────────────────────────
  // Flushes every FLUSH_THRESHOLD entries OR at end-of-phase. RPC arg
  // size is dominated by depsJson + exportsJson — typical entry ~500 B,
  // so 50 × 500 = 25 KB per flush. Trivially under workerd's 32 MB cap.
  const FLUSH_THRESHOLD = 50;
  let pendingCacheWrites: any[] = [];
  let totalCacheWrites = 0;
  const flushCache = async (): Promise<void> => {
    if (pendingCacheWrites.length === 0) return;
    const batch = pendingCacheWrites;
    pendingCacheWrites = [];
    try {
      const r = await env.SUPERVISOR.putRegistryEntries(batch);
      totalCacheWrites += r.written;
      if (r.failed > 0) {
        messages.push(`[resolve-facet] cache write: ${r.failed} entries failed`);
      }
    } catch (e: any) {
      messages.push(`[resolve-facet] cache flush failed: ${e?.message || e}`);
    }
  };
  const enqueueCacheWrite = (entry: any): void => {
    pendingCacheWrites.push(entry);
    if (pendingCacheWrites.length >= FLUSH_THRESHOLD) {
      // Fire-and-forget flush; don't block resolve progress on it.
      // We awaited flushCache below at end-of-phase to ensure
      // durability; intermediate flushes are best-effort.
      flushCache().catch(() => { /* swallowed; logged inside */ });
    }
  };

  // ── Resolution helpers ────────────────────────────────────────────────
  const NPM_REGISTRY = 'https://registry.npmjs.org';

  const versionToResolved = (vData: any): ResolvedPackage => {
    const binField = vData.bin || {};
    const bin: Record<string, string> = typeof binField === 'string'
      ? { [vData.name.split('/').pop()!]: binField }
      : binField;
    return {
      name: vData.name,
      version: vData.version,
      tarballUrl: vData.dist?.tarball || '',
      integrity: vData.dist?.integrity || vData.dist?.shasum || '',
      dependencies: vData.dependencies || {},
      exports: vData.exports ?? null,
      main: vData.main || '',
      module: vData.module || '',
      bin,
    };
  };

  const cachedEntryToResolved = (entry: FacetCachedEntry): ResolvedPackage => {
    let deps: any = {}, exp: any = null, bin: any = {};
    try { deps = JSON.parse(entry.depsJson); } catch {}
    try { exp = JSON.parse(entry.exportsJson); } catch {}
    try { bin = JSON.parse(entry.binJson); } catch {}
    return {
      name: entry.name,
      version: entry.version,
      tarballUrl: entry.tarballUrl,
      integrity: entry.integrity,
      dependencies: deps,
      exports: exp,
      main: entry.main,
      module: entry.moduleField,
      bin,
    };
  };

  const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  };

  const fetchPackumentWithRetry = async (name: string): Promise<any | null> => {
    const safeName = name.startsWith('@')
      ? '@' + encodeURIComponent(name.slice(1))
      : encodeURIComponent(name);
    const url = NPM_REGISTRY + '/' + safeName;
    const BACKOFF = [500, 1500, 4500];
    const totalRetries = Math.max(0, spec.retries ?? 3);
    let lastErr: any;
    for (let attempt = 0; attempt <= totalRetries; attempt++) {
      try {
        inFlight++;
        if (inFlight > inFlightPeak) inFlightPeak = inFlight;
        const resp = await fetchWithTimeout(url, spec.fetchTimeoutMs ?? 15000);
        try {
          if (resp.ok) {
            const text = await resp.text();
            lastPackumentBytes = text.length;
            lastPackumentName = name;
            cumulativeBytesDecoded += text.length;
            packumentsDecoded++;
            return JSON.parse(text);
          }
          if (resp.status >= 400 && resp.status < 500) return null;
          // 5xx → drain + retry
          try { await resp.body?.cancel(); } catch {}
          lastErr = new Error('HTTP ' + resp.status);
        } finally {
          inFlight--;
        }
      } catch (e: any) {
        inFlight = Math.max(0, inFlight - 1);
        lastErr = e;
      }
      if (attempt < totalRetries) {
        const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
        const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
        await new Promise<void>((r) => setTimeout(r, Math.max(0, jitter)));
      }
    }
    messages.push(`[resolve-facet] ${name}: fetch exhausted: ${lastErr?.message || lastErr}`);
    return null;
  };

  /** Try to resolve a package using only the in-memory cache. Returns
   *  null if no cached version satisfies the range. */
  const resolveFromCache = (name: string, range: string): ResolvedPackage | null => {
    const inner = cacheByName.get(name);
    if (!inner || inner.size === 0) return null;
    const cleanRange = range.replace(/^[~^>=<\s]+/, '');
    if (cleanRange.match(/^\d+\.\d+\.\d+$/)) {
      const exact = inner.get(cleanRange);
      if (exact) return cachedEntryToResolved(exact);
    }
    const versions = [...inner.keys()];
    // @ts-ignore — RESOLVE_VERSION provided by preamble.
    const picked = RESOLVE_VERSION(versions, range);
    if (!picked) return null;
    const entry = inner.get(picked);
    return entry ? cachedEntryToResolved(entry) : null;
  };

  /** Resolve one spec: cache-hit or fetch packument. */
  const resolveOne = async (name: string, range: string): Promise<ResolvedPackage | null> => {
    // @ts-ignore — SHOULD_SKIP_PACKAGE provided by preamble.
    if (SHOULD_SKIP_PACKAGE(name)) return null;

    const cached = resolveFromCache(name, range);
    if (cached) return cached;

    const data = await fetchPackumentWithRetry(name);
    if (!data || !data.versions) return null;

    // Pick a version
    let version: string | null = null;
    if (range && data.versions[range]) version = range;
    if (!version && range && range !== 'latest') {
      const allVersions = Object.keys(data.versions);
      // @ts-ignore — preamble.
      version = RESOLVE_VERSION(allVersions, range);
    }
    if (!version) {
      version = data['dist-tags']?.[range] || data['dist-tags']?.latest || null;
    }
    if (!version || !data.versions[version]) {
      messages.push(`[resolve-facet] ${name}: no version satisfies ${range}`);
      return null;
    }

    const vData = data.versions[version];
    const pkg = versionToResolved(vData);

    // Stage cache writes for the resolved version + a few popular ones.
    enqueueCacheWrite({
      name: pkg.name,
      version: pkg.version,
      tarballUrl: pkg.tarballUrl,
      integrity: pkg.integrity,
      depsJson: JSON.stringify(pkg.dependencies),
      exportsJson: JSON.stringify(pkg.exports ?? {}),
      main: pkg.main,
      moduleField: pkg.module,
      binJson: JSON.stringify(pkg.bin),
      fetchedAt: Date.now(),
    });

    // Cache other recent versions to dodge re-fetches on retransitive deps.
    const sorted = Object.keys(data.versions)
      // @ts-ignore — preamble.
      .map((v) => ({ v, p: PARSE_SEMVER(v) }))
      .filter((x) => x.p !== null)
      // @ts-ignore — preamble.
      .sort((a, b) => COMPARE_SEMVER(b.p, a.p));
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
      const otherVer = sorted[i].v;
      if (otherVer === pkg.version) continue;
      const otherData = data.versions[otherVer];
      if (!otherData) continue;
      try {
        const otherPkg = versionToResolved(otherData);
        enqueueCacheWrite({
          name: otherPkg.name,
          version: otherPkg.version,
          tarballUrl: otherPkg.tarballUrl,
          integrity: otherPkg.integrity,
          depsJson: JSON.stringify(otherPkg.dependencies),
          exportsJson: JSON.stringify(otherPkg.exports ?? {}),
          main: otherPkg.main,
          moduleField: otherPkg.module,
          binJson: JSON.stringify(otherPkg.bin),
          fetchedAt: Date.now(),
        });
        // Also keep the in-memory cache up to date for further iterations.
        let inner = cacheByName.get(otherPkg.name);
        if (!inner) { inner = new Map(); cacheByName.set(otherPkg.name, inner); }
        inner.set(otherPkg.version, {
          name: otherPkg.name,
          version: otherPkg.version,
          tarballUrl: otherPkg.tarballUrl,
          integrity: otherPkg.integrity,
          depsJson: JSON.stringify(otherPkg.dependencies),
          exportsJson: JSON.stringify(otherPkg.exports ?? {}),
          main: otherPkg.main,
          moduleField: otherPkg.module,
          binJson: JSON.stringify(otherPkg.bin),
          fetchedAt: Date.now(),
        });
      } catch { /* skip malformed */ }
    }

    return pkg;
  };

  // ── Breadth-first walk (mirror of npm-resolver.ts:resolveTree) ───────
  const resolved = new Map<string, ResolvedPackage>();
  const seen = new Set<string>();
  const queue2: [string, string][] = Object.entries(spec.specs);

  while (queue2.length > 0) {
    const batch = queue2.splice(0, Math.min(queue2.length, concurrency));
    const results = await Promise.all(
      batch.map(([name, range]) =>
        limit(async () => {
          if (seen.has(name)) return null;
          seen.add(name);
          // @ts-ignore — preamble.
          if (SHOULD_SKIP_PACKAGE(name)) return null;
          try {
            return await resolveOne(name, range);
          } catch (e: any) {
            messages.push(`[resolve-facet] ${name}: UNHANDLED: ${e?.message}`);
            return null;
          }
        }),
      ),
    );

    for (const pkg of results) {
      if (!pkg || resolved.has(pkg.name)) continue;
      resolved.set(pkg.name, pkg);
      for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
        if (!resolved.has(depName) && !seen.has(depName)) {
          queue2.push([depName, depRange as string]);
        }
      }
    }
  }

  // Final cache flush before returning.
  await flushCache();

  return {
    resolved: [...resolved.values()],
    messages,
    facetCounters: {
      inFlightPeak,
      cumulativeBytesDecoded,
      packumentsDecoded,
      lastPackumentName,
      lastPackumentBytes,
    },
    elapsed: Date.now() - t0,
    cacheWriteCount: totalCacheWrites,
  };
};
