/**
 * resolve-one-facet.ts — per-package resolution task body.
 *
 * Why this exists
 * ───────────────
 * The supervisor coordinates each dependency layer and submits packages as
 * independent fanout tasks. This file is the per-task body: one packument
 * fetch, one version pick, and edge extraction.
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
    /** Registry telemetry events to emitRegistryEvent. */
    events: FacetRegistryEvent[];
    /**
     * Diagnostic: how many bytes the task fetched/decoded. Folded into
     * supervisor's facetCounters for parity with resolve-facet.ts.
     */
    packumentBytesDecoded: number;
    packumentSource: 'cache-hit' | 'r2-cache' | 'network' | 'skipped';
    /**
     * cache-obs-2: per-tier cache events captured during this resolve.
     *
     * Each entry records a single L2/L3/L4 hit-or-miss observed when
     * fetching the packument. L2/L3 events flow from the supervisor RPC
     * return (getCachedPackument.events). L4 events are pushed when the
     * resolver itself fetches from registry.npmjs.org.
     *
     * Folded into the DO-side cache-stats singleton by installer.ts via
     * recordCacheStatEvents on the resolveTree-via-facet return path
     * (same pattern as recordR2RaceCounters).
     *
     * Optional in the type to keep the wire compatible with older
     * resolver-facet bundles; default to [] when consumed supervisor-side.
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
     * Registry reject. The supervisor inspects this and either propagates it
     * or silent-skips best-effort optional-peer paths.
     */
    error?: {
        type: 'w6-reject';
        from: string;
        reason: string;
        suggest?: string;
    } | {
        type: 'fetch-exhausted';
        message: string;
    };
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
export declare const resolveOnePackumentInFacet: (spec: ResolveOneSpec, env: {
    SUPERVISOR: {
        getCachedPackument?: (name: string) => Promise<{
            json: string;
            ageMs: number;
            expired: boolean;
        } | null | {
            cached: {
                json: string;
                ageMs: number;
                expired: boolean;
            } | null;
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
        }>;
        putCachedPackument?: (name: string, json: string) => Promise<boolean>;
    };
}) => Promise<ResolveOneResult>;
//# sourceMappingURL=resolve-one-facet.d.ts.map