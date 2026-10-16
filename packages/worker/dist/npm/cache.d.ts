import type { RegistryCacheEntry } from './registry-record.js';
/**
 * Where a registry record was read: the registry's origin and the network it
 * was read through (WorkspaceNetwork.id: '' for the isolate's own, else the
 * egress's). A record answers only an install reading the same.
 */
export interface RecordSource {
    readonly registry: string;
    readonly network: string;
}
/**
 * One placement in a project's lockfile. The Map key is the placement path
 * (`name` at root, `<dependent>/node_modules/<name>` nested); it is what the
 * `name` column of `pkg_lockfile` holds, whose primary key predates nesting.
 */
export interface LockfileEntry {
    /** The name it installs under (its folder's). */
    name: string;
    /** The registry package it is (an alias's target): its record's key. '' for rows written before it was kept. */
    registryName: string;
    resolvedVer: string;
    integrity: string;
    hoistedPath: string;
}
export interface EsmBundleEntry {
    specifier: string;
    bundleHash: string;
    esmCode: string;
    builtAt: number;
    inputHash: string;
    /**
     * The VFS paths the bundle was built from. The cache is the workspace's,
     * shared by every server in it whoever started it, so a reader serves an
     * entry only to a principal who may read every one of them.
     */
    sources: readonly string[];
}
export interface UserModuleTransformEntry {
    /** VFS path of the source module (e.g. "home/user/projects/src/App.tsx"). */
    vfsPath: string;
    /**
     * Mount base the transform was built for ('' for a root-mounted request,
     * e.g. '/s/otter-4271/preview' for the session preview path). The transform
     * bakes the base (router basename, BASE_URL, module URLs), so it is part of
     * the key: the same source served under two mounts has two rows.
     */
    base: string;
    /** SHA-256 (base64url) of the source bytes the transform was built from. */
    contentHash: string;
    /** The code the transform output was produced with: npm/cache-keys.ts's userModuleTransformCacheKey. */
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
     *  binJson + a few tens of bytes overhead). This is a
     *  good proxy for "how much L1 data did we save fetching" — not the
     *  exact SQLite blob byte count (which would require a separate
     *  SELECT). */
    getRegistryEntry(source: RecordSource, name: string, version: string): RegistryCacheEntry | null;
    /**
     * getRegistryEntry for each `[name, version]`, read together: the record
     * by `name@version`, or null; each counted as getRegistryEntry counts it.
     */
    getRegistryEntries(source: RecordSource, keys: ReadonlyArray<readonly [string, string]>): Map<string, RegistryCacheEntry | null>;
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
    putRegistryEntries(source: RecordSource, entries: RegistryCacheEntry[]): {
        written: number;
        failed: number;
    };
    /** Read the lockfile for a project, keyed by placement path. Null if not found. */
    readLockfile(projectPath: string): Map<string, LockfileEntry> | null;
    /**
     * Every installed package directory (namespace key, no leading slash) and
     * the integrity its tarball was pinned to, across projects.
     */
    installedIntegrities(): Map<string, string>;
    /**
     * What changes when anything is installed in or removed from any project:
     * a digest of every lockfile row. What is kept of what installs put on disk
     * (the manifests a launch is handed, facets/manager.ts _installedManifests)
     * is reread when it changes.
     */
    installRevision(): string;
    /**
     * Write/overwrite the lockfile for a project. Atomic via transaction.
     * `previous`: what the table holds for it now (readLockfile's answer),
     * so only the rows that change are written.
     */
    writeLockfile(projectPath: string, entries: Map<string, LockfileEntry>, ctx?: DurableObjectState, previous?: ReadonlyMap<string, LockfileEntry> | null): void;
    /** Get a pre-bundled ESM module. */
    getEsmBundle(specifier: string): EsmBundleEntry | null;
    /** Store a pre-bundled ESM module. */
    putEsmBundle(entry: EsmBundleEntry): void;
    /**
     * Read a persisted transform for a user module. Returns the entry only
     * when BOTH the content hash and bundler version still match the
     * caller's request — a hash/version mismatch is reported as a miss so
     * the caller re-transforms (the stale row is overwritten on the next
     * put). This makes the cache content-addressed: a source edit whose
     * VFS event the dev server missed still invalidates here, because the
     * content hash no longer matches.
     */
    getUserModuleTransform(vfsPath: string, base: string, contentHash: string, bundlerVersion: string): UserModuleTransformEntry | null;
    /** Persist a transformed user module (INSERT OR REPLACE on (vfs_path, base)). */
    putUserModuleTransform(entry: UserModuleTransformEntry): void;
    /** Drop persisted transforms for a path across every mount base (e.g. when
     *  a file is deleted). */
    deleteUserModuleTransform(vfsPath: string): void;
}
//# sourceMappingURL=cache.d.ts.map