/**
 * Shared npm resolution types, cache serialization, and hoisting.
 *
 * Registry resolution runs in fanout facets; this module contains only the
 * supervisor-side contracts and computations consumed after resolution.
 */
import type { RegistryCacheEntry } from './cache.js';
/**
 * Injectable fetch function used by the installer's facet-backed registry
 * transport.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface ResolvedPackage {
    name: string;
    version: string;
    tarballUrl: string;
    integrity: string;
    dependencies: Record<string, string>;
    /** Required peer dependencies surfaced for automatic installation. */
    peerDependencies?: Record<string, string>;
    /** Optional dependencies installed on a best-effort basis. */
    optionalDependencies?: Record<string, string>;
    /** Platform constraints declared by the registry package metadata. */
    os?: string[];
    cpu?: string[];
    libc?: string[];
    exports: any;
    main: string;
    module: string;
    bin: Record<string, string>;
}
export interface HoistPlan {
    /** Root-level hoisted packages: name → ResolvedPackage. */
    root: Map<string, ResolvedPackage>;
    /** Packages nested under a dependent root does not satisfy, by placement path (placement.ts). */
    nested: Map<string, ResolvedPackage>;
}
/** One package at one placement: the unit diff, fetch and lockfile work in. */
export interface PackagePlacement {
    /** Placement path relative to the project's `node_modules`. */
    placement: string;
    pkg: ResolvedPackage;
}
/**
 * Serialize a resolved package into the registry-cache row shape. Facet task
 * bodies keep inline literals of this shape because `fn.toString()` isolates
 * cannot import supervisor modules.
 */
export declare function registryEntryFromResolved(pkg: ResolvedPackage): RegistryCacheEntry;
/** The walk's placement decisions carried forward: first version per name at root, the rest nested. */
export declare function computeHoistPlan(resolved: Map<string, ResolvedPackage>, nested?: Map<string, ResolvedPackage>): HoistPlan;
/** Every placement in the plan, root first. */
export declare function hoistPlacements(plan: HoistPlan): PackagePlacement[];
//# sourceMappingURL=resolver.d.ts.map