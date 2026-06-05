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
 *   Cache writes flow back via env.SUPERVISOR.putRegistryEntries in batches
 *   of 50 resolved packages or at end-of-phase. They do not block forward
 *   progress.
 */
import type { ResolvedPackage } from './resolver.js';
export interface FacetCachedEntry {
    /** Same shape as RegistryCacheEntry from src/npm-cache.ts. JSON-only
     *  fields so the structured-clone over RPC doesn't choke. */
    name: string;
    version: string;
    tarballUrl: string;
    integrity: string;
    depsJson: string;
    /** Required peerDependencies with optionals filtered. */
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
    /** When true, framework-required packages such as vite bypass the skip list. */
    frameworkAware?: boolean;
}
/**
 * Telemetry-event mirror of `RegistryEvent`. The facet cannot import the
 * registry directly because the preamble has no import surface, so the type
 * is duplicated here.
 */
export type FacetRegistryEvent = {
    type: 'swap';
    from: string;
    to: string;
    ctx: 'transitive';
} | {
    type: 'reject';
    from: string;
    reason: string;
    suggest?: string;
    ctx: 'transitive';
} | {
    type: 'transitive-skip';
    from: string;
    reason: string;
};
export interface ResolveFacetResult {
    /** Resolved packages, lean (no packument retained). */
    resolved: ResolvedPackage[];
    /** Per-spec status messages — surfaced into the install log as
     *  `[resolve-facet] <line>`. Bounded to ~one line per resolved spec. */
    messages: string[];
    /**
     * Registry decisions taken inside the facet. Successful returns are drained
     * by the supervisor and forwarded to the registry sink. Throw-path rejects
     * do not reach this field because the facet returns through the error path.
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
    /**
     * cache-obs-2: per-tier cache events for the packument tier
     * (L2/L3 spliced from supervisor RPC return; L4 from registry
     * fetches). Folded supervisor-side in installer.ts via
     * recordCacheStatEvents.
     */
    cacheStatEvents: Array<{
        kind: 'hit';
        tier: 'L2' | 'L3' | 'L4';
        cacheKind: 'packument';
        bytes: number;
    } | {
        kind: 'miss';
        tier: 'L2' | 'L3' | 'L4';
        cacheKind: 'packument';
    }>;
    /** Wall-clock elapsed inside the facet. */
    elapsed: number;
    /** Cache writes the facet flushed back via env.SUPERVISOR.putRegistryEntries. */
    cacheWriteCount: number;
}
export declare const resolveTreeInFacet: (spec: ResolveFacetSpec, env: {
    SUPERVISOR: {
        putRegistryEntries(entries: any[]): Promise<{
            written: number;
            failed: number;
        }>;
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
}) => Promise<ResolveFacetResult>;
//# sourceMappingURL=resolve-facet.d.ts.map