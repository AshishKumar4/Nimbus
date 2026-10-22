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
import type { RegistryEvent } from '../facets/wasm-swap-registry.js';
import type { PackumentReadOptions } from './r2-cache.js';
import type { NpmCacheMode } from '@nimbus-sh/core/_shared/npm-cache-mode.js';
import { type RegistryCacheEntry } from './registry-record.js';
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
/** A registry event as a resolver facet reports it: a top-level request is the supervisor's, never a facet's. */
type TransitiveRegistryEvent = RegistryEvent extends infer Event ? Event extends {
    ctx: 'top' | 'transitive';
} ? Omit<Event, 'ctx'> & {
    ctx: 'transitive';
} : Event : never;
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
    /** Registry telemetry events to emitRegistryEvent: every one a facet says is of a transitive dependency. */
    events: TransitiveRegistryEvent[];
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
    cacheStatEvents?: Array<CacheStatEvent & {
        cacheKind: 'packument';
    }>;
    /**
     * The package has a native executable the policy names: it installs, with
     * an advisory, where the plan finds it required, and is left out where
     * the plan finds it optional (the installer decides, over the whole graph).
     */
    nativeExecutable?: {
        from: string;
        reason: string;
        suggest?: string;
    };
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
export declare const resolveOnePackumentInFacet: (spec: ResolveOneSpec, env: {
    SUPERVISOR: {
        /**
         * The npm-metadata seam: cross-tenant cache read, registry fetch on
         * a miss, and the cache fill — all supervisor-side. The facet reads
         * packuments and never writes them.
         */
        getPackument: (name: string, options: PackumentReadOptions) => Promise<{
            json: string | null;
            source: 'r2-cache' | 'network';
            events: Array<{
                kind: 'hit';
                tier: string;
                cacheKind: string;
                bytes: number;
            } | {
                kind: 'miss';
                tier: string;
                cacheKind: string;
            }>;
            status?: number;
            failure?: string;
        }>;
    };
}) => Promise<ResolveOneResult>;
export {};
//# sourceMappingURL=resolve-one-facet.d.ts.map