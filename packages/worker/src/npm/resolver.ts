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
  /**
   * Packages that could not be hoisted due to version conflicts.
   * Key: "parentName/childName", value: ResolvedPackage.
   */
  nested: Map<string, ResolvedPackage>;
}

/**
 * Serialize a resolved package into the registry-cache row shape. Facet task
 * bodies keep inline literals of this shape because `fn.toString()` isolates
 * cannot import supervisor modules.
 */
export function registryEntryFromResolved(pkg: ResolvedPackage): RegistryCacheEntry {
  return {
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
  };
}

/** Compute the flat hoist plan used by the current one-version-per-name resolver. */
export function computeHoistPlan(
  resolved: Map<string, ResolvedPackage>,
): HoistPlan {
  return {
    root: new Map(resolved),
    nested: new Map(),
  };
}
