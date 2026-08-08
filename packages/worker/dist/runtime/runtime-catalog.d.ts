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
 *   { version: 1, runtimes: { <name>: { default, versions: { <ver>: { manifest, manifest_sha256, size_bytes, license } } } } }
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
 *
 * Trust model
 * ───────────
 * R2 is the trusted tier: no binding in this Worker can write it (asserted
 * by scripts/deploy-isolation.mjs), so only the operator's publish script
 * puts bytes there. L2 is `caches.default`, which the Worker DOES write and
 * which is shared per-colo across every tenant — untrusted storage, exactly
 * like the npm tarball bucket in ../npm/r2-cache.ts, and hardened the same
 * way. Blobs here are interpreters (python, ruby, bash, clang), so bytes
 * that reach a session are bytes that execute in it.
 *
 * Every L2 entry is therefore keyed by the SHA-256 of its own contents and
 * re-hashed on the way out, so an entry can only ever be found under the
 * hash of what it contains: a writer cannot address another value's key and
 * a reader cannot be handed bytes it did not ask for. The digests chain from
 * a build-time root — RUNTIME_CATALOG_SHA256 pins catalog/v1.json, the
 * catalog pins each manifest, each manifest pins its blobs.
 *
 * A value whose digest we do not know in advance does not participate in L2
 * at all; it is read from R2 and not cached. Refusing to cache what cannot
 * be verified is the point, and `l2Address` returning null is the only way
 * that happens — there is no "trust the key instead" fallback. That also
 * makes a stale pin a cache miss rather than an outage.
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
    /** Hex sha256 of the manifest bytes. Absent on catalogs published
     *  before the digest was recorded — those manifests stay out of L2. */
    manifest_sha256?: string;
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
/**
 * Fetch the top-level catalog, verified against the build-time pin.
 *
 * A pin that has drifted behind a fresh publish is not an error: R2 is the
 * trusted tier, so the catalog is served from it and simply not cached.
 * The condition is logged once per isolate because a silently disabled
 * cache is otherwise invisible.
 */
export declare function fetchCatalog(env: RuntimeCatalogEnv): Promise<RuntimeCatalog>;
/**
 * Fetch the manifest a catalog entry points at, verified against the
 * digest that same entry carries.
 *
 * Taking the whole entry rather than a bare key is what keeps the key and
 * its digest from ever being passed independently: there is no argument
 * list in which they can disagree.
 */
export declare function fetchManifest(env: RuntimeCatalogEnv, entry: CatalogVersionEntry): Promise<RuntimeManifest>;
/**
 * Fetch the blob a manifest file entry points at, verified against the
 * digest that same entry carries.
 *
 * The digest is not optional and does not travel separately from the key:
 * a `ManifestFile` always has both, and it is the only thing this takes.
 * Blobs are interpreters, so an unverified read here is arbitrary code
 * execution in whichever session installs it.
 */
export declare function fetchBlob(env: RuntimeCatalogEnv, file: ManifestFile): Promise<Uint8Array>;
export {};
//# sourceMappingURL=runtime-catalog.d.ts.map