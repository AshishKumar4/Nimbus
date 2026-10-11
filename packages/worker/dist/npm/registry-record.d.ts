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
    tarballUrl: string;
    integrity: string;
    depsJson: string;
    /**
     * JSON-encoded REQUIRED peerDependencies (X.5-F R2).
     *
     * Optional peers — those marked `peerDependenciesMeta.<name>.optional
     * === true` in the source packument — are filtered out before this
     * field is written. Storing only the required subset means downstream
     * lockfile-validity checks can ask "is this peer in the tree?"
     * without having to consult the meta field again.
     *
     * Defaults to '{}' for entries written by pre-X.5-F builds (the
     * column was added via ALTER TABLE, see ensureSchema).
     */
    peerDepsJson?: string;
    exportsJson: string;
    main: string;
    moduleField: string;
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
    fetchedAt: number;
}
/** The record of `pkg`, fetched at `fetchedAt`, as the cache keeps it. */
export declare function registryRecord(pkg: ResolvedPackage, fetchedAt: number): RegistryCacheEntry;
/** A record's edges, as resolvedFromRecord decodes them: its dependencies, required peers and optional dependencies. */
export declare function recordEdges(record: RegistryCacheEntry): Pick<ResolvedPackage, 'dependencies' | 'peerDependencies' | 'optionalDependencies'>;
/** The package a record describes, as a cold resolve of its version answers it. */
export declare function resolvedFromRecord(record: RegistryCacheEntry): ResolvedPackage;
//# sourceMappingURL=registry-record.d.ts.map