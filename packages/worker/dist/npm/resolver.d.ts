/**
 * npm-resolver.ts — Semver resolution, exports field, and hoisting for Nimbus npm v2.
 *
 * Provides:
 *   1. Proper semver parsing + range matching (^, ~, >=, ||, *, x ranges)
 *   2. Node.js-spec exports field resolution with conditions
 *   3. Aggressive hoisting algorithm (one copy of each version at the highest level)
 *
 * Build-only skip lists and all swap/reject/native policy live in
 * `facets/wasm-swap-registry.ts: PACKAGE_ABI_POLICY`.
 */
import type { NpmCache, RegistryCacheEntry } from './cache.js';
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
export declare function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T>;
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
    exports: any;
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
/**
 * Check if a version satisfies a full range expression.
 * Supports || (OR), space (AND within a range set), hyphen ranges.
 */
export declare function satisfiesRange(version: string, range: string): boolean;
/** Find the highest version matching a range from a list of versions. */
export declare function resolveVersion(versions: string[], range: string): string | null;
/**
 * Resolve a single package from the registry.
 * Checks cache first, then fetches from npm.
 */
export declare function resolvePackage(name: string, versionRange: string, cache: NpmCache, fetchFn?: FetchFn, log?: (msg: string) => void): Promise<ResolvedPackage | null>;
/**
 * Serialize a ResolvedPackage into the registry-cache row shape. The
 * one supervisor-side definition of how a resolved package round-trips
 * through the cache; `cacheEntryToResolved` is the inverse. The facet
 * task bodies keep inline literals of the same shape because they are
 * serialized via fn.toString() and cannot import.
 */
export declare function registryEntryFromResolved(pkg: ResolvedPackage): RegistryCacheEntry;
/**
 * Resolve the full dependency tree, breadth-first.
 * Calls onResolved() for each package as it's resolved (pipelined — caller
 * can start fetching tarballs immediately).
 *
 * W11: pass `opts.frameworkAware = true` when the project is detected as
 * one of {next, astro, nuxt, remix, sveltekit, vite, wrangler} so that
 * `vite` (and any future FRAMEWORK_REQUIRED_PACKAGES additions) actually
 */
export declare function resolveTree(specs: Record<string, string>, cache: NpmCache, onResolved?: (pkg: ResolvedPackage) => void, onProgress?: (msg: string) => void, fetchFn?: FetchFn, opts?: {
    frameworkAware?: boolean;
}): Promise<Map<string, ResolvedPackage>>;
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
export declare function computeHoistPlan(resolved: Map<string, ResolvedPackage>): HoistPlan;
//# sourceMappingURL=resolver.d.ts.map