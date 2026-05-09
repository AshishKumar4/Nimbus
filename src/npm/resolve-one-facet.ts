/**
 * resolve-one-facet.ts — F-2 frontier-coordinator per-package task body.
 *
 * Why this exists
 * ───────────────
 * F-2 (cleanup-not-done wave) replaces the single resolve-facet that
 * runs the WHOLE BFS in one isolate with a frontier-coordinator at the
 * supervisor that submits each layer of N packages as N independent
 * fanout tasks. This file is the per-task body — one packument fetch +
 * version pick + edge-extraction.
 *
 * Each task runs inside a Worker Loader isolate (NimbusFanoutPool routes
 * automatically: <5 = in-DO, ≥5 = peer-DO). The isolate is short-lived;
 * task body has its own ~128 MiB envelope. Parallelism = layer width
 * (capped at 32 by NimbusFanoutPool's MAX_PEER_FANOUT).
 *
 * Stability invariants (cloudflare-parallel serialises via fn.toString)
 * ───────────────────────────────────────────────────────────────────
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - All helpers (semver, exports, skip-list, registry decisions) are
 *     accessed via bare identifiers from the preamble:
 *
 *       SHOULD_SKIP_PACKAGE(name, frameworkAware) → boolean
 *       SHOULD_SWAP(name) → { from, to } | null
 *       SHOULD_WARN_SKIP_TRANSITIVE(name) → { from, reason } | null
 *       SHOULD_REJECT_FAIL(name) → { from, reason, suggest? } | null
 *       PARSE_SEMVER(v) → [maj, min, patch] | null
 *       COMPARE_SEMVER(a, b) → number
 *       RESOLVE_VERSION(versions, range) → string | null
 *
 * What the task does NOT do (supervisor responsibility)
 * ─────────────────────────────────────────────────────
 *   - Edge extraction: the supervisor pulls deps/peerDeps/optionalDeps
 *     out of the returned `pkg` and decides what goes in layer N+1.
 *   - Cycle detection: the supervisor maintains the `seen` set across
 *     layers. The task only sees one (name, range) per call.
 *   - X.5-drizzle best-effort tagging: the supervisor maintains the
 *     bestEffortNames set; the task returns the `pkg` raw and the
 *     supervisor decides whether a downstream reject silent-skips or
 *     propagates.
 *   - X.5-F top-level handling: the supervisor maintains topLevelNames.
 *     `topLevel` is passed in per task so SKIP_PACKAGES bypass works.
 *
 * What the task DOES do
 * ─────────────────────
 *   1. Apply SKIP_PACKAGES filter (unless `topLevel`).
 *   2. Apply W6 swap / warn-skip / reject-fail registry policy.
 *   3. Try in-task cache from `cachedHit` (one entry shipped from
 *      supervisor's NpmCache).
 *   4. R2 packument cache race (250 ms timeout) via env.SUPERVISOR
 *      bindings.
 *   5. Fetch packument with retry/backoff if no cache hit.
 *   6. Pick version via preamble's RESOLVE_VERSION.
 *   7. Materialise ResolvedPackage shape (versionToResolved-style).
 *   8. Stage cache writes for this version + top-5 recent versions
 *      (mirrors resolve-facet.ts:580). Returns them in `cacheWrites`
 *      so the supervisor can flush in one batched RPC.
 *   9. Return {pkg, deps, peerDeps, optionalDeps, allPeerDependencies,
 *      cacheWrites, messages, events, packumentBytesDecoded,
 *      packumentSource, error?}.
 */

import type { ResolvedPackage } from './resolver.js';
import type { FacetCachedEntry, FacetRegistryEvent } from './resolve-facet.js';

/**
 * Argument shape: ONE package's resolution work.
 *
 * cachedHit (optional): a FacetCachedEntry the supervisor already has
 * for this name. The task uses it to short-circuit the fetch when
 * it satisfies the requested range. If null/missing, the task fetches
 * the packument directly (or hits the R2 packument cache via the
 * env binding).
 */
export interface ResolveOneSpec {
  name: string;
  range: string;
  /**
   * Pre-shipped cache entries for THIS name only. Bounded to ≤16 (top
   * versions) so the per-task RPC payload stays small. The task picks
   * the best version that satisfies range.
   */
  cachedEntries: FacetCachedEntry[];
  /**
   * X.5-F R1: when true, this package was either user-typed OR a
   * required peer-dep enqueued by the supervisor. Bypasses
   * SKIP_PACKAGES. The supervisor decides the flag at enqueue time.
   */
  topLevel: boolean;
  /** Same X.5-G G1 semantics as resolve-facet.ts. */
  isOptional: boolean;
  /** W11 framework-aware skip. */
  frameworkAware: boolean;
  /** Per-fetch timeout (ms). Default 15_000. */
  fetchTimeoutMs: number;
  /** Retries for transient failures. Default 3. */
  retries: number;
}

export interface ResolveOneResult {
  /** Resolved package, or null if a registry policy filtered it out. */
  pkg: ResolvedPackage | null;
  /**
   * Edge sets that the supervisor uses to build layer N+1.
   * Empty when pkg === null.
   */
  deps: Record<string, string>;
  peerDeps: Record<string, string>;
  optionalDeps: Record<string, string>;
  allPeerDependencies: Record<string, string>;
  /**
   * Cache writes the task is asking the supervisor to flush. Includes
   * the resolved version + up to 5 recent versions seen in the
   * packument (mirrors resolve-facet.ts:580). Empty for cache-hit-
   * only resolutions.
   */
  cacheWrites: any[];
  /** [npm] log lines, forwarded by the supervisor. */
  messages: string[];
  /** W6.5 telemetry events to emitRegistryEvent. */
  events: FacetRegistryEvent[];
  /**
   * Diagnostic: how many bytes the task fetched/decoded. Folded into
   * supervisor's facetCounters for parity with resolve-facet.ts.
   */
  packumentBytesDecoded: number;
  packumentSource: 'cache-hit' | 'r2-cache' | 'network' | 'skipped';
  /**
   * W6 reject. The supervisor inspects this and either propagates
   * (regular path) or silent-skips (X.5-drizzle best-effort path) —
   * the task doesn't see bestEffortNames.
   */
  error?: { type: 'w6-reject'; from: string; reason: string; suggest?: string } | { type: 'fetch-exhausted'; message: string };
}

/**
 * Per-package fanout task body. Serialised via fn.toString() and
 * dispatched by NimbusFanoutPool.submitMany — see installer.ts
 * resolveTreeViaFanout.
 *
 * Function signature MUST be `(spec, env)` so NimbusFanoutPool's
 * submitMany invocation `fn(item, env)` lines up.
 *
 * `env` is the loader-isolate env supplied by NimbusFanoutPool.
 * `env.SUPERVISOR` is the supervisor-rpc binding (putRegistryEntries,
 * getCachedPackument, putCachedPackument).
 */
export const resolveOnePackumentInFacet = async function resolveOnePackumentInFacet(
  spec: ResolveOneSpec,
  env: {
    SUPERVISOR: {
      // [W4] Optional R2 packument cache. Soft-fail via typeof checks.
      getCachedPackument?: (name: string) => Promise<{ json: string; ageMs: number; expired: boolean } | null>;
      putCachedPackument?: (name: string, json: string) => Promise<boolean>;
    };
  },
): Promise<ResolveOneResult> {
  const messages: string[] = [];
  const events: FacetRegistryEvent[] = [];
  const cacheWrites: any[] = [];
  const out = (
    pkg: ResolvedPackage | null,
    bytes: number,
    source: ResolveOneResult['packumentSource'],
    error?: ResolveOneResult['error'],
  ): ResolveOneResult => ({
    pkg,
    deps: pkg?.dependencies ?? {},
    peerDeps: pkg?.peerDependencies ?? {},
    optionalDeps: ((pkg as any)?.optionalDependencies as Record<string, string>) ?? {},
    allPeerDependencies: ((pkg as any)?.__allPeerDependencies as Record<string, string>) ?? {},
    cacheWrites,
    messages,
    events,
    packumentBytesDecoded: bytes,
    packumentSource: source,
    error,
  });

  // 1. SKIP_PACKAGES gate.
  // @ts-ignore — preamble.
  if (!spec.topLevel && SHOULD_SKIP_PACKAGE(spec.name, !!spec.frameworkAware)) {
    return out(null, 0, 'skipped');
  }

  // 2. W6 registry policy.
  let effName = spec.name;
  // @ts-ignore — preamble.
  const __swap = SHOULD_SWAP(spec.name);
  if (__swap) {
    messages.push(`[npm] \x1b[33m[swap]\x1b[0m ${__swap.from} → ${__swap.to}`);
    events.push({ type: 'swap', from: __swap.from, to: __swap.to, ctx: 'transitive' });
    effName = __swap.to;
  } else {
    // @ts-ignore — preamble.
    const __warn = SHOULD_WARN_SKIP_TRANSITIVE(spec.name);
    if (__warn) {
      messages.push(`[npm] \x1b[33m[skip]\x1b[0m ${__warn.from} — ${__warn.reason}`);
      events.push({ type: 'transitive-skip', from: __warn.from, reason: __warn.reason });
      return out(null, 0, 'skipped');
    }
    // @ts-ignore — preamble.
    const __fail = SHOULD_REJECT_FAIL(spec.name);
    if (__fail) {
      events.push({
        type: 'reject',
        from: __fail.from,
        reason: __fail.reason,
        suggest: __fail.suggest,
        ctx: 'transitive',
      });
      return out(null, 0, 'skipped', {
        type: 'w6-reject',
        from: __fail.from,
        reason: __fail.reason,
        suggest: __fail.suggest,
      });
    }
  }

  // 3. cachedHit fast-path.
  const cached = (() => {
    const entries = spec.cachedEntries || [];
    if (entries.length === 0) return null;
    const cleanRange = (spec.range || '').replace(/^[~^>=<\s]+/, '');
    if (/^\d+\.\d+\.\d+$/.test(cleanRange)) {
      const exact = entries.find((e) => e.name === effName && e.version === cleanRange);
      if (exact) return exact;
    }
    const candidates = entries.filter((e) => e.name === effName);
    if (candidates.length === 0) return null;
    const versions = candidates.map((e) => e.version);
    // @ts-ignore — preamble.
    const picked = RESOLVE_VERSION(versions, spec.range);
    if (!picked) return null;
    return candidates.find((e) => e.version === picked) || null;
  })();

  if (cached) {
    let deps: any = {}, peers: any = {}, exp: any = null, bin: any = {};
    try { deps = JSON.parse(cached.depsJson); } catch {}
    try { peers = cached.peerDepsJson ? JSON.parse(cached.peerDepsJson) : {}; } catch {}
    try { exp = JSON.parse(cached.exportsJson); } catch {}
    try { bin = JSON.parse(cached.binJson); } catch {}
    const pkgFromCache: ResolvedPackage = {
      name: cached.name,
      version: cached.version,
      tarballUrl: cached.tarballUrl,
      integrity: cached.integrity,
      dependencies: deps,
      peerDependencies: Object.keys(peers).length > 0 ? peers : undefined,
      exports: exp,
      main: cached.main,
      module: cached.moduleField,
      bin,
    } as any;
    return out(pkgFromCache, 0, 'cache-hit');
  }

  // 4 + 5. R2 race + network fetch.
  const NPM_REGISTRY = 'https://registry.npmjs.org';
  const safeName = effName.startsWith('@')
    ? '@' + encodeURIComponent(effName.slice(1))
    : encodeURIComponent(effName);
  const url = NPM_REGISTRY + '/' + safeName;
  const R2_RACE_MS = 250;
  const totalRetries = Math.max(0, spec.retries ?? 3);
  const fetchTimeoutMs = spec.fetchTimeoutMs ?? 15_000;

  // [W4] R2 race.
  let packumentText: string | null = null;
  let packumentSource: ResolveOneResult['packumentSource'] = 'network';
  if (env?.SUPERVISOR && typeof env.SUPERVISOR.getCachedPackument === 'function') {
    try {
      const r2P = Promise.race<any>([
        env.SUPERVISOR.getCachedPackument!(effName),
        new Promise<null>((rs) => setTimeout(() => rs(null), R2_RACE_MS)),
      ]).catch(() => null);
      const r2 = await r2P;
      if (r2 && !r2.expired && r2.json) {
        packumentText = r2.json as string;
        packumentSource = 'r2-cache';
      }
    } catch { /* best-effort, fall through */ }
  }

  if (packumentText === null) {
    const BACKOFF = [500, 1500, 4500];
    let lastErr: any;
    for (let attempt = 0; attempt <= totalRetries; attempt++) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), fetchTimeoutMs);
        let resp: Response;
        try {
          resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
        } finally {
          clearTimeout(t);
        }
        if (resp.ok) {
          packumentText = await resp.text();
          // [W4] Best-effort R2 write-back. Awaited per W4-plan §11.
          if (env?.SUPERVISOR && typeof env.SUPERVISOR.putCachedPackument === 'function') {
            try { await env.SUPERVISOR.putCachedPackument(effName, packumentText); } catch { /* swallow */ }
          }
          break;
        }
        if (resp.status >= 400 && resp.status < 500) {
          // 4xx — package or version doesn't exist. Treat as null.
          messages.push(`[resolve-one] ${effName}: HTTP ${resp.status}`);
          return out(null, 0, 'network');
        }
        try { await resp.body?.cancel(); } catch {}
        lastErr = new Error('HTTP ' + resp.status);
      } catch (e: any) {
        lastErr = e;
      }
      if (attempt < totalRetries) {
        const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
        const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
        await new Promise<void>((r) => setTimeout(r, Math.max(0, jitter)));
      }
    }
    if (packumentText === null) {
      messages.push(`[resolve-one] ${effName}: fetch exhausted: ${lastErr?.message ?? lastErr}`);
      return out(null, 0, 'network', { type: 'fetch-exhausted', message: String(lastErr?.message ?? lastErr) });
    }
  }

  const bytes = packumentText.length;
  let data: any;
  try {
    data = JSON.parse(packumentText);
  } catch (e: any) {
    messages.push(`[resolve-one] ${effName}: malformed packument: ${e?.message ?? e}`);
    return out(null, bytes, packumentSource);
  }
  if (!data || !data.versions) {
    return out(null, bytes, packumentSource);
  }

  // 6. Pick version.
  let version: string | null = null;
  if (spec.range && data.versions[spec.range]) version = spec.range;
  if (!version && spec.range && spec.range !== 'latest') {
    const allVersions = Object.keys(data.versions);
    // @ts-ignore — preamble.
    version = RESOLVE_VERSION(allVersions, spec.range);
  }
  if (!version) {
    version = data['dist-tags']?.[spec.range] || data['dist-tags']?.latest || null;
  }
  if (!version || !data.versions[version]) {
    messages.push(`[resolve-one] ${effName}: no version satisfies ${spec.range}`);
    return out(null, bytes, packumentSource);
  }

  // 7. Materialise ResolvedPackage.
  const vData = data.versions[version];
  const versionToResolved = (v: any): ResolvedPackage => {
    const binField = v.bin || {};
    const bin: Record<string, string> = typeof binField === 'string'
      ? { [String(v.name).split('/').pop()!]: binField }
      : binField;
    let peerDependencies: Record<string, string> | undefined;
    let allPeers: Record<string, string> | undefined;
    const peers = v.peerDependencies;
    if (peers && typeof peers === 'object') {
      const meta = v.peerDependenciesMeta;
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
    const optionalDependencies =
      v.optionalDependencies && typeof v.optionalDependencies === 'object'
        ? Object.fromEntries(Object.entries(v.optionalDependencies).filter(([, r]) => typeof r === 'string')) as Record<string, string>
        : undefined;
    const resolvedOut: any = {
      name: v.name,
      version: v.version,
      tarballUrl: v.dist?.tarball || '',
      integrity: v.dist?.integrity || v.dist?.shasum || '',
      dependencies: v.dependencies || {},
      peerDependencies,
      optionalDependencies,
      os: Array.isArray(v.os) ? v.os : undefined,
      cpu: Array.isArray(v.cpu) ? v.cpu : undefined,
      libc: Array.isArray(v.libc) ? v.libc : undefined,
      exports: v.exports ?? null,
      main: v.main || '',
      module: v.module || '',
      bin,
    };
    if (allPeers) resolvedOut.__allPeerDependencies = allPeers;
    return resolvedOut as ResolvedPackage;
  };
  const pkg = versionToResolved(vData);

  // 8. Stage cache writes.
  cacheWrites.push({
    name: pkg.name,
    version: pkg.version,
    tarballUrl: pkg.tarballUrl,
    integrity: pkg.integrity,
    depsJson: JSON.stringify(pkg.dependencies),
    peerDepsJson: JSON.stringify(pkg.peerDependencies ?? {}),
    exportsJson: JSON.stringify(pkg.exports ?? {}),
    main: pkg.main,
    moduleField: (pkg as any).module,
    binJson: JSON.stringify(pkg.bin),
    fetchedAt: Date.now(),
  });
  // Top-5 sibling versions, mirrors resolve-facet.ts:580.
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
      cacheWrites.push({
        name: otherPkg.name,
        version: otherPkg.version,
        tarballUrl: otherPkg.tarballUrl,
        integrity: otherPkg.integrity,
        depsJson: JSON.stringify(otherPkg.dependencies),
        peerDepsJson: JSON.stringify(otherPkg.peerDependencies ?? {}),
        exportsJson: JSON.stringify(otherPkg.exports ?? {}),
        main: otherPkg.main,
        moduleField: (otherPkg as any).module,
        binJson: JSON.stringify(otherPkg.bin),
        fetchedAt: Date.now(),
      });
    } catch { /* skip malformed */ }
  }

  return out(pkg, bytes, packumentSource);
};
