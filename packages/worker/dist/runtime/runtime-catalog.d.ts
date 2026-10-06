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
 *   catalog/sha256/<sha256>.json             ← a catalog, by the digest of its bytes
 *   catalog/v1.json                          ← the latest catalog, for deployments that predate the above
 *   manifests/<name>-<version>.json          ← per-version manifest
 *   blobs/<name>-<version>/<sha256>/<file>   ← content-addressed blobs
 *
 * Catalog schema (RuntimeCatalog):
 *   { version: 1, runtimes: { <name>: { default, versions: { <ver>: { manifest, manifest_sha256, size_bytes, license } } } } }
 *
 * Manifest schema: `@nimbus-sh/core` runtime/runtime-manifest.ts. What a
 * runtime IS does not depend on which tier served it, so this module only
 * fetches and verifies manifests; it does not describe them.
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
 * the deployment's root: NIMBUS_RUNTIME_CATALOG_SHA256, a var each deployment
 * carries, names the catalog its bucket holds by digest, the catalog pins
 * each manifest, each manifest pins its blobs.
 *
 * The catalog is read by that digest (catalog/sha256/<digest>.json) and
 * served only when its bytes hash to it, so a publish for one deployment
 * never changes what another reads. A missing var, a missing object or bytes
 * that do not hash to the var fail the install loudly and say which; there is
 * no unpinned read.
 *
 * A manifest or blob whose digest we do not know in advance does not
 * participate in L2 at all; it is read from R2 and not cached. Refusing to
 * cache what cannot be verified is the point, and `l2Address` returning null
 * is the only way that happens — there is no "trust the key instead" fallback.
 */
import { type ManifestFile, type RuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
import { type RuntimeSource } from '@nimbus-sh/core/runtime/runtime-package.js';
import { type RuntimePackageAbi } from '@nimbus-sh/core/runtime/os-contracts.js';
/** Minimal R2Bucket shape we depend on. */
type R2BucketLike = {
    get(key: string): Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
        text(): Promise<string>;
        readonly body: ReadableStream<Uint8Array>;
    } | null>;
} | null | undefined;
/** Minimal env shape this module consumes. */
export interface RuntimeCatalogEnv {
    NIMBUS_RUNTIME_CACHE?: R2BucketLike;
    /**
     * The SHA-256 of the catalog this deployment's NIMBUS_RUNTIME_CACHE holds:
     * a var in its wrangler config. `nimbus runtime sync` prints it for the
     * bucket it fills; Nimbus's own configs are written by bundle-runtime.mjs.
     */
    NIMBUS_RUNTIME_CATALOG_SHA256?: string;
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
export declare function parseRuntimeCatalog(value: unknown): RuntimeCatalog;
/**
 * R2 key of the catalog whose bytes hash to `sha256`. bundle-runtime.mjs
 * writes the same key (catalogKey there); tests/unit/bundle-runtime-catalog-pin.mjs
 * holds the two to one spelling.
 */
export declare function catalogKey(sha256: string): string;
/** What `nimbus install` says when the deployment does not name its catalog. */
export declare const CATALOG_PIN_MISSING: string;
/**
 * Fetch the catalog the deployment names (NIMBUS_RUNTIME_CATALOG_SHA256),
 * by its digest, and only if its bytes hash to it.
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
 * Stream the blob a manifest file entry points at, verified against the
 * digest that same entry carries: from the colo cache when it has it, else
 * from R2, read once either way. The stream errors at its end, rather than
 * closing, with a {@link RuntimeBlobDigestMismatch} when its bytes do not
 * hash to the digest; a colo-cache entry that fails is evicted and
 * distrusted first, so the installer's second read of that blob comes from
 * R2 whatever the cache holds by then. The installer commits
 * a blob only after that clean close, so no step holds a blob whole.
 *
 * The digest is not optional and does not travel separately from the key:
 * a `ManifestFile` always has both, and it is the only thing this takes.
 * Blobs are interpreters, so an unverified read here is arbitrary code
 * execution in whichever session installs it.
 */
export declare function fetchBlob(env: RuntimeCatalogEnv, file: ManifestFile): Promise<ReadableStream<Uint8Array>>;
export declare function runtimeAbiForCatalogName(name: string): RuntimePackageAbi;
/**
 * The R2 catalog as a core `RuntimeSource` — the worker adapter half of the
 * install path, so a workspace composed inside this Worker resolves
 * `nimbus install <spec>` against the same bucket and digest chain the
 * session's installer always used. Aliases resolve the way the old
 * resolver did: `python` redirects to `cpython` unless a version pins it,
 * and any bin a runtime's default manifest declares resolves to that
 * runtime — except a superseded one, which never answers for a bin.
 */
export declare function runtimeCatalogSource(env: RuntimeCatalogEnv): RuntimeSource;
export {};
//# sourceMappingURL=runtime-catalog.d.ts.map