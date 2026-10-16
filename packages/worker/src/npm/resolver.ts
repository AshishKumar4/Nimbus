/**
 * Shared npm resolution types, cache serialization, and hoisting.
 *
 * Registry resolution runs in fanout facets; this module contains only the
 * supervisor-side contracts and computations consumed after resolution.
 */


/**
 * Injectable fetch function used by the installer's facet-backed registry
 * transport.
 */

export interface ResolvedPackage {
  /** The name it installs under (an alias's). */
  name: string;
  version: string;
  /** The registry package it is (an alias's target); unknown for records written before it was kept. */
  registryName?: string;
  tarballUrl: string;
  integrity: string;
  dependencies: Record<string, string>;
  /** Peer dependencies: installed with the package, but an optional one (peerDependenciesMeta), which only constrains. */
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  /** `bundleDependencies` as published (TreeManifest's): carried in its own archive. */
  bundleDependencies?: unknown;
  /** Optional dependencies installed on a best-effort basis. */
  optionalDependencies?: Record<string, string>;
  /** Platform constraints declared by the registry package metadata. */
  os?: string[];
  cpu?: string[];
  libc?: string[];
  /** `engines` as published: what it asks of node and npm (npm's engine check, core npm-arborist/engines.ts). */
  engines?: Readonly<Record<string, unknown>>;
  main: string;
  bin: Record<string, string>;
}

/** One package at one placement: the unit diff, fetch and lockfile work in. */
export interface PackagePlacement {
  /** Placement path relative to the project's `node_modules`. */
  placement: string;
  pkg: ResolvedPackage;
}
