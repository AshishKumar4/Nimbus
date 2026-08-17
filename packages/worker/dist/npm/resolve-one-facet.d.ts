/**
 * resolve-one-facet.ts — per-package resolution task body.
 *
 * Why this exists
 * ───────────────
 * The supervisor coordinates each dependency layer and submits packages as
 * independent fanout tasks. This file is the per-task body: one packument
 * fetch, one version pick, and edge extraction.
 *
 * Each task runs inside a Worker Loader isolate (FanoutPool routes
 * automatically: <5 = in-DO, ≥5 = peer-DO). The isolate is short-lived;
 * task body has its own ~128 MiB envelope. Parallelism = layer width
 * (capped at 32 by FanoutPool's MAX_PEER_FANOUT).
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
 *   - Top-level handling: the supervisor maintains topLevelNames.
 *     `topLevel` is passed in per task so SKIP_PACKAGES bypass works.
 *
 * What the task DOES do
 * ─────────────────────
 *   1. Apply SKIP_PACKAGES filter (unless `topLevel`).
 *   2. Apply swap / warn-skip / reject-fail registry policy.
 *   3. Try in-task cache from `cachedHit` (one entry shipped from
 *      supervisor's NpmCache).
 *   4. Ask env.SUPERVISOR.getPackument for the packument. Fetching the
 *      registry and filling the cross-tenant cache are supervisor-side;
 *      the facet only reads.
 *   5. Pick version via preamble's RESOLVE_VERSION.
 *   6. Materialise ResolvedPackage shape (versionToResolved-style).
 *   7. Stage cache writes for this version + top-5 recent versions.
 *      Returns them in `cacheWrites` so the supervisor can flush in one
 *      batched RPC.
 *   8. Return {pkg, deps, peerDeps, optionalDeps, allPeerDependencies,
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
    /**
     * X.5-F R1: when true, this package was either user-typed OR a
     * required peer-dep enqueued by the supervisor. Bypasses
     * SKIP_PACKAGES. The supervisor decides the flag at enqueue time.
     */
    topLevel: boolean;
    /** X.5-G G1: this spec came from an optionalDependencies edge, so
     *  platform-native bindings silent-skip rather than failing the parent. */
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
    cacheStatEvents?: Array<{
        kind: 'hit';
        tier: 'L2' | 'L3' | 'L4';
        cacheKind: 'packument';
        bytes: number;
    } | {
        kind: 'miss';
        tier: 'L2' | 'L3' | 'L4';
        cacheKind: 'packument';
    }>;
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
    error?: {
        type: 'w6-reject';
        from: string;
        reason: string;
        suggest?: string;
    } | {
        type: 'unresolved';
        reason: string;
    };
}
/**
 * Per-package fanout task body. Serialised via fn.toString() and
 * dispatched by FanoutPool.submitMany — see installer.ts
 * resolveTreeViaFanout.
 *
 * Function signature MUST be `(spec, env)` so FanoutPool's
 * submitMany invocation `fn(item, env)` lines up.
 *
 * `env` is the loader-isolate env supplied by FanoutPool.
 * `env.SUPERVISOR` is the supervisor-rpc binding (putRegistryEntries,
 * getPackument).
 */
export declare const resolveOnePackumentInFacet: (spec: ResolveOneSpec, env: {
    SUPERVISOR: {
        /**
         * The npm-metadata seam: cross-tenant cache read, registry fetch on
         * a miss, and the cache fill — all supervisor-side. The facet reads
         * packuments and never writes them.
         */
        getPackument: (name: string, options: {
            retries: number;
            timeoutMs: number;
        }) => Promise<{
            json: string | null;
            source: "r2-cache" | "network";
            events: Array<{
                kind: "hit";
                tier: string;
                cacheKind: string;
                bytes: number;
            } | {
                kind: "miss";
                tier: string;
                cacheKind: string;
            }>;
            status?: number;
            failure?: string;
        }>;
    };
}) => Promise<ResolveOneResult>;
//# sourceMappingURL=resolve-one-facet.d.ts.map