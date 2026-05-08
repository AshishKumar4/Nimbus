/**
 * npm-resolve-facet.ts — NimbusLoaderPool entry for the npm resolver phase.
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
 * The fix is to dispatch the entire resolver phase to a NimbusLoaderPool
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

import type { ResolvedPackage } from './resolver.js';

// ── Types exchanged between supervisor and facet ─────────────────────────

export interface FacetCachedEntry {
  /** Same shape as RegistryCacheEntry from src/npm-cache.ts. JSON-only
   *  fields so the structured-clone over RPC doesn't choke. */
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  depsJson: string;
  /** X.5-F R2: required peerDependencies (optionals filtered). Optional
   *  for backward compat with supervisor builds that pre-date X.5-F. */
  peerDepsJson?: string;
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
  /** W11: when true, FRAMEWORK_REQUIRED_PACKAGES (vite, …) are exempted
   *  from the skip list. See audit/sections/W11-plan.md §3.0. */
  frameworkAware?: boolean;
}

/**
 * W6.5: Telemetry-event mirror of `RegistryEvent` (defined in
 * `src/wasm-swap-registry.ts`). The facet cannot import the registry
 * (preamble has no import surface), so the type is duplicated here.
 * Parity is gated by audit/probes/w6.5/regression/event-fires-from-facet.mjs.
 */
export type FacetRegistryEvent =
  | { type: 'swap'; from: string; to: string; ctx: 'transitive' }
  | { type: 'reject'; from: string; reason: string; suggest?: string; ctx: 'transitive' }
  | { type: 'transitive-skip'; from: string; reason: string };

export interface ResolveFacetResult {
  /** Resolved packages, lean (no packument retained). */
  resolved: ResolvedPackage[];
  /** Per-spec status messages — surfaced into the install log as
   *  `[resolve-facet] <line>`. Bounded to ~one line per resolved spec. */
  messages: string[];
  /**
   * W6.5: registry decisions taken inside the facet (swap / transitive-
   * skip / reject). Drained by the supervisor and forwarded to the
   * registry sink via `emitRegistryEvent`. See npm-installer.ts.
   *
   * Note: throw-path reject events do NOT reach this field today (the
   * facet throws before returning). Documented gap in W6.5-plan §5.3.
   */
  registryEvents: FacetRegistryEvent[];
  /** Counter snapshot at end of phase. Mirrors src/diag-counters.ts shape
   *  for the resolver subset, so the supervisor can fold these into its
   *  own counters before responding to /api/_diag/memory. */
  facetCounters: {
    inFlightPeak: number;
    cumulativeBytesDecoded: number;
    packumentsDecoded: number;
    lastPackumentName: string;
    lastPackumentBytes: number;
    /** [W4] Pipelined-RPC race outcomes for the packument cache. */
    pipelinedPackumentRaceWins: number;
    pipelinedPackumentRaceLosses: number;
  };
  /** Wall-clock elapsed inside the facet. */
  elapsed: number;
  /** Cache writes the facet flushed back via env.SUPERVISOR.putRegistryEntries. */
  cacheWriteCount: number;
}

// ── Facet function ──────────────────────────────────────────────────────
//
// `resolveTreeInFacet` is serialised via fn.toString() and run inside a
// NimbusLoaderPool isolate. It references the following symbols by bare
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
      // [W4] Optional R2 packument cache. Soft-fail via typeof checks
      // below so this facet keeps working against older deployments.
      getCachedPackument?: (name: string) => Promise<{ json: string; ageMs: number; expired: boolean } | null>;
      putCachedPackument?: (name: string, json: string) => Promise<boolean>;
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
  // [W4] Pipelined-RPC race outcomes. Folded into supervisor diag via
  // recordR2RaceCounters() in npm-installer.
  let pipelinedPackumentRaceWins = 0;
  let pipelinedPackumentRaceLosses = 0;

  // [W4] Cap on how long we wait for an R2 packument GET before
  // committing to the network response. 250 ms covers typical regional
  // R2 latency (30-150 ms) with margin; bounded enough that worst-case
  // miss adds only 250 ms × packumentsDecoded / pLimit-bound to wall
  // clock — typically ≤ 1 s on Mossaic-class. Tunable via spec, but
  // the default suits prod; keep a constant here to avoid wire changes.
  const R2_PACKUMENT_RACE_TIMEOUT_MS = 250;

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
    // X.5-F R2: surface required peerDeps (optionals filtered) so the
    // BFS walk can enqueue them. Mirrors npm-resolver.ts versionToResolved.
    let peerDependencies: Record<string, string> | undefined;
    let allPeers: Record<string, string> | undefined;
    const peers = vData.peerDependencies;
    if (peers && typeof peers === 'object') {
      const meta = vData.peerDependenciesMeta;
      const required: Record<string, string> = {};
      const all: Record<string, string> = {};
      for (const [n, r] of Object.entries(peers)) {
        if (typeof r !== 'string') continue;
        all[n] = r;
        if (meta && meta[n] && meta[n].optional === true) continue;
        required[n] = r;
      }
      if (Object.keys(required).length > 0) peerDependencies = required;
      if (Object.keys(all).length > 0) allPeers = all;
    }
    // X.5-G G1: optionalDependencies + platform constraints (mirror of
    // npm-resolver.ts:504). Surfaced for the BFS walk so the resolver
    // knows which deps are best-effort and can apply silent-skip rules.
    const optionalDependencies =
      vData.optionalDependencies && typeof vData.optionalDependencies === 'object'
        ? Object.fromEntries(
            Object.entries(vData.optionalDependencies)
              .filter(([, r]) => typeof r === 'string'),
          ) as Record<string, string>
        : undefined;

    const out: any = {
      name: vData.name,
      version: vData.version,
      tarballUrl: vData.dist?.tarball || '',
      integrity: vData.dist?.integrity || vData.dist?.shasum || '',
      dependencies: vData.dependencies || {},
      peerDependencies,
      optionalDependencies,
      os:   Array.isArray(vData.os)   ? vData.os   : undefined,
      cpu:  Array.isArray(vData.cpu)  ? vData.cpu  : undefined,
      libc: Array.isArray(vData.libc) ? vData.libc : undefined,
      exports: vData.exports ?? null,
      main: vData.main || '',
      module: vData.module || '',
      bin,
    };
    if (allPeers) out.__allPeerDependencies = allPeers;
    return out as ResolvedPackage;
  };

  const cachedEntryToResolved = (entry: FacetCachedEntry): ResolvedPackage => {
    let deps: any = {}, peers: any = {}, exp: any = null, bin: any = {};
    try { deps = JSON.parse(entry.depsJson); } catch {}
    try { peers = entry.peerDepsJson ? JSON.parse(entry.peerDepsJson) : {}; } catch {}
    try { exp = JSON.parse(entry.exportsJson); } catch {}
    try { bin = JSON.parse(entry.binJson); } catch {}
    return {
      name: entry.name,
      version: entry.version,
      tarballUrl: entry.tarballUrl,
      integrity: entry.integrity,
      dependencies: deps,
      // X.5-F R2: surface peerDeps from cache hits so the BFS still
      // enqueues peers when we don't re-fetch the packument.
      peerDependencies: Object.keys(peers).length > 0 ? peers : undefined,
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

    // [W4] R2 packument cache race. Kick off the cache lookup with a
    // bounded wait; if it returns fresh JSON before the timeout, we
    // skip the network entirely. Soft-fail when env.SUPERVISOR.getCachedPackument
    // isn't available (older deployment).
    const r2Available = typeof env.SUPERVISOR.getCachedPackument === 'function';
    if (r2Available) {
      try {
        const r2P = Promise.race([
          env.SUPERVISOR.getCachedPackument!(name),
          new Promise<null>((rs) => setTimeout(() => rs(null), R2_PACKUMENT_RACE_TIMEOUT_MS)),
        ]).catch(() => null);
        const r2 = await r2P;
        if (r2 && !r2.expired && r2.json) {
          pipelinedPackumentRaceWins++;
          lastPackumentBytes = r2.json.length;
          lastPackumentName = name;
          cumulativeBytesDecoded += r2.json.length;
          packumentsDecoded++;
          try {
            return JSON.parse(r2.json);
          } catch {
            // Malformed cache entry: fall through to network.
            messages.push(`[resolve-facet] ${name}: malformed R2 packument; falling through`);
          }
        }
      } catch {
        // best-effort; fall through to network
      }
    }
    pipelinedPackumentRaceLosses++;

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
            // [W4] Write back to R2 cache (best-effort, non-blocking).
            // The packument JSON gets a 5-minute TTL via supervisor.
            // We DO await this RPC: per W4-plan §11 finding #2, the
            // facet's lifecycle ends when resolveTreeInFacet returns;
            // unawaited puts may be torn down before R2 commits.
            // Cost: one extra ~30 ms RPC per network-miss packument;
            // mitigated by pLimit hiding it behind concurrent work.
            if (typeof env.SUPERVISOR.putCachedPackument === 'function') {
              try {
                await env.SUPERVISOR.putCachedPackument(name, text);
              } catch {
                // best-effort cache write
              }
            }
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

  // X.5-F R1: names the user typed at the top level + required peer-deps
  // bypass SKIP_PACKAGES. Populated lazily as the BFS walk discovers
  // peer-deps. See audit/sections/X5F-plan.md §6.1-§6.2.
  const topLevelNames = new Set<string>(Object.keys(spec.specs));

  /** Resolve one spec: cache-hit or fetch packument. */
  const resolveOne = async (name: string, range: string): Promise<ResolvedPackage | null> => {
    // @ts-ignore — SHOULD_SKIP_PACKAGE provided by preamble.
    if (!topLevelNames.has(name) && SHOULD_SKIP_PACKAGE(name, !!spec.frameworkAware)) return null;

    // W6: registry transitive policy. Swap rewrites name in flight;
    // 'fail' rejects throw; 'warn' rejects log [skip] and drop.
    // W6.5: each decision also pushes a RegistryEvent into __pendingEvents
    // (preamble-provided), drained by the supervisor after the facet
    // returns. NOTE: the throw-path reject case below stops execution
    // BEFORE __DRAIN_EVENTS is read by the caller — so reject events
    // from the facet are an accepted incomplete-coverage gap (W6.5-plan
    // §5.3). We still push them in case a future caller change drains
    // events from the rejected ResolveFacetResult.
    let effName = name;
    // @ts-ignore — SHOULD_SWAP provided by preamble.
    const __swap = SHOULD_SWAP(name);
    if (__swap) {
      messages.push(`[npm] \x1b[33m[swap]\x1b[0m ${__swap.from} → ${__swap.to}`);
      // @ts-ignore — preamble.
      __EMIT_EVENT({ type: 'swap', from: __swap.from, to: __swap.to, ctx: 'transitive' });
      effName = __swap.to;
    } else {
      // @ts-ignore — preamble.
      const __warn = SHOULD_WARN_SKIP_TRANSITIVE(name);
      if (__warn) {
        messages.push(`[npm] \x1b[33m[skip]\x1b[0m ${__warn.from} — ${__warn.reason}`);
        // @ts-ignore — preamble.
        __EMIT_EVENT({ type: 'transitive-skip', from: __warn.from, reason: __warn.reason });
        return null;
      }
      // @ts-ignore — preamble.
      const __fail = SHOULD_REJECT_FAIL(name);
      if (__fail) {
        // @ts-ignore — preamble.
        __EMIT_EVENT({
          type: 'reject',
          from: __fail.from,
          reason: __fail.reason,
          suggest: __fail.suggest,
          ctx: 'transitive',
        });
        // Tag with own-property so the BFS catch can identify a
        // registry reject without relying on message-prefix string
        // matching. Mirror of supervisor-side RegistryRejectError.
        const err: any = new Error(`npm install rejected: ${__fail.from} — ${__fail.reason}`);
        err.__w6_reject = true;
        err.__w6_reject_from = __fail.from;
        err.__w6_reject_reason = __fail.reason;
        throw err;
      }
    }

    const cached = resolveFromCache(effName, range);
    if (cached) return cached;

    const data = await fetchPackumentWithRetry(effName);
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
      messages.push(`[resolve-facet] ${effName}: no version satisfies ${range}`);
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
      peerDepsJson: JSON.stringify(pkg.peerDependencies ?? {}),
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
          peerDepsJson: JSON.stringify(otherPkg.peerDependencies ?? {}),
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
          peerDepsJson: JSON.stringify(otherPkg.peerDependencies ?? {}),
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

  // X.5-G G1: facet-side mirror of isOptionalNativeBinding from
  // src/wasm-swap-registry.ts. The facet body is serialised via
  // fn.toString() and cannot import — local helpers are inlined here.
  // Keep this byte-equivalent in shape with the registry export.
  const NATIVE_SHARD_PREFIXES_FACET = [
    '@rollup/rollup-', '@parcel/watcher-', '@swc/core-', '@next/swc-',
    '@tailwindcss/oxide-', '@img/sharp-', '@napi-rs/canvas-',
    '@biomejs/cli-', '@esbuild/',
  ];
  const isOptionalNativeBindingFacet = (p: any): boolean => {
    if (!p) return false;
    if (Array.isArray(p.os)   && p.os.length   > 0) return true;
    if (Array.isArray(p.cpu)  && p.cpu.length  > 0) return true;
    if (Array.isArray(p.libc) && p.libc.length > 0) return true;
    if (typeof p.main === 'string' && /\.node$/.test(p.main)) return true;
    if (typeof p.name === 'string') {
      for (const prefix of NATIVE_SHARD_PREFIXES_FACET) {
        if (p.name.startsWith(prefix) && p.name.length > prefix.length) {
          if (p.name === '@rollup/wasm-node') return false;
          return true;
        }
      }
    }
    return false;
  };

  // ── Breadth-first walk (mirror of npm-resolver.ts:resolveTree) ───────
  const resolved = new Map<string, ResolvedPackage>();
  const seen = new Set<string>();
  const optionalNames = new Set<string>();  // X.5-G G1
  // X.5-drizzle: names enqueued by the X.5-J top-level optional-peer
  // path (R2.5) and ALL their transitive descendants. The user did not
  // explicitly ask for them — npm CLI's --include=peer pulls them as a
  // best-effort convenience. When a `transitive: 'fail'` REJECT_INSTALL
  // fires for a name in this set, we silent-skip the offending name +
  // log a notice, instead of throwing and killing the parent install.
  // Pre-X.5-drizzle, drizzle-orm's optional peer `expo-sqlite` (its
  // peer `expo` → dep `@expo/metro-config` → dep `lightningcss`) hard-
  // killed the install once X.5-26b made lightningcss `transitive:
  // 'fail'`. The user only typed `npm install drizzle-orm`; expo-sqlite
  // and its mobile-build chain are best-effort by intent. See
  // audit/sections/X5-drizzle-plan.md §2 (revised) and the trace probe
  // audit/probes/x5-drizzle/investigation/04-trace-lightningcss-from-drizzle.mjs.
  const bestEffortNames = new Set<string>();
  const queue2: [string, string][] = Object.entries(spec.specs);

  while (queue2.length > 0) {
    const batch = queue2.splice(0, Math.min(queue2.length, concurrency));
    const results = await Promise.all(
      batch.map(([name, range]) =>
        limit(async () => {
          if (seen.has(name)) return null;
          seen.add(name);
          // @ts-ignore — preamble.
          // X.5-F R1: top-level + required peer-deps bypass SKIP_PACKAGES.
          if (!topLevelNames.has(name) && SHOULD_SKIP_PACKAGE(name, !!spec.frameworkAware)) return null;
          const isOptional = optionalNames.has(name);
          try {
            const pkg = await resolveOne(name, range);
            // X.5-G G1: silent-skip platform-native bindings sourced
            // from optionalDependencies. Mirrors npm-resolver.ts.
            if (pkg && isOptional && isOptionalNativeBindingFacet({
              name: pkg.name,
              os: (pkg as any).os, cpu: (pkg as any).cpu, libc: (pkg as any).libc,
              main: pkg.main,
            })) {
              const reason = `optional native binding (os=${(pkg as any).os ?? '*'}, cpu=${(pkg as any).cpu ?? '*'}, libc=${(pkg as any).libc ?? '*'}, main=${pkg.main || '?'})`;
              messages.push(`[resolve-facet] [skip] ${name} — ${reason}`);
              // @ts-ignore — preamble.
              __EMIT_EVENT({ type: 'transitive-skip', from: name, reason });
              return null;
            }
            return pkg;
          } catch (e: any) {
            // W6: REJECT_INSTALL with transitive='fail' throws from
            // resolveOne tagged with `__w6_reject = true`. Propagate
            // those — turning them into "UNHANDLED" log lines would
            // silently partial-install. Other UNHANDLEDs continue to
            // log + drop. Detection via own-property survives the
            // postMessage / fn.toString() boundary (prototype is lost
            // on that boundary, so `instanceof` would not work).
            if (e && typeof e === 'object' && (e as any).__w6_reject === true) {
              // X.5-drizzle: REJECT_INSTALL transitive='fail' that fires
              // INSIDE an X.5-J best-effort optional-peer subtree
              // (R2.5 enqueue) softly skips the offending package
              // instead of failing the parent install. The user did
              // not explicitly ask for the optional-peer-rooted
              // subtree; mirror npm's --omit=optional behaviour for
              // its descendants. See VERIFY-9D4B61D §6 + the trace
              // probe at audit/probes/x5-drizzle/investigation/
              // 04-trace-lightningcss-from-drizzle.mjs for the
              // canonical drizzle-orm → expo-sqlite → expo → @expo/
              // metro-config → lightningcss chain.
              if (bestEffortNames.has(name)) {
                const reason = `inside best-effort optional-peer subtree (X.5-drizzle): ${e?.message ?? 'reject'}`;
                messages.push(`[resolve-facet] [skip] ${name} — ${reason}`);
                // @ts-ignore — preamble.
                __EMIT_EVENT({ type: 'transitive-skip', from: name, reason });
                return null;
              }
              throw e;
            }
            // X.5-G G1: optional-dep fetch failures silent-skip rather
            // than propagating as UNHANDLED.
            if (isOptional) {
              const reason = `optional dep fetch failed: ${e?.message ?? 'unknown'}`;
              messages.push(`[resolve-facet] [skip] ${name} — ${reason}`);
              // @ts-ignore — preamble.
              __EMIT_EVENT({ type: 'transitive-skip', from: name, reason });
              return null;
            }
            const msg = e?.message || String(e);
            messages.push(`[resolve-facet] ${name}: UNHANDLED: ${msg}`);
            return null;
          }
        }),
      ),
    );

    for (const pkg of results) {
      if (!pkg || resolved.has(pkg.name)) continue;
      resolved.set(pkg.name, pkg);
      // X.5-drizzle: when this pkg was best-effort (a child of an
      // X.5-J optional-peer subtree), its newly-enqueued descendants
      // inherit the best-effort flag so a deep `transitive: 'fail'`
      // REJECT_INSTALL silent-skips instead of killing the parent.
      const inheritBestEffort = bestEffortNames.has(pkg.name);
      for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
        if (!resolved.has(depName) && !seen.has(depName)) {
          if (inheritBestEffort) bestEffortNames.add(depName);
          queue2.push([depName, depRange as string]);
        }
      }
      // X.5-G G1: enqueue transitive optionalDependencies (tagged so
      // resolveOne silent-skips platform-native bindings). Mirrors
      // npm-resolver.ts.
      const optDeps = (pkg as any).optionalDependencies as Record<string, string> | undefined;
      if (optDeps) {
        for (const [depName, depRange] of Object.entries(optDeps)) {
          if (!resolved.has(depName) && !seen.has(depName)) {
            optionalNames.add(depName);
            if (inheritBestEffort) bestEffortNames.add(depName);
            queue2.push([depName, depRange as string]);
          }
        }
      }
      // X.5-F R2: enqueue REQUIRED peerDeps. Mirrors npm-resolver.ts
      // resolveTree. Mark them as topLevel so they bypass SKIP_PACKAGES
      // (typescript is a peer of ts-jest).
      if (pkg.peerDependencies) {
        for (const [peerName, peerRange] of Object.entries(pkg.peerDependencies)) {
          if (resolved.has(peerName) || seen.has(peerName)) continue;
          topLevelNames.add(peerName);
          if (inheritBestEffort) bestEffortNames.add(peerName);
          queue2.push([peerName, peerRange as string]);
        }
      }
      // X.5-F R2.5: when THIS pkg is the user's top-level request,
      // also enqueue OPTIONAL peer-deps (npm CLI's --include=peer
      // default). Without this, framer-motion installs but its
      // compiled CJS still imports react/jsx-runtime.
      //
      // X.5-J: optional peers whose target is in REJECT_INSTALL get
      // SOFT-SKIPPED at enqueue time. Mirror of npm-resolver.ts:R2.5.
      // Uses preamble-injected SHOULD_REJECT_FAIL +
      // SHOULD_WARN_SKIP_TRANSITIVE accessors (the facet body is
      // serialised via fn.toString() and cannot import lookupReject).
      // See audit/sections/X5J-plan.md §3 for the full rationale and
      // §3.6 for why we soft-skip BOTH transitive='fail' (loud reject)
      // and transitive='warn' optional peers — symmetry with the
      // existing transitive walk's silent-skip of warn-tier peers, plus
      // a small efficiency win (no resolveOne roundtrip needed).
      if (topLevelNames.has(pkg.name)) {
        const allPeers = (pkg as any).__allPeerDependencies as Record<string, string> | undefined;
        if (allPeers) {
          for (const [peerName, peerRange] of Object.entries(allPeers)) {
            if (resolved.has(peerName) || seen.has(peerName)) continue;
            // X.5-J: filter optional peers through REJECT_INSTALL.
            // @ts-ignore — preamble.
            const __peerFail = SHOULD_REJECT_FAIL(peerName);
            // @ts-ignore — preamble.
            const __peerWarn = SHOULD_WARN_SKIP_TRANSITIVE(peerName);
            const __peerReject = __peerFail || __peerWarn;
            if (__peerReject) {
              const reason = `optional peer in REJECT_INSTALL: ${peerName} — ${__peerReject.reason}`;
              messages.push(`[resolve-facet] [skip] ${peerName} — ${reason}`);
              // @ts-ignore — preamble.
              __EMIT_EVENT({ type: 'transitive-skip', from: peerName, reason });
              continue;  // do NOT seen.add — let a later required-dep
                         // walk hit it via its own resolveOne path.
            }
            topLevelNames.add(peerName);
            // X.5-drizzle: tag the optional-peer enqueue as best-effort
            // so a deep `transitive: 'fail'` REJECT (e.g.,
            // expo-sqlite → expo → @expo/metro-config → lightningcss)
            // silent-skips the offending sub-tree instead of killing
            // the parent (drizzle-orm) install.
            bestEffortNames.add(peerName);
            queue2.push([peerName, peerRange as string]);
          }
        }
      }
    }
  }

  // Final cache flush before returning.
  await flushCache();

  return {
    resolved: [...resolved.values()],
    messages,
    // @ts-ignore — preamble-provided drain helper.
    registryEvents: typeof __DRAIN_EVENTS === 'function' ? __DRAIN_EVENTS() : [],
    facetCounters: {
      inFlightPeak,
      cumulativeBytesDecoded,
      packumentsDecoded,
      lastPackumentName,
      lastPackumentBytes,
      pipelinedPackumentRaceWins,
      pipelinedPackumentRaceLosses,
    },
    elapsed: Date.now() - t0,
    cacheWriteCount: totalCacheWrites,
  };
};
