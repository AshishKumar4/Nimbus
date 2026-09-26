/**
 * resolve-one-facet.ts — per-package resolution task body.
 *
 * Why this exists
 * ───────────────
 * The supervisor coordinates each dependency layer and submits packages as
 * independent fanout tasks. This file is the per-task body: one packument
 * fetch, one version pick, and edge extraction.
 *
 * Each task runs inside a Worker Loader isolate (Fanout routes
 * automatically: <5 = in-DO, ≥5 = peer-DO). The isolate is short-lived;
 * task body has its own ~128 MiB envelope. Parallelism = layer width
 * (capped at 32 by Fanout's MAX_PEER_FANOUT).
 *
 * Stability invariants (cloudflare-parallel serialises via fn.toString)
 * ───────────────────────────────────────────────────────────────────
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - All helpers (semver, exports, skip-list, registry decisions) are
 *     accessed via bare identifiers from the preamble:
 *
 *       SHOULD_SWAP(name) → { from, to } | null
 *       SHOULD_REJECT_FAIL(name) → { from, reason, suggest? } | null
 *       NATIVE_EXECUTABLE_REJECT(pkg) → { from, reason, suggest? } | null
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
 *   - Best-effort optional-peer tagging: the supervisor maintains the
 *     bestEffortNames set; the task returns the `pkg` raw and the
 *     supervisor decides whether a downstream reject silent-skips or
 *     propagates.
 *
 * What the task DOES do
 * ─────────────────────
 *   1. Apply swap / reject-fail registry policy.
 *   2. Try in-task cache from `cachedHit` (one entry shipped from
 *      supervisor's NpmCache).
 *   3. Ask env.SUPERVISOR.getPackument for the packument. Fetching the
 *      registry and filling the cross-tenant cache are supervisor-side;
 *      the facet only reads.
 *   4. Pick version via preamble's RESOLVE_VERSION.
 *   5. Materialise ResolvedPackage shape (versionToResolved-style).
 *   6. Stage cache writes for this version + top-5 recent versions.
 *      Returns them in `cacheWrites` so the supervisor can flush in one
 *      batched RPC.
 *   7. Return {pkg, deps, peerDeps, optionalDeps, allPeerDependencies,
 *      cacheWrites, messages, events, packumentBytesDecoded,
 *      packumentSource, error?}.
 */

import type { ResolvedPackage } from './resolver.js';
import type { FacetCachedEntry, FacetRegistryEvent } from './resolve-facet.js';

declare const __nimbusUseRpcResult: <T, R>(
  promise: Promise<T>,
  use: (value: T) => R | Promise<R>,
) => Promise<R>;

declare function NATIVE_EXECUTABLE_REJECT(pkg: ResolvedPackage): {
  from: string;
  reason: string;
  suggest?: string;
  transitive: 'fail';
} | undefined;

type StagedArtifactEntry = {
  from: string;
  bin: string;
  artifact: string;
  reason: string;
};

declare function STAGED_ARTIFACT(name: string): StagedArtifactEntry | undefined;

declare function STAGED_ARTIFACT_APPLY(
  pkg: { bin?: Record<string, string>; optionalDependencies?: Record<string, string>; os?: string[]; cpu?: string[]; libc?: string[] },
  entry: StagedArtifactEntry,
): void;

/**
 * Argument shape: ONE package's resolution work.
 *
 * cachedHit (optional): a FacetCachedEntry the supervisor already has
 * for this name. The task uses it to short-circuit the fetch when
 * it satisfies the requested range. If null/missing, the task asks the
 * supervisor for the packument.
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
  /** X.5-G G1: this spec came from an optionalDependencies edge, so
   *  platform-native bindings silent-skip rather than failing the parent. */
  isOptional: boolean;
  /** Per-fetch timeout (ms). Default 15_000. */
  fetchTimeoutMs: number;
  /** Retries for transient failures. Default 3. */
  retries: number;
  /** Registry origin the packument is read from (the install's `NPM_REGISTRY`). */
  registry: string;
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
   * packument. Empty for cache-hit-only resolutions.
   */
  cacheWrites: any[];
  /** [npm] log lines, forwarded by the supervisor. */
  messages: string[];
  /** Registry telemetry events to emitRegistryEvent. */
  events: FacetRegistryEvent[];
  /**
   * Diagnostic: how many bytes the task fetched/decoded. Folded into
   * the supervisor's facetCounters.
   */
  packumentBytesDecoded: number;
  packumentSource: 'cache-hit' | 'r2-cache' | 'network' | 'skipped';
  /**
   * Round trip of the packument read as this task observed it. Reported
   * verbatim in the supervisor's `npm http fetch` line, so it must stay a
   * measurement — zero when no read was issued.
   */
  packumentElapsedMs: number;
  /**
   * cache-obs-2: per-tier cache events captured during this resolve.
   *
   * Each entry records a single L2/L3/L4 hit-or-miss observed when
   * fetching the packument. All of them flow from the supervisor RPC
   * return (getPackument.events) — the facet observes no tier itself.
   *
   * Folded into the DO-side cache-stats singleton by installer.ts via
   * recordCacheStatEvents on the fanout return path (same pattern as
   * recordR2RaceCounters).
   *
   * Optional in the type so the supervisor defaults to [] when a facet
   * return omits it.
   */
  cacheStatEvents?: Array<
    | { kind: 'hit'; tier: 'L2' | 'L3' | 'L4'; cacheKind: 'packument'; bytes: number }
    | { kind: 'miss'; tier: 'L2' | 'L3' | 'L4'; cacheKind: 'packument' }
  >;
  /**
   * Why this task produced no package.
   *
   * `w6-reject` is a registry-policy verdict: the supervisor either
   * propagates it as a hard install failure or silent-skips it on a
   * best-effort optional-peer path.
   *
   * `unresolved` is a resolution FAILURE — the registry said no, the
   * fetch never succeeded, or the packument carried no usable version.
   * It exists so the supervisor can tell a failure apart from a
   * deliberate policy skip: without it both arrive as `pkg: null` and a
   * required dependency (plus its whole subtree) disappears from the
   * install while the command still reports success.
   *
   * A null `pkg` with no `error` means a deliberate skip, and those
   * always carry `packumentSource: 'skipped'`.
   */
  error?:
    | { type: 'w6-reject'; from: string; reason: string; suggest?: string }
    | { type: 'unresolved'; reason: string };
}

/**
 * Parse an npm spec into install-name / registry-name / range. `npm:`
 * aliases redirect the registry lookup to a different package while the
 * dep records the alias as the install name; everything else is the
 * identity. Shared with the installer's lockfile check (which reads the
 * inner range out of an alias spec) and re-declared in the loader
 * preamble so the facet's serialized body sees the same implementation.
 */
export function parseRegistryRequest(name: string, range: string) {
  const text = String(range || 'latest');
  if (!text.startsWith('npm:')) {
    return { installName: name, registryName: name, range: text, alias: false };
  }
  const target = text.slice(4);
  const findSeparator = (specText: string) => {
    if (!specText) return -1;
    if (specText[0] !== '@') return specText.indexOf('@');
    const slash = specText.indexOf('/');
    if (slash < 0) return -1;
    return specText.indexOf('@', slash + 1);
  };
  const splitAt = findSeparator(target);
  const registryName = splitAt >= 0 ? target.slice(0, splitAt) : target;
  const targetRange = splitAt >= 0 ? target.slice(splitAt + 1) : 'latest';
  return {
    installName: name,
    registryName: registryName || name,
    range: targetRange || 'latest',
    alias: true,
  };
}

/**
 * Per-package fanout task body. Serialised via fn.toString() and
 * dispatched by Fanout.submitMany — see installer.ts
 * resolveTreeViaFanout.
 *
 * Function signature MUST be `(spec, env)` so Fanout's
 * submitMany invocation `fn(item, env)` lines up.
 *
 * `env` is the loader-isolate env supplied by Fanout.
 * `env.SUPERVISOR` is the supervisor-rpc binding (putRegistryEntries,
 * getPackument).
 */
export const resolveOnePackumentInFacet = async function resolveOnePackumentInFacet(
  spec: ResolveOneSpec,
  env: {
    SUPERVISOR: {
      /**
       * The npm-metadata seam: cross-tenant cache read, registry fetch on
       * a miss, and the cache fill — all supervisor-side. The facet reads
       * packuments and never writes them.
       */
      getPackument: (
        name: string,
        options: { retries: number; timeoutMs: number; registry: string },
      ) => Promise<{
        json: string | null;
        source: 'r2-cache' | 'network';
        events: Array<
          | { kind: 'hit'; tier: string; cacheKind: string; bytes: number }
          | { kind: 'miss'; tier: string; cacheKind: string }
        >;
        status?: number;
        failure?: string;
      }>;
    };
  },
): Promise<ResolveOneResult> {
  const messages: string[] = [];
  const events: FacetRegistryEvent[] = [];
  const cacheWrites: any[] = [];
  const request = parseRegistryRequest(spec.name, spec.range);
  // cache-obs-2: per-resolve cache events. Filled by the L2/L3 path
  // (spliced from supervisor RPC return.events) and the L4 path
  // (post-network-fetch). Threaded through `out()` into the result.
  const cacheStatEvents: ResolveOneResult['cacheStatEvents'] = [];
  let packumentElapsedMs = 0;
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
    packumentElapsedMs,
    cacheStatEvents,
    error,
  });
  // npm parity: a table reject or a native-executable bin is a package
  // with no Workers-compatible build — real npm still installs it. The
  // advisory event tells the installer to print one `note:` line per
  // name and the resolution continues like any package.
  const emitAdvisory = (entry: { from: string; reason: string; suggest?: string }) => {
    events.push({
      type: 'advisory',
      from: entry.from,
      reason: entry.reason,
      suggest: entry.suggest,
      ctx: 'transitive',
    });
  };
  const outNativeExecutableReject = (
    pkg: ResolvedPackage,
    bytes: number,
    source: ResolveOneResult['packumentSource'],
  ): ResolveOneResult | null => {
    const reject = NATIVE_EXECUTABLE_REJECT(pkg);
    if (!reject) return null;
    if (spec.isOptional) {
      messages.push(`[npm] [skip] ${spec.name} — ${reject.reason}`);
      events.push({
        type: 'transitive-skip',
        from: spec.name,
        reason: reject.reason,
      });
      return out(null, bytes, 'skipped');
    }
    // Only an os/cpu/libc allowlist fails the install (EBADPLATFORM
    // parity); a native-executable bin is advisory — the package's JS
    // tree installs and the reason is reported as an advisory.
    // @ts-ignore — preamble.
    const platformReject = NATIVE_PLATFORM_REJECT(pkg);
    if (!platformReject) {
      emitAdvisory(reject);
      return null;
    }
    events.push({
      type: 'reject',
      from: platformReject.from,
      reason: platformReject.reason,
      suggest: platformReject.suggest,
      ctx: 'transitive',
    });
    return out(null, bytes, source, {
      type: 'w6-reject',
      from: platformReject.from,
      reason: platformReject.reason,
      suggest: platformReject.suggest,
    });
  };

  // 1. Registry policy.
  //
  // A swap is an npm alias the policy declares for the package: the
  // packument comes from the swap target, the package installs under the
  // requested name (`request.installName`) — exactly the shape an explicit
  // `name@npm:target@range` spec already has. Policy applies to the
  // REGISTRY identity, placement to the declared name: a top-level swap the
  // supervisor already rewrote (applySwaps, which also announced it)
  // arrives naming the WASM target and is not swapped again, while a user's
  // explicit alias to the native package (`build@npm:esbuild`) still needs
  // its target swapped — and keeps its own install name.
  let effName = request.registryName;
  // @ts-ignore — preamble.
  const __swap = SHOULD_SWAP(request.registryName);
  if (__swap) {
    messages.push(`[npm] \x1b[33m[swap]\x1b[0m ${__swap.from} → ${__swap.to}`);
    events.push({ type: 'swap', from: __swap.from, to: __swap.to, ctx: 'transitive' });
    effName = __swap.to;
  } else {
    // @ts-ignore — preamble.
    const __fail = SHOULD_REJECT_FAIL(request.registryName);
    // A listed package resolves and installs — npm parity; the
    // advisory names the reason it cannot run here. An alias of a listed
    // package (`img@npm:sharp`) is that package.
    if (__fail) emitAdvisory(__fail);
  }

  // 2. cachedHit fast-path. The pick over the cached versions is the same
  //    RESOLVE_VERSION the packument path uses — a range is never reduced
  //    to its base version. It used to be: `^3.0.0` was stripped to `3.0.0`
  //    and answered by a cached 3.0.0 even with 3.0.1 sitting beside it,
  //    which is how the second install in a session came back with lower
  //    versions than the first (measured: totalist, readdirp, mrmime,
  //    milliparsec, dot-prop, eta on json-server@1.0.0-beta.15).
  const cached = (() => {
    const entries = spec.cachedEntries || [];
    if (entries.length === 0) return null;
    const candidates = entries.filter((e) => e.name === request.installName);
    if (candidates.length === 0) return null;
    // @ts-ignore — preamble.
    const picked = RESOLVE_VERSION(candidates.map((e) => e.version), request.range);
    if (!picked) return null;
    return candidates.find((e) => e.version === picked) || null;
  })();

  if (cached) {
    let deps: Record<string, string> = {}, peers: Record<string, string> = {}, exp: unknown = null, bin: Record<string, string> = {};
    let platform: Record<string, unknown> = {}, optionalDeps: Record<string, string> = {};
    try { deps = JSON.parse(cached.depsJson); } catch {}
    try { peers = cached.peerDepsJson ? JSON.parse(cached.peerDepsJson) : {}; } catch {}
    try { exp = JSON.parse(cached.exportsJson); } catch {}
    try { bin = JSON.parse(cached.binJson); } catch {}
    try { platform = cached.platformJson ? JSON.parse(cached.platformJson) : {}; } catch {}
    try { optionalDeps = cached.optionalDepsJson ? JSON.parse(cached.optionalDepsJson) : {}; } catch {}
    const pkgFromCache: ResolvedPackage = {
      name: cached.name,
      version: cached.version,
      tarballUrl: cached.tarballUrl,
      integrity: cached.integrity,
      dependencies: deps,
      peerDependencies: Object.keys(peers).length > 0 ? peers : undefined,
      // Platform constraints + optionalDependencies round-trip so the
      // ABI policy makes the same decisions on warm-cache hits.
      optionalDependencies: Object.keys(optionalDeps).length > 0 ? optionalDeps : undefined,
      os:   Array.isArray(platform.os)   ? platform.os   : undefined,
      cpu:  Array.isArray(platform.cpu)  ? platform.cpu  : undefined,
      libc: Array.isArray(platform.libc) ? platform.libc : undefined,
      exports: exp,
      main: cached.main,
      module: cached.moduleField,
      bin,
    };
    const nativeReject = outNativeExecutableReject(pkgFromCache, 0, 'cache-hit');
    if (nativeReject) return nativeReject;
    return out(pkgFromCache, 0, 'cache-hit');
  }

  // 4 + 5. Packument, via the supervisor's npm-metadata seam.
  //
  // The facet does NOT fetch the registry and does NOT write the shared
  // packument cache. Both live in SupervisorRPC.getPackument, because a
  // packument dictates the tarball URL and integrity digest for every
  // tenant that reads it — a facet-supplied cache write would be a
  // cross-tenant code-execution primitive.
  let packumentText: string | null = null;
  let packumentSource: ResolveOneResult['packumentSource'] = 'network';
  if (!env?.SUPERVISOR || typeof env.SUPERVISOR.getPackument !== 'function') {
    messages.push(`[resolve-one] ${effName}: env.SUPERVISOR.getPackument missing`);
    return out(null, 0, 'network', {
      type: 'unresolved',
      reason: 'env.SUPERVISOR.getPackument missing',
    });
  }
  {
    const packumentStart = Date.now();
    const result = await __nimbusUseRpcResult(
      env.SUPERVISOR.getPackument(effName, {
        retries: Math.max(0, spec.retries ?? 3),
        timeoutMs: spec.fetchTimeoutMs ?? 15_000,
        registry: spec.registry,
      }),
      (r) => ({ json: r.json, source: r.source, events: r.events, status: r.status, failure: r.failure }),
    );
    packumentElapsedMs = Date.now() - packumentStart;
    // Splice the supervisor's per-tier events into our accumulator.
    // Filter to known tiers/kinds so a future schema change cannot
    // poison the result.
    if (Array.isArray(result.events)) {
      for (const e of result.events as any[]) {
        if (!e || (e.kind !== 'hit' && e.kind !== 'miss')) continue;
        if (e.tier !== 'L2' && e.tier !== 'L3' && e.tier !== 'L4') continue;
        if (e.cacheKind !== 'packument') continue;
        if (e.kind === 'hit') {
          cacheStatEvents!.push({
            kind: 'hit',
            tier: e.tier,
            cacheKind: 'packument',
            bytes: typeof e.bytes === 'number' ? e.bytes : 0,
          });
        } else {
          cacheStatEvents!.push({ kind: 'miss', tier: e.tier, cacheKind: 'packument' });
        }
      }
    }
    if (result.json === null) {
      if (result.status !== undefined) {
        // 4xx — the registry has no such package.
        messages.push(`[resolve-one] ${effName}: HTTP ${result.status}`);
        return out(null, 0, 'network', {
          type: 'unresolved',
          reason: `registry returned HTTP ${result.status} for ${effName}`,
        });
      }
      messages.push(`[resolve-one] ${effName}: fetch exhausted: ${result.failure}`);
      return out(null, 0, 'network', {
        type: 'unresolved',
        reason: `registry fetch failed for ${effName}: ${result.failure}`,
      });
    }
    packumentText = result.json;
    packumentSource = result.source === 'r2-cache' ? 'r2-cache' : 'network';
  }

  const bytes = packumentText.length;
  let data: any;
  try {
    data = JSON.parse(packumentText);
  } catch (e: any) {
    messages.push(`[resolve-one] ${effName}: malformed packument: ${e?.message ?? e}`);
    return out(null, bytes, packumentSource, {
      type: 'unresolved',
      reason: `malformed packument for ${effName}: ${e?.message ?? e}`,
    });
  }
  if (!data || !data.versions) {
    return out(null, bytes, packumentSource, {
      type: 'unresolved',
      reason: `packument for ${effName} carries no versions`,
    });
  }

  // 3. Pick version.
  let version: string | null = null;
  if (request.range && data.versions[request.range]) version = request.range;
  if (!version && request.range && request.range !== 'latest') {
    const allVersions = Object.keys(data.versions);
    // @ts-ignore — preamble.
    version = RESOLVE_VERSION(allVersions, request.range);
  }
  if (!version) {
    version = data['dist-tags']?.[request.range] || data['dist-tags']?.latest || null;
  }
  if (!version || !data.versions[version]) {
    messages.push(`[resolve-one] ${effName}: no version satisfies ${request.range}`);
    return out(null, bytes, packumentSource, {
      type: 'unresolved',
      reason: `no published version of ${effName} satisfies ${request.range}`,
    });
  }

  // 4. Materialise ResolvedPackage.
  const vData = data.versions[version];
  const versionToResolved = (v: any): ResolvedPackage => {
    const packageName = request.installName || v.name;
    const binField = v.bin || {};
    const bin: Record<string, string> = typeof binField === 'string'
      ? { [String(packageName).split('/').pop()!]: binField }
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
      name: packageName,
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
    // Staged-artifact rewrite: native-launcher packages install as their
    // prebuilt Nimbus JS bundle. STAGED_ARTIFACT_APPLY is the preamble copy
    // of the supervisor's policyApplyStagedArtifact (package-abi-policy.mjs
    // enforces parity), so the facet performs the identical rewrite.
    const staged = STAGED_ARTIFACT(packageName);
    if (staged) STAGED_ARTIFACT_APPLY(resolvedOut, staged);
    return resolvedOut as ResolvedPackage;
  };
  const pkg = versionToResolved(vData);
  const nativeReject = outNativeExecutableReject(pkg, bytes, packumentSource);
  if (nativeReject) return nativeReject;

  // 5. Stage cache writes.
  cacheWrites.push({
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
    platformJson: JSON.stringify({ os: pkg.os, cpu: pkg.cpu, libc: pkg.libc }),
    optionalDepsJson: JSON.stringify(pkg.optionalDependencies ?? {}),
    fetchedAt: Date.now(),
  });
  // Top-5 sibling versions.
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
        moduleField: otherPkg.module,
        binJson: JSON.stringify(otherPkg.bin),
        platformJson: JSON.stringify({ os: otherPkg.os, cpu: otherPkg.cpu, libc: otherPkg.libc }),
        optionalDepsJson: JSON.stringify(otherPkg.optionalDependencies ?? {}),
        fetchedAt: Date.now(),
      });
    } catch { /* skip malformed */ }
  }

  return out(pkg, bytes, packumentSource);
};
