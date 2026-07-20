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
 *   blobs/<name>-<version>/<sha256>/<file>   ← content-addressed blobs
 *
 * Catalog schema (RuntimeCatalog):
 *   { version: 1, runtimes: { <name>: { default, versions: { <ver>: { manifest, size_bytes, license } } } } }
 *
 * Manifest schema (RuntimeManifest):
 *   { name, version, license, wasi_namespace,
 *     files: [{ path, content, sha256, size, mode? }],
 *     entrypoints: [{ binName, runner, args[], kind? }],
 *     runtime_artifacts?: [
 *       { path, kind: "workerd-adapter", id, source_sha256?, sha256 },
 *       { path, kind: "python-package", id, language: "python", packageName,
 *         version, abi, pyodideVersion, pythonVersion, wheelFileName,
 *         wheelSha256, loadMode: "startup-module", imports[], dependencies[],
 *         extensionModules[] }
 *     ] }
 *
 * R2 and Cache API failures throw; the shell verb formats the diagnostic for
 * the user.
 */
import { z } from 'zod/v4';
import { PYODIDE_PACKAGE_ABI } from './os-contracts.js';
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
export interface RuntimeArtifactMetadata {
    path: string;
    kind: string;
    id: string;
    source_sha256?: string;
    sha256: string;
}
export type RuntimePythonPackageAbi = typeof PYODIDE_PACKAGE_ABI;
export interface RuntimePythonExtensionModuleMetadata {
    /** Path inside Python site-packages, as stored in the wheel. */
    path: string;
    /** Path inside the installed Nimbus runtime root. */
    runtimePath: string;
    sha256: string;
}
export interface RuntimePythonPackageArtifactMetadata extends RuntimeArtifactMetadata {
    kind: 'python-package';
    language: 'python';
    packageName: string;
    version: string;
    abi: RuntimePythonPackageAbi;
    pyodideVersion: string;
    pythonVersion: string;
    wheelFileName: string;
    wheelSha256: string;
    loadMode: 'startup-module';
    imports: string[];
    dependencies: string[];
    extensionModules: RuntimePythonExtensionModuleMetadata[];
}
export interface RuntimeManifest {
    name: string;
    version: string;
    license: string;
    /** Which WASI namespace the binaries import — `wasi_unstable` for
     *  binji clang. `null` for non-WASI runtimes (e.g. Pyodide). */
    wasi_namespace: string | null;
    files: ManifestFile[];
    entrypoints: ManifestEntrypoint[];
    runtime_artifacts?: RuntimeArtifactMetadata[];
}
export declare const RuntimePythonPackageArtifactMetadataSchema: z.ZodType<RuntimePythonPackageArtifactMetadata>;
export declare function parseRuntimeCatalog(value: unknown): RuntimeCatalog;
export declare function parseRuntimeManifest(value: unknown): RuntimeManifest;
export declare function isRuntimePythonPackageArtifactMetadata(artifact: RuntimeArtifactMetadata): artifact is RuntimePythonPackageArtifactMetadata;
/** Fetch the top-level catalog. Throws if neither L2 nor R2 has it. */
export declare function fetchCatalog(env: RuntimeCatalogEnv): Promise<RuntimeCatalog>;
/** Fetch a per-version manifest by its R2 key. */
export declare function fetchManifest(env: RuntimeCatalogEnv, manifestKey: string): Promise<RuntimeManifest>;
/**
 * Fetch a content-addressed blob by R2 key. Bytes are eternally
 * cacheable when the manifest key includes the content digest. Older
 * manifests used version-only keys, so L2 can contain stale bytes after
 * a corrected runtime sync. A cached sha mismatch is therefore treated
 * as a stale cache entry and refetched from R2; an R2 mismatch remains
 * a hard integrity failure.
 */
export declare function fetchBlob(env: RuntimeCatalogEnv, blobKey: string, expectedSha256?: string): Promise<Uint8Array>;
export declare function sha256Hex(bytes: Uint8Array): Promise<string>;
export {};
//# sourceMappingURL=runtime-catalog.d.ts.map