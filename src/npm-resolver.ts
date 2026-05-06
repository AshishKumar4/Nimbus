/**
 * npm-resolver.ts — Semver resolution, exports field, and hoisting for Nimbus npm v2.
 *
 * Provides:
 *   1. Proper semver parsing + range matching (^, ~, >=, ||, *, x ranges)
 *   2. Node.js-spec exports field resolution with conditions
 *   3. Aggressive hoisting algorithm (one copy of each version at the highest level)
 *   4. Build-only package skip list
 */

import type { NpmCache, RegistryCacheEntry } from './npm-cache.js';
import { retryableFetch, DEFAULT_RETRIES } from './retry.js';
import {
  setResolverPhase,
  packumentFetchStart, packumentFetchEnd, responseStubDisposed,
} from './diag-counters.js';
import {
  lookupSwap, lookupReject, shouldWarnSkipTransitive,
  formatSwapNotice, formatTransitiveSkip, RegistryRejectError,
  emitRegistryEvent,
  isOptionalNativeBinding, classifyInstallError,
} from './wasm-swap-registry.js';
// W2.6a D6: resolver-unification. The single source of truth for
// exports-field / package-entry resolution lives in
// src/_shared/exports-resolver.ts. Callers that need these helpers
// import directly from that module — no thin wrappers re-exported
// from this file. (Pre-W2.6a we kept thin re-exports here for back-
// compat; they were redundant and tripped a `grep "function resolve*"`
// test that wants exactly one impl.)

const NPM_REGISTRY = 'https://registry.npmjs.org';
/** Max concurrent registry fetches. Bounded to avoid ephemeral port exhaustion. */
const RESOLVE_CONCURRENCY = 6;
/** Timeout for registry fetches (ms). Aborts if DO fetch hangs. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Injectable fetch function. Allows the caller to route fetches through a
 * facet worker (required because DO fetch() hangs in wrangler local dev).
 * Falls back to global fetch() if not provided.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Simple concurrency limiter. Prevents ephemeral port exhaustion when
 * making many fetch() calls through a single proxy worker.
 */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  return <T>(fn: () => Promise<T>): Promise<T> => {
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
}

// ── Types ───────────────────────────────────────────────────────────────

export interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  dependencies: Record<string, string>;
  /** X.5-F R2: required peer-deps surfaced for auto-install. Optional
   *  peers (peerDependenciesMeta.<name>.optional === true) are
   *  excluded here. */
  peerDependencies?: Record<string, string>;
  /** X.5-G G1: optionalDependencies — best-effort installs that are
   *  silently skipped when the host doesn't match os/cpu/libc OR when
   *  the packument shape is a known native-shard pattern. Per npm 4828
   *  semantics: failure to install MUST NOT fail the parent. */
  optionalDependencies?: Record<string, string>;
  /** X.5-G G1: platform constraints from the registry. Empty arrays
   *  mean cross-platform. Non-empty means the package opts out of
   *  installs on hosts that don't match. */
  os?: string[];
  cpu?: string[];
  libc?: string[];
  exports: any;          // package.json exports field (raw)
  main: string;
  module: string;
  bin: Record<string, string>;
}

export interface HoistPlan {
  /** Root-level hoisted packages: name → ResolvedPackage */
  root: Map<string, ResolvedPackage>;
  /**
   * Nested packages that couldn't be hoisted due to version conflicts.
   * Key: "parentName/childName", Value: ResolvedPackage
   */
  nested: Map<string, ResolvedPackage>;
}

// ── Semver ──────────────────────────────────────────────────────────────

/** Parse a semver string into [major, minor, patch, prerelease?]. */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
}

/** Compare two semver tuples. Returns <0, 0, >0. */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Check if version satisfies a single comparator (^, ~, >=, >, <=, <, =, exact). */
function satisfiesComparator(version: string, comparator: string): boolean {
  const comp = comparator.trim();
  if (!comp || comp === '*' || comp === 'latest' || comp === '' || comp === 'x') return true;

  // Handle >= <= > < = prefixes
  let op = '';
  let rangeStr = comp;
  const prefixMatch = comp.match(/^([~^]|>=|<=|>|<|=)\s*/);
  if (prefixMatch) {
    op = prefixMatch[1];
    rangeStr = comp.slice(prefixMatch[0].length);
  }

  // Handle x-ranges: 1.x, 1.2.x, 1.x.x
  rangeStr = rangeStr.replace(/\.x/g, '.0');
  if (rangeStr.match(/^\d+$/)) rangeStr += '.0.0';
  else if (rangeStr.match(/^\d+\.\d+$/)) rangeStr += '.0';

  const vParts = parseSemver(version);
  const rParts = parseSemver(rangeStr);
  if (!vParts || !rParts) return false;

  const cmp = compareSemver(vParts, rParts);

  switch (op) {
    case '^': {
      // ^major.minor.patch: >=X.Y.Z <(next major)
      // ^0.Y.Z: >=0.Y.Z <0.(Y+1).0
      // ^0.0.Z: >=0.0.Z <0.0.(Z+1)
      if (rParts[0] > 0) {
        return vParts[0] === rParts[0] && cmp >= 0;
      }
      if (rParts[1] > 0) {
        return vParts[0] === 0 && vParts[1] === rParts[1] && cmp >= 0;
      }
      return vParts[0] === 0 && vParts[1] === 0 && vParts[2] === rParts[2];
    }
    case '~': {
      // ~major.minor.patch: >=X.Y.Z <X.(Y+1).0
      return vParts[0] === rParts[0] && vParts[1] === rParts[1] && vParts[2] >= rParts[2];
    }
    case '>=': return cmp >= 0;
    case '>':  return cmp > 0;
    case '<=': return cmp <= 0;
    case '<':  return cmp < 0;
    case '=':  return cmp === 0;
    default: {
      // No prefix: if original had no prefix and looks like a version, treat as ^
      // This handles "1.2.3" which npm treats as "^1.2.3" in package.json
      if (comp.match(/^\d/)) {
        // Exact match for unprefixed versions
        return cmp === 0;
      }
      return cmp === 0;
    }
  }
}

/**
 * Check if a version satisfies a full range expression.
 * Supports || (OR), space (AND within a range set), hyphen ranges.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest' || trimmed === '') return true;

  // Split on || for OR logic
  const orParts = trimmed.split(/\s*\|\|\s*/);
  for (const orPart of orParts) {
    // Handle hyphen range: 1.0.0 - 2.0.0 → >=1.0.0 <=2.0.0
    const hyphen = orPart.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) {
      if (satisfiesComparator(version, '>=' + hyphen[1]) &&
          satisfiesComparator(version, '<=' + hyphen[2])) {
        return true;
      }
      continue;
    }

    // Split on space for AND logic within a range set
    const andParts = orPart.trim().split(/\s+/);
    const allMatch = andParts.every(part => satisfiesComparator(version, part));
    if (allMatch) return true;
  }
  return false;
}

/** Find the highest version matching a range from a list of versions. */
export function resolveVersion(versions: string[], range: string): string | null {
  if (!range || range === 'latest' || range === '*' || range === '') return null;

  const matching = versions.filter(v => {
    // Skip pre-release versions unless the range specifically targets them
    if (v.includes('-') && !range.includes('-')) return false;
    return satisfiesRange(v, range);
  });

  if (matching.length === 0) return null;

  // Sort descending, pick highest
  matching.sort((a, b) => {
    const ap = parseSemver(a);
    const bp = parseSemver(b);
    if (!ap || !bp) return 0;
    return compareSemver(bp, ap);
  });

  return matching[0];
}

// ── Package resolution ──────────────────────────────────────────────────

/**
 * Resolve a single package from the registry.
 * Checks cache first, then fetches from npm.
 */
export async function resolvePackage(
  name: string,
  versionRange: string,
  cache: NpmCache,
  fetchFn?: FetchFn,
  log?: (msg: string) => void,
): Promise<ResolvedPackage | null> {
  // 1. Check for exact version in registry cache
  try {
    const cleanRange = versionRange.replace(/^[~^>=<\s]+/, '');
    if (cleanRange.match(/^\d+\.\d+\.\d+$/)) {
      const cached = cache.getRegistryEntry(name, cleanRange);
      if (cached) {
        log?.(`  ${name}: found exact ${cleanRange} in cache`);
        return registryCacheToResolved(cached);
      }
    }

    // 2. Check if we have cached versions to resolve against
    const cachedVersions = cache.getRegistryVersions(name);
    if (cachedVersions.length > 0) {
      const isDistTag = !versionRange || versionRange === 'latest' || versionRange === '*' || versionRange === '';

      if (isDistTag) {
        // "latest", "*", "" → pick the highest cached version (sort descending)
        const sorted = cachedVersions
          .map(e => ({ entry: e, parsed: parseSemver(e.version) }))
          .filter(x => x.parsed !== null)
          .sort((a, b) => compareSemver(b.parsed!, a.parsed!));
        if (sorted.length > 0) {
          log?.(`  ${name}: resolved ${versionRange || '(empty)'} → ${sorted[0].entry.version} (highest cached)`);
          return registryCacheToResolved(sorted[0].entry);
        }
      } else {
        // Semver range: try to match against cached versions
        const versions = cachedVersions.map(e => e.version);
        const resolved = resolveVersion(versions, versionRange);
        if (resolved) {
          const entry = cachedVersions.find(e => e.version === resolved);
          if (entry) {
            log?.(`  ${name}: resolved ${versionRange} → ${resolved} from cache`);
            return registryCacheToResolved(entry);
          }
        }
        // Cached versions exist but none match — only skip fetch if cache is fresh
        const newest = Math.max(...cachedVersions.map(e => e.fetchedAt));
        if (Date.now() - newest < 3600_000) {
          log?.(`  ${name}: ${cachedVersions.length} cached versions, none match ${versionRange}, cache fresh`);
          return null;
        }
      }
    }
  } catch (e: any) {
    // Cache read failed (schema issue, corrupt data, etc.) — fall through to network
    log?.(`  ${name}: cache read error: ${e?.message}`);
  }

  // 3. Fetch from registry
  log?.(`  ${name}: fetching from registry (${fetchFn ? 'proxy' : 'direct'})...`);
  setResolverPhase('fetching');
  packumentFetchStart(name);
  let data: any;
  let bytesDecoded = 0;
  try {
    const safeName = name.startsWith('@')
      ? '@' + encodeURIComponent(name.slice(1))
      : encodeURIComponent(name);
    const url = `${NPM_REGISTRY}/${safeName}`;

    // retryableFetch: 3 retries on 5xx/network errors with jittered
    // exponential backoff. Per-attempt timeout = the prior single-attempt
    // budget (FETCH_TIMEOUT_MS) — fresh AbortController per attempt so a
    // slow failure doesn't eat the whole retry window. fetchFn is
    // forwarded so proxy-fetch paths keep working.
    const resp: Response = await retryableFetch(url, {
      headers: { 'Accept': 'application/json' },
    }, {
      retries: DEFAULT_RETRIES,
      name,
      fetchImpl: fetchFn,
      perAttemptTimeoutMs: FETCH_TIMEOUT_MS,
      onRetry: (attempt, total, delayMs, reason) => {
        log?.(`  ${name}: retry ${attempt}/${total} after ${delayMs}ms (${reason})`);
      },
    });

    log?.(`  ${name}: registry responded ${resp.status}`);
    // Dispose the (potentially RPC-stub-backed) Response explicitly once
    // the body is consumed / dropped. When fetchFn is the supervisor fetch
    // proxy, `resp` is a cross-isolate stub returned from
    // entrypoint.fetch(...). Those stubs auto-dispose only at the end of
    // the enclosing event-handler context — which for `npm install` means
    // the stubs from ALL ~200 packument fetches stay live until the whole
    // install completes. That accumulation is the trigger for
    // "An RPC result was not disposed properly" warnings and the
    // workerd queueState != ACTIVE fatal seen during cold-start installs
    // (see WORKERD-CRASH.md / FINAL-H2-STATUS.md §4). Explicit disposal
    // releases each stub immediately after we finish reading it, keeping
    // the live-stub count at O(1) instead of O(packages resolved).
    try {
      if (!resp.ok) {
        return null;
      }
      // Read body as text first so we know its size for diag accounting,
      // THEN parse. Saves nothing memory-wise (one extra string copy)
      // but is essential for surfacing `cumulativePackumentBytesDecoded`
      // — the smoking gun that proves the resolver-OOM hypothesis.
      // The text+parse split also gives us a chance to surface a
      // honest decoded size to the diag layer even when the proxy
      // didn't advertise Content-Length.
      setResolverPhase('parsing');
      const text = await resp.text();
      bytesDecoded = text.length;
      data = JSON.parse(text);
    } finally {
      // Symbol.dispose is ES2023; our tsconfig targets ES2022 so we reach
      // it via the any-cast. At runtime workerd provides the symbol on
      // RPC stubs; on plain Response objects the getter simply returns
      // undefined and the try-block is a no-op.
      const disposerKey = (Symbol as any).dispose;
      const disposer = disposerKey ? (resp as any)?.[disposerKey] : undefined;
      if (typeof disposer === 'function') {
        try { disposer.call(resp); responseStubDisposed(); }
        catch { /* best-effort */ }
      } else {
        // Plain Response — there is no stub to leak, but balance the
        // counter we incremented at packumentFetchStart() so
        // liveResponseStubs reflects reality.
        responseStubDisposed();
      }
    }
  } catch (e: any) {
    log?.(`  ${name}: fetch error: ${e?.message}`);
    // Balance counters even on the error path. responseStubDisposed
    // was either already called in the finally above (if we got past
    // retryableFetch) or not — the safe move is to always run
    // packumentFetchEnd which is paired with packumentFetchStart.
    packumentFetchEnd(0);
    return null;
  }
  packumentFetchEnd(bytesDecoded);

  if (!data.versions) {
    log?.(`  ${name}: no versions field in packument`);
    return null;
  }

  // Resolve version
  let version: string | null = null;

  // Try exact match
  if (versionRange && data.versions[versionRange]) {
    version = versionRange;
  }

  // Try range resolution
  if (!version && versionRange && versionRange !== 'latest') {
    const allVersions = Object.keys(data.versions);
    version = resolveVersion(allVersions, versionRange);
  }

  // Try dist-tags
  if (!version) {
    version = data['dist-tags']?.[versionRange] || data['dist-tags']?.latest || null;
  }

  if (!version || !data.versions[version]) {
    log?.(`  ${name}: could not resolve version for range ${versionRange}`);
    return null;
  }

  log?.(`  ${name}: resolved → ${version}`);

  const vData = data.versions[version];
  const pkg = versionToResolved(vData);

  setResolverPhase('caching');
  // Cache the resolved version (non-fatal — if caching fails, we still return the package)
  try {
    cache.putRegistryEntry({
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
  } catch (e: any) {
    console.error(`[npm-resolve] cache write failed for ${name}@${version}:`, e?.message);
  }

  // Also cache other popular versions from the packument (non-fatal)
  try {
    cachePopularVersions(data, cache, pkg.version);
  } catch (e: any) {
    console.error(`[npm-resolve] popular version cache failed for ${name}:`, e?.message);
  }

  return pkg;
}

/**
 * Cache the latest + a few other versions from a packument.
 * Avoids re-fetching the full packument for transitive deps that reference
 * the same package with a different range.
 */
function cachePopularVersions(data: any, cache: NpmCache, alreadyCached: string): void {
  const versions = Object.keys(data.versions || {});
  // Cache the latest dist-tag version if different
  const latest = data['dist-tags']?.latest;
  const toCacheVersions = new Set<string>();
  if (latest && latest !== alreadyCached) toCacheVersions.add(latest);

  // Cache the 5 most recent versions (transitive deps often reference recent versions)
  const sorted = versions
    .map(v => ({ v, p: parseSemver(v) }))
    .filter(x => x.p !== null)
    .sort((a, b) => compareSemver(b.p!, a.p!));

  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    if (sorted[i].v !== alreadyCached) toCacheVersions.add(sorted[i].v);
  }

  for (const ver of toCacheVersions) {
    const vData = data.versions[ver];
    if (!vData) continue;
    try {
      const pkg = versionToResolved(vData);
      cache.putRegistryEntry({
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
    } catch { /* skip invalid version data */ }
  }
}

/** Convert npm registry version data to ResolvedPackage. */
function versionToResolved(vData: any): ResolvedPackage {
  const binField = vData.bin || {};
  const bin: Record<string, string> = typeof binField === 'string'
    ? { [vData.name.split('/').pop()!]: binField }
    : binField;

  // X.5-F R2.5: keep the full peer set (including optionals) on a
  // hidden field so the BFS walk can include optional peers when
  // THIS package was the user's top-level request (npm CLI default).
  const allPeers = vData.peerDependencies && typeof vData.peerDependencies === 'object'
    ? Object.fromEntries(
        Object.entries(vData.peerDependencies)
          .filter(([, r]) => typeof r === 'string'),
      ) as Record<string, string>
    : undefined;

  // X.5-G G1: capture optionalDependencies + os/cpu/libc constraints.
  // The resolver consumes these to decide silent-skip per npm 4828.
  const optionalDependencies =
    vData.optionalDependencies && typeof vData.optionalDependencies === 'object'
      ? Object.fromEntries(
          Object.entries(vData.optionalDependencies)
            .filter(([, r]) => typeof r === 'string'),
        ) as Record<string, string>
      : undefined;

  const out: ResolvedPackage & { __allPeerDependencies?: Record<string, string> } = {
    name: vData.name,
    version: vData.version,
    tarballUrl: vData.dist?.tarball || '',
    integrity: vData.dist?.integrity || vData.dist?.shasum || '',
    dependencies: vData.dependencies || {},
    // X.5-F R2: surface required peer-deps (optionals filtered) so
    // the resolveTree breadth-first walk can enqueue them. Without
    // this, packages like @radix-ui/react-dialog (peer: react,
    // react-dom) get installed but their `require('react')` from
    // inside the nested dist fails at runtime.
    peerDependencies: extractRequiredPeers(vData),
    optionalDependencies,
    os:   Array.isArray(vData.os)   ? vData.os   : undefined,
    cpu:  Array.isArray(vData.cpu)  ? vData.cpu  : undefined,
    libc: Array.isArray(vData.libc) ? vData.libc : undefined,
    exports: vData.exports ?? null,
    main: vData.main || '',
    module: vData.module || '',
    bin,
  };
  if (allPeers && Object.keys(allPeers).length > 0) {
    out.__allPeerDependencies = allPeers;
  }
  return out;
}

/**
 * Extract the SUBSET of `peerDependencies` that are not marked optional
 * via `peerDependenciesMeta.<name>.optional === true`. Returns undefined
 * when there are no required peers, so downstream code can use a single
 * truthiness check.
 *
 * X.5-F R2 — see audit/sections/X5F-plan.md §3.
 */
function extractRequiredPeers(vData: any): Record<string, string> | undefined {
  const peers = vData.peerDependencies;
  if (!peers || typeof peers !== 'object') return undefined;
  const meta = vData.peerDependenciesMeta;
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(peers)) {
    if (typeof range !== 'string') continue;
    if (meta && meta[name] && meta[name].optional === true) continue;
    out[name] = range;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Convert a RegistryCacheEntry back to ResolvedPackage. */
function registryCacheToResolved(entry: RegistryCacheEntry): ResolvedPackage {
  // X.5-F R2: surface cached peerDependencies so a registry-cache hit
  // doesn't lose the peer-enqueue signal. Empty object → undefined so
  // callers (resolveTree) can use a single truthy check.
  const peers = safeJsonParse<Record<string, string>>(entry.peerDepsJson || '{}', {});
  return {
    name: entry.name,
    version: entry.version,
    tarballUrl: entry.tarballUrl,
    integrity: entry.integrity,
    dependencies: safeJsonParse(entry.depsJson, {}),
    peerDependencies: Object.keys(peers).length > 0 ? peers : undefined,
    exports: safeJsonParse(entry.exportsJson, null),
    main: entry.main,
    module: entry.moduleField,
    bin: safeJsonParse(entry.binJson, {}),
  };
}

// ── Full tree resolution (pipelined) ────────────────────────────────────

/**
 * Resolve the full dependency tree, breadth-first.
 * Calls onResolved() for each package as it's resolved (pipelined — caller
 * can start fetching tarballs immediately).
 *
 * W11: pass `opts.frameworkAware = true` when the project is detected as
 * one of {next, astro, nuxt, remix, sveltekit, vite, wrangler} so that
 * `vite` (and any future FRAMEWORK_REQUIRED_PACKAGES additions) actually
 * land in node_modules. See audit/sections/W11-plan.md §3.0.
 */
export async function resolveTree(
  specs: Record<string, string>,
  cache: NpmCache,
  onResolved?: (pkg: ResolvedPackage) => void,
  onProgress?: (msg: string) => void,
  fetchFn?: FetchFn,
  opts?: { frameworkAware?: boolean },
): Promise<Map<string, ResolvedPackage>> {
  const frameworkAware = !!(opts && opts.frameworkAware);
  const resolved = new Map<string, ResolvedPackage>();
  const seen = new Set<string>();
  // X.5-F R1: names the user typed at the top level (or that are
  // required peer-deps of an installed package — see R2 below) bypass
  // SKIP_PACKAGES. Transitive `dependencies` walks do NOT add to this
  // set, preserving silent-skip for build-tool noise. See audit/sections/
  // X5F-plan.md §6.1.
  const topLevelNames = new Set<string>(Object.keys(specs));
  // X.5-G G1: names that came from a parent's `optionalDependencies`.
  // These are best-effort per npm 4828 — fetch failures and platform-
  // native-binding detection silent-skip them rather than propagating
  // as install errors. See audit/sections/X5G-plan.md §2.
  const optionalNames = new Set<string>();
  // X.5-drizzle: names enqueued by the X.5-J top-level optional-peer
  // path (R2.5) and ALL their transitive descendants. The user did not
  // explicitly ask for them — npm CLI's --include=peer pulls them as a
  // best-effort convenience. When a `transitive: 'fail'` REJECT_INSTALL
  // fires for a name in this set, we silent-skip the offending name +
  // log a notice, instead of throwing and killing the parent install.
  // Mirrors src/npm-resolve-facet.ts. See audit/sections/X5-drizzle-plan.md.
  const bestEffortNames = new Set<string>();
  const queue: [string, string][] = Object.entries(specs);
  const limit = pLimit(RESOLVE_CONCURRENCY);

  while (queue.length > 0) {
    // Drain queue in bounded batches. Math.min ensures we process at most
    // RESOLVE_CONCURRENCY packages per iteration; transitive deps enqueued
    // by completed resolves are picked up in the next iteration. The
    // previous Math.max drained the ENTIRE queue in one go, creating 100+
    // Promises simultaneously — each with its own AbortController / setTimeout
    // / stream pipeline through the RPC proxy, overwhelming the workerd
    // loopback fabric with too many concurrent in-flight streams.
    const batch = queue.splice(0, Math.min(queue.length, RESOLVE_CONCURRENCY));
    const results = await Promise.all(
      batch.map(([name, range]) => limit(async () => {
        if (seen.has(name)) return null;
        seen.add(name);
        // X.5-F R1: top-level user requests + required peer-deps bypass
        // the SKIP_PACKAGES filter. Transitive deps do not.
        if (!topLevelNames.has(name) &&
            shouldSkipPackageWithFramework(name, frameworkAware)) {
          onProgress?.(`  skipping ${name} (build-only)`);
          return null;
        }
        // W6: transitive registry — swap rewrites name in flight; reject
        // with transitive='fail' throws (matches top-level fail policy);
        // reject with transitive='warn' logs [skip] and drops.
        // W6.5: each decision also emits a RegistryEvent for telemetry.
        let resolveName = name;
        const swap = lookupSwap(name);
        if (swap) {
          onProgress?.(formatSwapNotice(swap));
          emitRegistryEvent({ type: 'swap', from: swap.from, to: swap.to, ctx: 'transitive' });
          resolveName = swap.to;
        } else {
          const warnSkip = shouldWarnSkipTransitive(name);
          if (warnSkip) {
            onProgress?.(formatTransitiveSkip(warnSkip));
            emitRegistryEvent({ type: 'transitive-skip', from: warnSkip.from, reason: warnSkip.reason });
            return null;
          }
          const rejectFail = lookupReject(name);
          if (rejectFail && rejectFail.transitive === 'fail') {
            emitRegistryEvent({
              type: 'reject',
              from: rejectFail.from,
              reason: rejectFail.reason,
              suggest: rejectFail.suggest,
              ctx: 'transitive',
            });
            throw new RegistryRejectError([rejectFail]);
          }
        }
        onProgress?.(`  resolving ${resolveName}...`);
        const isOptional = optionalNames.has(name);
        try {
          const pkg = await resolvePackage(resolveName, range, cache, fetchFn, onProgress);
          // X.5-G G1: silent-skip platform-native bindings sourced from
          // optionalDependencies. Per npm 4828: best-effort installs MUST
          // NOT fail the parent. We go further than npm's host-mismatch
          // skip: even a host-matching .node binding is unloadable in
          // workerd, so all native bindings are skipped regardless of
          // host. The parent package's runtime fallback (e.g. rollup's
          // native.js → @rollup/wasm-node) handles absence.
          if (pkg && isOptional && isOptionalNativeBinding({
            name: pkg.name,
            os: pkg.os, cpu: pkg.cpu, libc: pkg.libc,
            main: pkg.main,
          })) {
            const reason = `optional native binding (os=${pkg.os ?? '*'}, cpu=${pkg.cpu ?? '*'}, libc=${pkg.libc ?? '*'}, main=${pkg.main || '?'})`;
            onProgress?.(`[npm] [skip] ${name} — ${reason}`);
            emitRegistryEvent({
              type: 'transitive-skip',
              from: name,
              reason,
            });
            return null;
          }
          return pkg;
        } catch (e: any) {
          // X.5-G G1: errors on optional-dep resolution silent-skip
          // rather than propagating. classifyInstallError preserves
          // RegistryRejectError propagation (registry-reject errors
          // ALWAYS bubble — a transitive=fail reject still throws).
          const cls = classifyInstallError(e, { isOptional });
          if (cls === 'optional-dep-skip') {
            onProgress?.(`[npm] [skip] ${name} (optional dep — ${e?.message ?? 'fetch failed'})`);
            emitRegistryEvent({
              type: 'transitive-skip',
              from: name,
              reason: `optional dep fetch failed: ${e?.message ?? 'unknown'}`,
            });
            return null;
          }
          if (cls === 'registry-reject') {
            // X.5-drizzle: registry-reject inside a best-effort
            // optional-peer subtree (X.5-J R2.5 enqueue) silent-skips
            // instead of bubbling up to kill the parent install. The
            // user did not explicitly ask for the optional-peer-rooted
            // subtree; mirror npm's --omit=optional behaviour for its
            // descendants. See VERIFY-9D4B61D §6 and the mirror in
            // src/npm-resolve-facet.ts. Canonical chain: drizzle-orm →
            // expo-sqlite (optpeer) → expo (peer) → @expo/metro-config
            // (dep) → lightningcss (dep, transitive='fail').
            if (bestEffortNames.has(name)) {
              onProgress?.(`[npm] [skip] ${name} — inside best-effort optional-peer subtree (X.5-drizzle): ${e?.message ?? 'reject'}`);
              emitRegistryEvent({
                type: 'transitive-skip',
                from: name,
                reason: `inside best-effort optional-peer subtree (X.5-drizzle): ${e?.message ?? 'reject'}`,
              });
              return null;
            }
            // Re-throw — registry rejects are loud at any depth.
            throw e;
          }
          onProgress?.(`  ${resolveName}: UNHANDLED ERROR: ${e?.message}`);
          return null;
        }
      })),
    );

    for (const pkg of results) {
      if (!pkg || resolved.has(pkg.name)) continue;
      resolved.set(pkg.name, pkg);
      onResolved?.(pkg);

      // X.5-drizzle: when this pkg was best-effort (a child of an
      // X.5-J optional-peer subtree), its newly-enqueued descendants
      // inherit the best-effort flag so a deep `transitive: 'fail'`
      // REJECT_INSTALL silent-skips instead of killing the parent.
      const inheritBestEffort = bestEffortNames.has(pkg.name);

      // Enqueue transitive deps
      for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
        if (!resolved.has(depName) && !seen.has(depName)) {
          if (inheritBestEffort) bestEffortNames.add(depName);
          queue.push([depName, depRange as string]);
        }
      }

      // X.5-G G1: enqueue transitive optionalDependencies, tagged so
      // resolveOne skips platform-native bindings silently and any
      // fetch failure becomes optional-dep-skip rather than fail. See
      // audit/sections/X5G-plan.md §2 for the npm 4828 rationale.
      if (pkg.optionalDependencies) {
        for (const [depName, depRange] of Object.entries(pkg.optionalDependencies)) {
          if (!resolved.has(depName) && !seen.has(depName)) {
            optionalNames.add(depName);
            if (inheritBestEffort) bestEffortNames.add(depName);
            queue.push([depName, depRange as string]);
          }
        }
      }

      // X.5-F R2: enqueue REQUIRED peer-deps (optionals already
      // filtered in versionToResolved). Mark them as topLevelNames so
      // they bypass SKIP_PACKAGES — ts-jest needs typescript even
      // though typescript is in SKIP_PACKAGES. See audit/sections/
      // X5F-plan.md §3 for the bug evidence and §6.2 for the fix.
      if (pkg.peerDependencies) {
        for (const [peerName, peerRange] of Object.entries(pkg.peerDependencies)) {
          if (resolved.has(peerName) || seen.has(peerName)) continue;
          topLevelNames.add(peerName);
          if (inheritBestEffort) bestEffortNames.add(peerName);
          queue.push([peerName, peerRange as string]);
        }
      }
      // X.5-F R2.5: when the user typed THIS package at top level,
      // also enqueue optional peer-deps. Mirrors npm CLI's
      // `--include=peer` default. Without this, framer-motion (whose
      // peers are ALL marked optional including react) installs but
      // its compiled CJS still imports react/jsx-runtime and fails.
      // For TRANSITIVE packages we keep optionals filtered out — only
      // top-level requests get this generous treatment.
      //
      // X.5-J: optional peers whose target is in REJECT_INSTALL get
      // SOFT-SKIPPED at enqueue time. Without this carve-out, R2.5's
      // generous include cascades into the W6 reject-throw and kills
      // the parent install. Two real regressions surfaced this:
      //   - drizzle-orm declares optional peer 'sql.js' (W6.5 loader gap)
      //   - ts-node     declares optional peer '@swc/core' (native Rust)
      // Both packages have non-rejected primary code paths (drizzle
      // works against d1/libsql/postgres/mysql; ts-node default mode
      // uses TypeScript transformer not swc), so a soft-skip recovers
      // the previously-working install. REQUIRED peers in REJECT_INSTALL
      // still hard-fail via the R2 path above (peerDependencies set
      // excludes optionals); transitive REQUIRED deps in REJECT_INSTALL
      // also still hard-fail via the dep walk's resolveOne reject path.
      // See audit/sections/X5J-plan.md §3 for the full rationale.
      if (topLevelNames.has(pkg.name)) {
        const allPeers = (pkg as any).__allPeerDependencies as Record<string, string> | undefined;
        if (allPeers) {
          for (const [peerName, peerRange] of Object.entries(allPeers)) {
            if (resolved.has(peerName) || seen.has(peerName)) continue;
            // X.5-J: filter optional peers through REJECT_INSTALL.
            const peerReject = lookupReject(peerName);
            if (peerReject) {
              const reason = `optional peer in REJECT_INSTALL: ${peerName} — ${peerReject.reason}`;
              onProgress?.(`[npm] [skip] ${peerName} (${reason})`);
              emitRegistryEvent({
                type: 'transitive-skip',
                from: peerName,
                reason,
              });
              continue;  // do NOT seen.add — let a later required-dep walk
                         // hit it via its own resolveOne path if needed.
            }
            topLevelNames.add(peerName);
            // X.5-drizzle: tag X.5-J optional-peer enqueues as
            // best-effort so a deep `transitive: 'fail'` REJECT
            // (e.g., expo-sqlite → expo → @expo/metro-config →
            // lightningcss) silent-skips the offending sub-tree
            // instead of killing the parent install.
            bestEffortNames.add(peerName);
            queue.push([peerName, peerRange as string]);
          }
        }
      }
    }
    // Brief idle window between waves — the diag layer surfaces this so
    // a probe scheduled here gets a clean readout rather than a snapshot
    // mid-parse.
    setResolverPhase('idle');
  }

  setResolverPhase('done');
  return resolved;
}

// ── Hoisting algorithm ──────────────────────────────────────────────────

/**
 * Compute npm-style hoisting: maximize packages at root node_modules/.
 *
 * Algorithm:
 *   1. Collect all unique name@version pairs from the resolved tree.
 *   2. For each package name, pick the most commonly depended-upon version
 *      for root hoisting.
 *   3. Any dep that requires a different version of an already-hoisted name
 *      goes into nested: node_modules/<parent>/node_modules/<child>
 *
 * In practice, for well-maintained projects (e.g., Radix UI ecosystem),
 * most packages agree on compatible versions and everything hoists to root.
 */
export function computeHoistPlan(
  resolved: Map<string, ResolvedPackage>,
): HoistPlan {
  const root = new Map<string, ResolvedPackage>();
  const nested = new Map<string, ResolvedPackage>();

  // Phase 1: Count how many packages depend on each name@version
  // (used to choose the "best" version for root hoisting)
  const versionCounts = new Map<string, Map<string, number>>();
  for (const [, pkg] of resolved) {
    for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
      const depPkg = resolved.get(depName);
      if (!depPkg) continue;
      if (!versionCounts.has(depName)) versionCounts.set(depName, new Map());
      const counts = versionCounts.get(depName)!;
      counts.set(depPkg.version, (counts.get(depPkg.version) || 0) + 1);
    }
  }

  // Phase 2: For each resolved package, determine if it can be hoisted to root.
  // Since we resolve a flat tree (one version per name), everything goes to root
  // unless there's a conflict. With our current flattenDeps (first-version-wins),
  // there are no conflicts — every name has exactly one version.
  for (const [name, pkg] of resolved) {
    root.set(name, pkg);
  }

  // Phase 3: Future — handle cases where multiple versions of the same name
  // are needed (peer dependency conflicts). For now, our resolver picks one
  // version per name (same as npm's flat tree), so nested is always empty.

  return { root, nested };
}

// ── Skip list ───────────────────────────────────────────────────────────

// W6: `esbuild` and `fsevents` were removed from SKIP_PACKAGES so the
// W6 swap/reject registry can own them. `esbuild` is in WASM_SWAPS
// (→ esbuild-wasm); `fsevents` is in REJECT_INSTALL (transitive='warn').
// node-gyp / node-pre-gyp remain here for transitive silence (they
// also appear in REJECT_INSTALL with transitive='warn' so a top-level
// `npm install node-gyp` reaches the registry first and emits a clear
// rejection — see plan §10 risk row).
//
// W11: `vite` was previously unconditionally skipped because the
// supervisor bundles real-vite. But Astro/Nuxt/Remix/SvelteKit `import`
// from the user's installed `vite` to call createServer() — so when a
// framework is detected, `vite` must actually land in node_modules.
// `shouldSkipPackageWithFramework({ frameworkAware: true })` exempts
// it. See audit/sections/W11-plan.md §3.0.
//
// X.5-G: `rollup` removed from SKIP_PACKAGES because it's now in
// WASM_SWAPS (rollup → @rollup/wasm-node). SKIP would mask the swap at
// transitive depth: vite → rollup transitive enqueue would silent-skip
// rollup before the swap fires. Removing the SKIP entry lets the
// transitive swap path (npm-resolver.ts:645) consult the registry.
const SKIP_PACKAGES = new Set([
  // Build tools (X.5-G: rollup migrated to WASM_SWAPS)
  'typescript', 'vite', 'webpack', 'parcel',
  'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',
  'prettier', 'eslint', 'stylelint',
  // Native modules / build-time (chokidar = real-vite intercepts;
  // node-gyp/pre-gyp = build-time only, never run in Workers)
  'chokidar', 'node-gyp', 'node-pre-gyp',
  // Cloudflare dev tools
  '@cloudflare/vite-plugin', '@cloudflare/workers-types', 'wrangler',
  // Other build-only
  'husky', 'lint-staged', 'commitlint',
]);

// W11: when a framework is detected at install time, packages in this
// set are removed from the skip list. Their dev binaries `import` from
// the project's node_modules and would crash with "Cannot find module"
// otherwise.
const FRAMEWORK_REQUIRED_PACKAGES = new Set([
  'vite',
]);

const SKIP_PREFIXES = [
  '@types/',
  '@eslint/',
  '@typescript-eslint/',
  'eslint-plugin-',
  'eslint-config-',
  // Note: '@vitejs/' used to be skipped because the Cirrus shim
  // ignored plugins anyway. With real-vite mode (Phase 1-4), those
  // plugins are required — keep them installable and let whichever
  // dev-server mode is active decide how to use them.
];

/** Check if a package should be skipped (build-only, native, types). */
export function shouldSkipPackage(name: string): boolean {
  if (SKIP_PACKAGES.has(name)) return true;
  return SKIP_PREFIXES.some(p => name.startsWith(p));
}

/**
 * W11: framework-aware skip variant. When `frameworkAware` is true, the
 * resolver lets through packages in FRAMEWORK_REQUIRED_PACKAGES (currently
 * just `vite`) so framework dev binaries can import them from node_modules.
 *
 * Callers detect framework presence via `framework-detect.ts` BEFORE
 * starting resolution and thread the flag through `resolveTree`.
 *
 * See audit/sections/W11-plan.md §3.0.
 */
export function shouldSkipPackageWithFramework(
  name: string,
  frameworkAware: boolean,
): boolean {
  if (frameworkAware && FRAMEWORK_REQUIRED_PACKAGES.has(name)) return false;
  return shouldSkipPackage(name);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function safeJsonParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json); } catch { return fallback; }
}
