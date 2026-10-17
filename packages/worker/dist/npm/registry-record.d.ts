/**
 * npm/registry-record.ts — one package version's registry metadata as the
 * registry cache keeps it (pkg_registry_cache, npm/cache.ts), and the one
 * codec between it and ResolvedPackage. The resolver facet's task bundles it:
 * a warm hit answers with what a cold resolve of the same version answers,
 * and the writes it stages are the records. The installer checks and
 * reconstructs a lockfile's packages with the same decoder.
 */
import type { ResolvedPackage } from './resolver.js';
export interface RegistryCacheEntry {
    name: string;
    version: string;
    /** The registry package (an alias's target); '' for rows written before it was kept. */
    registryName?: string;
    tarballUrl: string;
    integrity: string;
    depsJson: string;
    /**
     * JSON-encoded peerDependencies: every peer, the optional ones named by
     * peerMetaJson. Rows written before peerMetaJson was kept hold only the
     * required peers, which read as required. '{}' for rows written before
     * the column existed (added via ALTER TABLE, see ensureSchema).
     */
    peerDepsJson?: string;
    main: string;
    binJson: string;
    /**
     * JSON-encoded npm platform constraints — `{ os?, cpu?, libc? }`.
     *
     * Persisted so warm-cache resolution keeps the same ABI/platform
     * decisions as a cold packument fetch (native-shard silent-skip and
     * platform-native rejects are metadata-driven). '{}' means no
     * constraints; rows written before the column existed read as '{}'
     * (a metadata miss, matching pre-migration behavior).
     */
    platformJson?: string;
    /**
     * JSON-encoded `optionalDependencies`. Persisted so cached parents
     * still enqueue their best-effort optional deps exactly like a cold
     * resolve. Defaults to '{}' for pre-migration rows.
     */
    optionalDepsJson?: string;
    /** JSON-encoded `peerDependenciesMeta` (which peers are optional); '{}' for rows written before it was kept, whose peers are the required ones. */
    peerMetaJson?: string;
    /** JSON-encoded `bundleDependencies` as published; '' for none (and rows written before it was kept). */
    bundleJson?: string;
    /** JSON-encoded `engines` as published; '' for none. */
    enginesJson?: string;
}
/** `engines` as a manifest states it (a registry's, a lock's): what it asks of each engine. */
export declare const isEngines: (value: unknown) => value is Readonly<Record<string, unknown>>;
/** The record of `pkg`, as the cache keeps it. */
export declare function registryRecord(pkg: ResolvedPackage): RegistryCacheEntry;
/** The package a record describes, as a cold resolve of its version answers it. */
export declare function resolvedFromRecord(record: RegistryCacheEntry): ResolvedPackage;
//# sourceMappingURL=registry-record.d.ts.map