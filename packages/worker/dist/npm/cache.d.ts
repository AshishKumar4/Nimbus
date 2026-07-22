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
export interface LockfileEntry {
    name: string;
    resolvedVer: string;
    integrity: string;
    depsJson: string;
    hoistedPath: string;
}
export interface EsmBundleEntry {
    specifier: string;
    bundleHash: string;
    esmCode: string;
    builtAt: number;
    inputHash: string;
}
export interface UserModuleTransformEntry {
    /** VFS path of the source module (e.g. "home/user/projects/src/App.tsx"). */
    vfsPath: string;
    /** SHA-256 (base64url) of the source bytes the transform was built from. */
    contentHash: string;
    /** BUNDLER_VERSION the transform output was produced with. */
    bundlerVersion: string;
    /** Final served JS (esbuild transform + import rewrites). */
    code: string;
    builtAt: number;
}
export declare class NpmCache {
    private sql;
    private initialized;
    constructor(sql: SqlStorage);
    ensureSchema(): void;
    private static readonly REGISTRY_COLUMNS;
    private rowToRegistryEntry;
    /** Get cached registry metadata for a specific name@version.
     *
     *  L1 observability: bumps cache-stats L1.packument hit/miss. Bytes
     *  on hit = approximate size of the deserialized RegistryCacheEntry,
     *  computed as sum of major-string lengths (depsJson + peerDepsJson +
     *  exportsJson + binJson + a few tens of bytes overhead). This is a
     *  good proxy for "how much L1 data did we save fetching" — not the
     *  exact SQLite blob byte count (which would require a separate
     *  SELECT). */
    getRegistryEntry(name: string, version: string): RegistryCacheEntry | null;
    /**
     * Bulk read of cached registry entries — used by the resolver-facet
     * dispatcher to pre-load cached metadata it can ship across to the
     * facet at phase start. Caller passes a hard cap; we LIMIT in SQL so
     * a pathologically warm cache doesn't OOM the supervisor reading its
     * own cache.
     *
     * Order: most-recently-fetched first, so when the cap truncates we
     * keep the freshest entries (most likely to satisfy current ranges).
     */
    dumpRegistryEntries(maxRows: number): RegistryCacheEntry[];
    /** Get all cached versions for a package name. */
    getRegistryVersions(name: string): RegistryCacheEntry[];
    /** Store registry metadata for a resolved package version. */
    putRegistryEntry(entry: RegistryCacheEntry): void;
    /**
     * Bulk-write registry entries in ONE call. Used by the resolver-facet
     * to flush a wave of resolved packages back to the supervisor in a
     * single RPC round-trip; one-RPC-per-entry across ~456 transitive
     * deps would multiply RPC overhead by 100×.
     *
     * Each row is one prepared statement; we loop rather than building a
     * giant multi-row INSERT because workerd's SqlStorage `.exec()` is
     * already transaction-batched at the storage layer when called within
     * the same DO event loop turn (no explicit BEGIN/COMMIT needed for
     * atomicity of the batch — see Cloudflare DO SQLite docs). If a
     * single row fails (malformed data), it's logged and the rest still
     * commit; resolver correctness depends on cache being best-effort.
     */
    putRegistryEntries(entries: RegistryCacheEntry[]): {
        written: number;
        failed: number;
    };
    /** Read the lockfile for a project. Returns null if not found. */
    readLockfile(projectPath: string): Map<string, LockfileEntry> | null;
    /** Write/overwrite the lockfile for a project. Atomic via transaction. */
    writeLockfile(projectPath: string, entries: Map<string, LockfileEntry>, ctx?: DurableObjectState): void;
    /** Delete lockfile for a project (e.g., after package.json changes). */
    deleteLockfile(projectPath: string): void;
    /** Get a pre-bundled ESM module. */
    getEsmBundle(specifier: string): EsmBundleEntry | null;
    /** Store a pre-bundled ESM module. */
    putEsmBundle(entry: EsmBundleEntry): void;
    /** Delete a pre-bundled ESM module (e.g., after package update). */
    deleteEsmBundle(specifier: string): void;
    /** Delete all ESM bundles (e.g., after full reinstall). */
    clearEsmBundles(): void;
    /**
     * Read a persisted transform for a user module. Returns the entry only
     * when BOTH the content hash and bundler version still match the
     * caller's request — a hash/version mismatch is reported as a miss so
     * the caller re-transforms (the stale row is overwritten on the next
     * put). This makes the cache content-addressed: a source edit whose
     * VFS event the dev server missed still invalidates here, because the
     * content hash no longer matches.
     */
    getUserModuleTransform(vfsPath: string, contentHash: string, bundlerVersion: string): UserModuleTransformEntry | null;
    /** Persist a transformed user module (INSERT OR REPLACE on vfs_path). */
    putUserModuleTransform(entry: UserModuleTransformEntry): void;
    /** Drop a persisted transform (e.g. when a file is deleted). */
    deleteUserModuleTransform(vfsPath: string): void;
    getStats(): {
        registryEntries: number;
        lockfileProjects: number;
        esmBundles: number;
        userModuleTransforms: number;
    };
}
//# sourceMappingURL=cache.d.ts.map