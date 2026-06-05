/**
 * runtime-catalog.ts — R2 + Cache API L2 wrapper for the
 * `nimbus install <runtime>` package manager.
 *
 *   L1 (per-DO SqliteFS) — populated at install time.
 *   L2 (caches.default per-colo) — sub-ms reads after first hit.
 *   L3 (R2 nimbus-runtime-cache) — primary source of truth.
 *
 * R2 layout:
 *
 *   catalog/v1.json                          ← top-level catalog
 *   manifests/<name>-<version>.json          ← per-version manifest
 *   blobs/<name>-<version>/<file>            ← content-addressed blobs
 *
 * Catalog schema (RuntimeCatalog):
 *   { version: 1, runtimes: { <name>: { default, versions: { <ver>: { manifest, size_bytes, license } } } } }
 *
 * Manifest schema (RuntimeManifest):
 *   { name, version, license, wasi_namespace, memfs_companion,
 *     files: [{ path, content, sha256, size, mode? }],
 *     entrypoints: [{ binName, runner, args[], kind? }] }
 *
 * R2 and Cache API failures throw; the shell verb formats the diagnostic for
 * the user.
 */
/** Minimal R2Bucket shape we depend on. */
type R2BucketLike = {
    get(key: string): Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
        text(): Promise<string>;
    } | null>;
} | null | undefined;
/** Minimal env shape this module consumes. */
export interface RuntimeCatalogEnv {
    NIMBUS_RUNTIME_CACHE?: R2BucketLike;
}
export interface CatalogVersionEntry {
    manifest: string;
    size_bytes: number;
    license: string;
}
export interface CatalogRuntimeEntry {
    default: string;
    versions: Record<string, CatalogVersionEntry>;
}
export interface RuntimeCatalog {
    version: 1;
    runtimes: Record<string, CatalogRuntimeEntry>;
}
export interface ManifestFile {
    /** VFS path relative to ~/.nimbus/runtimes/<name>/<version>/. */
    path: string;
    /** R2 key for the content blob. */
    content: string;
    /** Hex sha256 of the content blob bytes. */
    sha256: string;
    /** Byte size. */
    size: number;
    /** Optional file mode hint ("exec" → registered as a shell bin). */
    mode?: 'exec';
}
export interface ManifestEntrypoint {
    /** Shell command name. */
    binName: string;
    /** Runner key (e.g. "clang-runner") — package manager dispatches to
     *  the right runner factory by this. */
    runner: string;
    /** Default args prepended to user args at invocation. */
    args: string[];
    /** Optional secondary classification (e.g. "linker" for wasm-ld). */
    kind?: string;
}
export interface RuntimeManifest {
    name: string;
    version: string;
    license: string;
    /** Which WASI namespace the binaries import — `wasi_unstable` for
     *  binji clang. `null` for non-WASI runtimes (e.g. Pyodide). */
    wasi_namespace: string | null;
    /** Optional sibling-blob VFS path that the runner needs to load
     *  as a 2nd `modules:` entry (binji's memfs.wasm helper). */
    memfs_companion: string | null;
    files: ManifestFile[];
    entrypoints: ManifestEntrypoint[];
}
/** Fetch the top-level catalog. Throws if neither L2 nor R2 has it. */
export declare function fetchCatalog(env: RuntimeCatalogEnv): Promise<RuntimeCatalog>;
/** Fetch a per-version manifest by its R2 key. */
export declare function fetchManifest(env: RuntimeCatalogEnv, manifestKey: string): Promise<RuntimeManifest>;
/**
 * Fetch a content-addressed blob by R2 key. Bytes are eternally
 * cacheable because the key encodes the version. Verifies sha256 if
 * `expectedSha256` is provided.
 */
export declare function fetchBlob(env: RuntimeCatalogEnv, blobKey: string, expectedSha256?: string): Promise<Uint8Array>;
export {};
//# sourceMappingURL=runtime-catalog.d.ts.map