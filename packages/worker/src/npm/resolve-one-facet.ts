/**
 * resolve-one-facet.ts — per-package resolution task body.
 *
 * Why this exists
 * ───────────────
 * The supervisor coordinates each dependency layer and submits packages as
 * independent fanout tasks. This file is the per-task body: one packument
 * fetch, one version pick, and edge extraction.
 *
 * Each task runs inside a Worker Loader isolate (Fanout routes a layer
 * in-DO when the session's Dynamic Worker headroom holds it, else across
 * sibling DOs). The isolate is short-lived; task body has its own ~128 MiB
 * envelope. Parallelism = layer width.
 *
 * Guest environment (the build compiles this task with its dependencies)
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
 *       EXACT_VERSION(spec) → string | null
 *       PARSE_REGISTRY_REQUEST(name, range) → the registry request a spec makes
 *
 * What the task does NOT do (supervisor responsibility)
 * ─────────────────────────────────────────────────────
 *   - Edge extraction: the supervisor pulls deps/peerDeps/optionalDeps
 *     out of the returned `pkg` and decides what goes in layer N+1.
 *   - Cycle detection: the supervisor maintains the `seen` set across
 *     layers. The task only sees one (name, range) per call.
 *
 * What the task DOES do
 * ─────────────────────
 *   1. Apply swap / reject-fail registry policy.
 *   2. An exact version's record, where the supervisor's NpmCache holds
 *      this registry's (cachedEntries).
 *   3. Ask env.SUPERVISOR.getPackument for the packument. Fetching the
 *      registry and filling the cross-tenant cache are supervisor-side;
 *      the facet only reads.
 *   4. Pick version via preamble's PICK_INSTALLED_VERSION.
 *   5. Materialise ResolvedPackage shape (versionToResolved-style).
 *   6. Stage the cache write for this version, returned in `cacheWrites`
 *      so the supervisor flushes every task's in one batched RPC.
 *   7. Return {pkg, cacheWrites, messages, events, packumentBytesDecoded,
 *      packumentSource, error?, nativeExecutable?}.
 */

import type { ResolvedPackage } from './resolver.js';
import type { CacheStatEvent } from '@nimbus-sh/core/_shared/cache-stats.js';
import type { FacetRegistryEvent } from './resolve-facet.js';
import type { PackumentReadOptions } from './r2-cache.js';
import type { NpmCacheMode } from '@nimbus-sh/core/_shared/npm-cache-mode.js';
import { isEngines, registryRecord, resolvedFromRecord, type RegistryCacheEntry } from './registry-record.js';
import type { PackageStagedArtifactEntry } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { compareSemver, exactVersion, isSemverRange, parseSemver, pickInstalledVersion, stagedBindingVersion as stagedBindingVersionOf } from '@nimbus-sh/core/_shared/npm-semver.js';
import type { parseRegistryRequest } from '@nimbus-sh/core/_shared/npm-spec.js';

declare const EXACT_VERSION: typeof exactVersion;
declare const PARSE_REGISTRY_REQUEST: typeof parseRegistryRequest;
declare const IS_SEMVER_RANGE: typeof isSemverRange;
declare const PICK_INSTALLED_VERSION: typeof pickInstalledVersion;
declare const STAGED_BINDING_VERSION: typeof stagedBindingVersionOf;
declare const PARSE_SEMVER: typeof parseSemver;
declare const COMPARE_SEMVER: typeof compareSemver;

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

declare function STAGED_ARTIFACT(name: string): PackageStagedArtifactEntry | undefined;

declare function STAGED_ARTIFACT_APPLY(
  pkg: { bin?: Record<string, string>; optionalDependencies?: Record<string, string>; os?: string[]; cpu?: string[]; libc?: string[] },
  entry: PackageStagedArtifactEntry,
): void;

/**
 * Argument shape: ONE package's resolution work.
 *
 * cachedHit (optional): a registry record the supervisor already has
 * for this name. The task uses it to short-circuit the fetch when
 * it satisfies the requested range. If null/missing, the task asks the
 * supervisor for the packument.
 */
export interface ResolveOneSpec {
  name: string;
  range: string;
  /**
   * The record of the exact version `range` names, where the session holds
   * this registry's (through this network): the task answers that version
   * from it without the packument. Empty for a range, which only the
   * registry's whole version list answers.
   */
  cachedEntries: RegistryCacheEntry[];
  /** Per-fetch timeout (ms). Default 15_000. */
  fetchTimeoutMs: number;
  /** Retries for transient failures. Default 3. */
  retries: number;
  /** Registry origin the packument is read from (the install's `NPM_REGISTRY`). */
  registry: string;
  /**
   * npm's cache mode for the packument (npm-cache-mode.ts); 'default' when
   * absent. Under 'no-cache' the packument is asked again, so a record does
   * not answer in its place; under 'force-cache' and 'only-if-cached' the
   * cached copy answers what it can, and is not asked again where it cannot.
   */
  cache?: NpmCacheMode;
}

export interface ResolveOneResult {
  /** Resolved package; with a `w6-reject` error, the package refused; null with an `unresolved` one. */
  pkg: ResolvedPackage | null;
  /**
   * Cache writes the task is asking the supervisor to flush. Includes
   * the resolved version + up to 5 recent versions seen in the
   * packument. Empty for cache-hit-only resolutions.
   */
  cacheWrites: RegistryCacheEntry[];
  /** [npm] log lines, forwarded by the supervisor. */
  messages: string[];
  /** Registry telemetry events to emitRegistryEvent. */
  events: FacetRegistryEvent[];
  /**
   * Diagnostic: how many bytes the task fetched/decoded. Folded into
   * the supervisor's facetCounters.
   */
  packumentBytesDecoded: number;
  packumentSource: 'cache-hit' | 'r2-cache' | 'network';
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
  cacheStatEvents?: Array<CacheStatEvent & { cacheKind: 'packument' }>;
  /**
   * The package has a native executable the policy names: it installs, with
   * an advisory, where the plan finds it required, and is left out where
   * the plan finds it optional (the installer decides, over the whole graph).
   */
  nativeExecutable?: { from: string; reason: string; suggest?: string };
  /**
   * Why this task produced no package.
   *
   * `w6-reject` is a registry-policy verdict: a refusal, which fails a
   * required placement and leaves an optional one out.
   *
   * `unresolved` is a resolution FAILURE — the registry said no, the
   * fetch never succeeded, or the packument carried no usable version.
   * It exists so the supervisor can tell a failure apart from a
   * deliberate policy skip: without it both arrive as `pkg: null` and a
   * required dependency (plus its whole subtree) disappears from the
   * install while the command still reports success.
   */
  error?:
    | { type: 'w6-reject'; from: string; reason: string; suggest?: string }
    | { type: 'unresolved'; reason: string };
}

/**
 * Per-package fanout task body. Compiled at build time and
 * dispatched by Fanout.submitMany — see installer.ts
 * resolveTreeViaFanout.
 *
 * Function signature MUST be `(spec, env)` so Fanout's
 * submitMany invocation `fn(item, env)` lines up.
 *
 * `env` is the loader-isolate env supplied by Fanout.
 * `env.SUPERVISOR` is the supervisor-rpc binding (getPackument).
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
        options: PackumentReadOptions,
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
  const cacheWrites: RegistryCacheEntry[] = [];
  const request = PARSE_REGISTRY_REQUEST(spec.name, spec.range);
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
    nativeExecutable?: ResolveOneResult['nativeExecutable'],
  ): ResolveOneResult => ({
    pkg,
    cacheWrites,
    messages,
    events,
    packumentBytesDecoded: bytes,
    packumentSource: source,
    packumentElapsedMs,
    cacheStatEvents,
    error,
    nativeExecutable,
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
  // Each staged build of a binding is of one upstream version; another
  // version's JavaScript would load a binding it was not written against,
  // and the runtime refuses it. Say so at install time, where it can be pinned.
  const adviseStagedBindingVersion = (pkg: ResolvedPackage) => {
    const staged = STAGED_ARTIFACT(pkg.name);
    if (staged?.kind !== 'binding' || staged.versions.includes(pkg.version)) return;
    const newest = staged.versions[staged.versions.length - 1];
    emitAdvisory({
      from: pkg.name,
      reason: `Nimbus runs ${staged.from}'s binding from staged builds of ${staged.versions.join(', ')}, and ${pkg.name}@${pkg.version} has none: it will refuse to load.`,
      suggest: `${staged.from}@${newest}`,
    });
  };
  // A native-executable bin is no failure (the package's JS tree installs);
  // only an os/cpu/libc allowlist refuses it (EBADPLATFORM parity).
  const outNativeExecutable = (
    pkg: ResolvedPackage,
    bytes: number,
    source: ResolveOneResult['packumentSource'],
  ): ResolveOneResult | null => {
    const reject = NATIVE_EXECUTABLE_REJECT(pkg);
    if (!reject) return null;
    // @ts-ignore — preamble.
    const platformReject = NATIVE_PLATFORM_REJECT(pkg);
    if (!platformReject) return out(pkg, bytes, source, undefined, { from: reject.from, reason: reject.reason, suggest: reject.suggest });
    events.push({
      type: 'reject',
      from: platformReject.from,
      reason: platformReject.reason,
      suggest: platformReject.suggest,
      ctx: 'transitive',
    });
    // The package, refused: its manifest still shapes the tree (npm places
    // it, and checks its platform when it reifies).
    return out(pkg, bytes, source, {
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
  //
  // A swap with `since` stands in only for the versions that have a native
  // build (rollup 4); earlier ones are plain JavaScript and install as
  // published. Its target publishes exactly those versions, so the swap
  // applies when the target has a version the range picks (decided below,
  // against the target's packument), and otherwise the package installs
  // unswapped rather than being moved to the target's latest.
  let effName = request.registryName;
  // @ts-ignore — preamble.
  const __swap = SHOULD_SWAP(request.registryName);
  const announceSwap = (swap: { from: string; to: string }) => {
    messages.push(`[npm] \x1b[33m[swap]\x1b[0m ${swap.from} → ${swap.to}`);
    events.push({ type: 'swap', from: swap.from, to: swap.to, ctx: 'transitive' });
  };
  if (__swap && !__swap.since) {
    announceSwap(__swap);
    effName = __swap.to;
  } else if (!__swap) {
    // @ts-ignore — preamble.
    const __fail = SHOULD_REJECT_FAIL(request.registryName);
    // A listed package resolves and installs — npm parity; the
    // advisory names the reason it cannot run here. An alias of a listed
    // package (`img@npm:sharp`) is that package.
    if (__fail) emitAdvisory(__fail);
  }

  // A package whose binding Nimbus stages runs only at a staged version, so
  // when the range admits one, the newest it admits is the one installed,
  // not the newest the registry has: vite 8.3.4's rolldown ~1.2.12 installs
  // the staged 1.2.13 after 1.2.14 is published, and ~1.2.9 a staged 1.2.11
  // when nothing newer is staged. A range that admits none keeps its own
  // pick, and the install says why it will not load (core npm-semver.ts
  // stagedBindingVersion; the release gate resolves with it too).
  const stagedVersions: readonly string[] = (() => {
    const staged = STAGED_ARTIFACT(request.registryName);
    return staged?.kind === 'binding' ? staged.versions : [];
  })();
  const stagedBindingVersion = (): string | null => STAGED_BINDING_VERSION(stagedVersions, request.range);

  // 2. cachedHit fast-path: the record of the exact version asked for, where
  //    the installer holds this registry's (installer.ts supplies no other).
  //    A range is never chosen from cached records: they are some versions
  //    of a package, never the registry's whole list, and npm's choice needs
  //    every one (a fresh `^2` beside a cached 2.0.0 and five 3.x is 2.1.0).
  //    Records are the registry package's (an alias's target's), by its name.
  //    Under --prefer-online the packument is asked again instead, as npm asks.
  const cached = (() => {
    const entries = spec.cachedEntries || [];
    if (entries.length === 0 || spec.cache === 'no-cache') return null;
    const candidates = entries.filter((e) => e.name === request.registryName);
    if (candidates.length === 0) return null;
    const picked = EXACT_VERSION(request.range);
    if (picked === null) return null;
    return candidates.find((e) => e.version === picked) || null;
  })();

  if (cached) {
    // Platform constraints + optionalDependencies round-trip so the ABI
    // policy makes the same decisions on warm-cache hits.
    const pkgFromCache = { ...resolvedFromRecord(cached), name: request.installName, registryName: request.registryName };
    adviseStagedBindingVersion(pkgFromCache);
    return outNativeExecutable(pkgFromCache, 0, 'cache-hit') ?? out(pkgFromCache, 0, 'cache-hit');
  }

  // 4 + 5. Packument, via the supervisor's npm-metadata seam.
  //
  // The facet does NOT fetch the registry and does NOT write the shared
  // packument cache. Both live in SupervisorRPC.getPackument, because a
  // packument dictates the tarball URL and integrity digest for every
  // tenant that reads it — a facet-supplied cache write would be a
  // cross-tenant code-execution primitive.
  type Packument = { versions: NonNullable<unknown>; 'dist-tags'?: unknown };
  const hasVersions = (value: unknown): value is Packument =>
    value !== null && typeof value === 'object' && 'versions' in value && !!value.versions;
  // `value[key]` as JavaScript reads it, a primitive's through its wrapper; undefined for null and undefined.
  const readProperty = (value: unknown, key: string): unknown =>
    value === null || value === undefined ? undefined : Reflect.get(Object(value), key);
  type Loaded = { data: Packument; bytes: number; source: ResolveOneResult['packumentSource'] } | { failed: ResolveOneResult };
  const loadPackument = async (name: string, revalidate = false): Promise<Loaded> => {
  let packumentText: string | null = null;
  let packumentSource: ResolveOneResult['packumentSource'] = 'network';
  if (!env?.SUPERVISOR || typeof env.SUPERVISOR.getPackument !== 'function') {
    messages.push(`[resolve-one] ${name}: env.SUPERVISOR.getPackument missing`);
    return { failed: out(null, 0, 'network', {
      type: 'unresolved',
      reason: 'env.SUPERVISOR.getPackument missing',
    }) };
  }
  {
    const packumentStart = Date.now();
    const result = await __nimbusUseRpcResult(
      env.SUPERVISOR.getPackument(name, {
        retries: Math.max(0, spec.retries ?? 3),
        timeoutMs: spec.fetchTimeoutMs ?? 15_000,
        registry: spec.registry,
        ...(spec.cache === undefined || spec.cache === 'default' ? {} : { cache: spec.cache }),
        ...(revalidate ? { revalidate: true } : {}),
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
        messages.push(`[resolve-one] ${name}: HTTP ${result.status}`);
        return { failed: out(null, 0, 'network', {
          type: 'unresolved',
          reason: `registry returned HTTP ${result.status} for ${name}`,
        }) };
      }
      messages.push(`[resolve-one] ${name}: fetch exhausted: ${result.failure}`);
      return { failed: out(null, 0, 'network', {
        type: 'unresolved',
        reason: `registry fetch failed for ${name}: ${result.failure}`,
      }) };
    }
    packumentText = result.json;
    packumentSource = result.source === 'r2-cache' ? 'r2-cache' : 'network';
  }

  const loadedBytes = packumentText.length;
  let loaded: unknown;
  try {
    loaded = JSON.parse(packumentText);
  } catch (e) {
    const detail = e instanceof Error ? e.message : e;
    messages.push(`[resolve-one] ${name}: malformed packument: ${detail}`);
    return { failed: out(null, loadedBytes, packumentSource, {
      type: 'unresolved',
      reason: `malformed packument for ${name}: ${detail}`,
    }) };
  }
  if (!loaded || !hasVersions(loaded)) {
    return { failed: out(null, loadedBytes, packumentSource, {
      type: 'unresolved',
      reason: `packument for ${name} carries no versions`,
    }) };
  }
  return { data: loaded, bytes: loadedBytes, source: packumentSource };
  };

  // 3. Pick version: an exact version, the highest the range admits, else
  //    the range as a dist-tag, else `latest` — but never `latest` for a
  //    semver range nothing satisfies. That is npm's ETARGET, and falling
  //    back installed a version outside the range asked for (a swap target
  //    that lacks the range's versions handed back its own latest).

  // A `since` swap is decided on the package itself: resolve its own
  // packument and version first, and consult the target only when that
  // version is one the swap covers. A registry that serves rollup but not
  // @rollup/wasm-node (a private mirror) still installs rollup 3. The target
  // is published in lockstep, so it stands in with exactly that version; a
  // target that lacks it installs the package unswapped, with the note that
  // its native build cannot run here, never a target version out of range.
  // A cached packument that cannot answer what is asked is asked of the
  // registry once more, past the cache: cached absence is no proof that
  // nothing is published (a version published since it was cached). Once,
  // and where that fails, the cached answer stands.
  // Its answer, or null where that read fails in any way (a rejected
  // call included): the cached answer then stands, as it was.
  const askAgain = async (name: string): Promise<Extract<Loaded, { data: Packument }> | null> => {
    try {
      const again = await loadPackument(name, true);
      return 'failed' in again ? null : again;
    } catch {
      return null;
    }
  };
  const stagedVersion = stagedBindingVersion();
  // The version the request installs, by the rule every npm here picks with
  // (core _shared/npm-semver.ts pickInstalledVersion, from the preamble).
  const choose = (data: Packument) => PICK_INSTALLED_VERSION(data.versions, data['dist-tags'], request.range, stagedVersions);
  let packument: Loaded = await loadPackument(effName);
  if ('failed' in packument) return packument.failed;
  // One pick; a cached packument asked again only where it answered nothing
  // (or not the staged version), and never where npm's mode keeps to the
  // cache (--prefer-offline, --offline).
  let version = choose(packument.data);
  const keepsToCache = spec.cache === 'force-cache' || spec.cache === 'only-if-cached';
  if (!keepsToCache && packument.source === 'r2-cache' && (stagedVersion !== null ? version !== stagedVersion : version === null)) {
    const again = await askAgain(effName);
    if (again) {
      packument = again;
      version = choose(again.data);
    }
  }
  if (__swap && __swap.since) {
    const own = version;
    let covered = false;
    if (own !== null && readProperty(packument.data.versions, String(own)) !== undefined) {
      const ownSemver = PARSE_SEMVER(String(own));
      const since = PARSE_SEMVER(__swap.since);
      // A version that does not parse cannot be ordered: the resolve fails, as it always has.
      if (ownSemver === null || since === null) throw new TypeError(`${ownSemver === null ? own : __swap.since} is not a semver version`);
      covered = COMPARE_SEMVER(ownSemver, since) >= 0;
    }
    if (covered) {
      let target: Loaded = await loadPackument(__swap.to);
      if (!keepsToCache && !('failed' in target) && target.source === 'r2-cache' && readProperty(target.data.versions, String(own)) === undefined) {
        target = await askAgain(__swap.to) ?? target;
      }
      if ('failed' in target) return target.failed;
      if (readProperty(target.data.versions, String(own)) !== undefined) {
        announceSwap(__swap);
        effName = __swap.to;
        packument = target;
      } else {
        emitAdvisory({
          from: request.registryName,
          reason: `${__swap.to} publishes no ${own}, so ${request.registryName}@${own} installs with its native build, which cannot run in a Worker.`,
          suggest: `${request.registryName}@<a version ${__swap.to} publishes>`,
        });
      }
    }
  }
  const data = packument.data;
  const bytes = packument.bytes;
  const packumentSource = packument.source;

  if (!version || !readProperty(data.versions, String(version))) {
    messages.push(`[resolve-one] ${effName}: no version satisfies ${request.range}`);
    return out(null, bytes, packumentSource, {
      type: 'unresolved',
      reason: `no published version of ${effName} satisfies ${request.range}`,
    });
  }

  // 4. Materialise ResolvedPackage.
  const vData = readProperty(data.versions, String(version));
  const versionToResolved = (v: any): ResolvedPackage => {
    const packageName = request.installName || v.name;
    const binField = v.bin || {};
    // A string bin is named for the package the manifest is (npm-normalize-package-bin), an alias's target.
    const bin: Record<string, string> = typeof binField === 'string'
      ? { [String(v.name || request.registryName).split('/').pop()!]: binField }
      : binField;
    // Every peer, and which are optional (peerDependenciesMeta): an
    // optional one is never installed for the package, and constrains the
    // copy the tree has.
    let peerDependencies: Record<string, string> | undefined;
    let peerDependenciesMeta: Record<string, { optional: true }> | undefined;
    const peers = v.peerDependencies;
    if (peers && typeof peers === 'object') {
      const meta = v.peerDependenciesMeta;
      const all: Record<string, string> = {};
      const optional: Record<string, { optional: true }> = {};
      for (const [n, r] of Object.entries(peers)) {
        if (typeof r !== 'string') continue;
        all[n] = r;
        if (meta && meta[n] && meta[n].optional === true) optional[n] = { optional: true };
      }
      if (Object.keys(all).length > 0) peerDependencies = all;
      if (Object.keys(optional).length > 0) peerDependenciesMeta = optional;
    }
    const optionalDependencies =
      v.optionalDependencies && typeof v.optionalDependencies === 'object'
        ? Object.fromEntries(Object.entries(v.optionalDependencies).filter(([, r]) => typeof r === 'string')) as Record<string, string>
        : undefined;
    const resolvedOut: any = {
      name: packageName,
      version: v.version,
      registryName: request.registryName,
      tarballUrl: v.dist?.tarball || '',
      integrity: v.dist?.integrity || v.dist?.shasum || '',
      dependencies: v.dependencies || {},
      peerDependencies,
      ...(peerDependenciesMeta ? { peerDependenciesMeta } : {}),
      ...((v.bundleDependencies ?? v.bundledDependencies) === undefined ? {} : { bundleDependencies: v.bundleDependencies ?? v.bundledDependencies }),
      optionalDependencies,
      os: Array.isArray(v.os) ? v.os : undefined,
      cpu: Array.isArray(v.cpu) ? v.cpu : undefined,
      libc: Array.isArray(v.libc) ? v.libc : undefined,
      ...(isEngines(v.engines) ? { engines: v.engines } : {}),
      exports: v.exports ?? null,
      main: v.main || '',
      module: v.module || '',
      bin,
    };
    // Staged-artifact rewrite: native-launcher packages install as their
    // prebuilt Nimbus JS bundle. STAGED_ARTIFACT_APPLY is the preamble copy
    // of the supervisor's policyApplyStagedArtifact (package-abi-policy.mjs
    // enforces parity), so the facet performs the identical rewrite.
    const staged = STAGED_ARTIFACT(packageName);
    if (staged) STAGED_ARTIFACT_APPLY(resolvedOut, staged);
    return resolvedOut as ResolvedPackage;
  };
  const pkg = versionToResolved(vData);
  adviseStagedBindingVersion(pkg);
  const native = outNativeExecutable(pkg, bytes, packumentSource);
  if (native?.error) return native;

  // 5. Stage the cache write: the registry package's, under its name, the
  //    one key a record has (an alias's lockfile entry names it too).
  cacheWrites.push(registryRecord({ ...pkg, name: request.registryName }, Date.now()));

  return native ?? out(pkg, bytes, packumentSource);
};
