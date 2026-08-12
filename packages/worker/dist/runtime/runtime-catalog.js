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
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
import { RUNTIME_CATALOG_SHA256 } from '../runtime-catalog.generated.js';
import { PYODIDE_PACKAGE_ABI } from '@nimbus-sh/core/runtime/os-contracts.js';
const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CatalogVersionEntrySchema = z.object({
    manifest: z.string().min(1),
    manifest_sha256: HexSha256Schema.optional(),
    size_bytes: z.number().int().nonnegative(),
    license: z.string(),
});
const RuntimeCatalogSchema = z.object({
    version: z.literal(1),
    runtimes: z.record(z.string(), z.object({
        default: z.string().min(1),
        versions: z.record(z.string(), CatalogVersionEntrySchema),
    })),
});
const ManifestFileSchema = z.object({
    path: z.string().min(1),
    content: z.string().min(1),
    sha256: HexSha256Schema,
    size: z.number().int().nonnegative(),
    mode: z.literal('exec').optional(),
});
const ManifestEntrypointSchema = z.object({
    binName: z.string().min(1),
    runner: z.string().min(1),
    args: z.array(z.string()),
    kind: z.string().optional(),
});
const RuntimeArtifactMetadataSchema = z.object({
    path: z.string().min(1),
    kind: z.string().min(1),
    id: z.string().min(1),
    source_sha256: HexSha256Schema.optional(),
    sha256: HexSha256Schema,
}).passthrough();
export const RuntimePythonPackageArtifactMetadataSchema = RuntimeArtifactMetadataSchema.and(z.object({
    kind: z.literal('python-package'),
    language: z.literal('python'),
    packageName: z.string().min(1),
    version: z.string().min(1),
    abi: z.literal(PYODIDE_PACKAGE_ABI),
    pyodideVersion: z.string().min(1),
    pythonVersion: z.string().min(1),
    wheelFileName: z.string().min(1),
    wheelSha256: HexSha256Schema,
    loadMode: z.literal('startup-module'),
    imports: z.array(z.string()),
    dependencies: z.array(z.string()),
    extensionModules: z.array(z.object({
        path: z.string().min(1),
        runtimePath: z.string().min(1),
        sha256: HexSha256Schema,
    })),
}));
const RuntimeManifestSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string(),
    wasi_namespace: z.string().nullable(),
    files: z.array(ManifestFileSchema),
    entrypoints: z.array(ManifestEntrypointSchema),
    runtime_artifacts: z.array(RuntimeArtifactMetadataSchema).optional(),
});
export function parseRuntimeCatalog(value) {
    return RuntimeCatalogSchema.parse(value);
}
export function parseRuntimeManifest(value) {
    return RuntimeManifestSchema.parse(value);
}
export function isRuntimePythonPackageArtifactMetadata(artifact) {
    return RuntimePythonPackageArtifactMetadataSchema.safeParse(artifact).success;
}
// ── L2 content addressing ────────────────────────────────────────────
/** R2 key of the top-level catalog. */
const CATALOG_R2_KEY = 'catalog/v1.json';
/** Synthetic L2 cache-key host. Reserved-invalid TLD so keys can never
 *  collide with a real user request. Bumped to `-v2` when the keyspace
 *  moved from R2 keys to content addresses: every `v1` entry was written
 *  under a key its contents did not have to match, so none of them is
 *  trustworthy and all of them are abandoned rather than validated. */
const L2_NS = 'https://nimbus-runtime-cache-v2.invalid';
const HEX_SHA256 = /^[a-f0-9]{64}$/;
/**
 * Address an L2 entry by the digest of its contents.
 *
 * Returns null for anything unverifiable — a digest we were never given,
 * or one that is not a hex SHA-256. A null address takes the value out of
 * the shared cache entirely: it is read from R2 and not written back.
 */
function l2Address(scope, sha256) {
    if (!sha256)
        return null;
    const hex = sha256.toLowerCase();
    return HEX_SHA256.test(hex) ? { scope, sha256: hex } : null;
}
/** Pair bytes with their address if they hash to it; null otherwise. */
async function verifyBytes(address, bytes) {
    return await sha256Hex(bytes) === address.sha256 ? { address, bytes } : null;
}
// ── Fetchers ─────────────────────────────────────────────────────────
/**
 * Fetch the top-level catalog, verified against the build-time pin.
 *
 * A pin that has drifted behind a fresh publish is not an error: R2 is the
 * trusted tier, so the catalog is served from it and simply not cached.
 * The condition is logged once per isolate because a silently disabled
 * cache is otherwise invisible.
 */
export async function fetchCatalog(env) {
    const address = l2Address('catalog', RUNTIME_CATALOG_SHA256);
    if (address) {
        const cached = await l2Get(address);
        if (cached)
            return parseRuntimeCatalog(parseJsonBytes(cached));
    }
    const r2 = env.NIMBUS_RUNTIME_CACHE;
    if (!r2) {
        throw new Error('NIMBUS_RUNTIME_CACHE binding missing — catalog cannot be fetched');
    }
    const obj = await r2.get(CATALOG_R2_KEY);
    if (!obj) {
        throw new Error(`${CATALOG_R2_KEY} not in R2 — bundle pipeline has not seeded the catalog`);
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const verified = address && await verifyBytes(address, bytes);
    if (verified)
        await l2Put(verified, 'application/json');
    else
        await warnCatalogPinUnusable(bytes);
    return parseRuntimeCatalog(parseJsonBytes(bytes));
}
/**
 * Fetch the manifest a catalog entry points at, verified against the
 * digest that same entry carries.
 *
 * Taking the whole entry rather than a bare key is what keeps the key and
 * its digest from ever being passed independently: there is no argument
 * list in which they can disagree.
 */
export async function fetchManifest(env, entry) {
    const address = l2Address('manifest', entry.manifest_sha256);
    if (address) {
        const cached = await l2Get(address);
        if (cached)
            return parseRuntimeManifest(parseJsonBytes(cached));
    }
    const r2 = env.NIMBUS_RUNTIME_CACHE;
    if (!r2) {
        throw new Error('NIMBUS_RUNTIME_CACHE binding missing — manifest cannot be fetched');
    }
    const obj = await r2.get(entry.manifest);
    if (!obj) {
        throw new Error(`manifest ${entry.manifest} not in R2 — catalog references a missing manifest`);
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (address) {
        const verified = await verifyBytes(address, bytes);
        if (!verified) {
            throw new Error(`sha256 mismatch for manifest ${entry.manifest}: catalog expects ` +
                `${address.sha256}, R2 holds ${await sha256Hex(bytes)}`);
        }
        await l2Put(verified, 'application/json');
    }
    return parseRuntimeManifest(parseJsonBytes(bytes));
}
/**
 * Fetch the blob a manifest file entry points at, verified against the
 * digest that same entry carries.
 *
 * The digest is not optional and does not travel separately from the key:
 * a `ManifestFile` always has both, and it is the only thing this takes.
 * Blobs are interpreters, so an unverified read here is arbitrary code
 * execution in whichever session installs it.
 */
export async function fetchBlob(env, file) {
    const address = l2Address('blob', file.sha256);
    if (!address) {
        throw new Error(`manifest entry ${file.path} has no usable sha256 (${file.sha256})`);
    }
    const cached = await l2Get(address);
    if (cached)
        return cached;
    const r2 = env.NIMBUS_RUNTIME_CACHE;
    if (!r2) {
        throw new Error('NIMBUS_RUNTIME_CACHE binding missing — blob cannot be fetched');
    }
    const obj = await r2.get(file.content);
    if (!obj) {
        throw new Error(`blob ${file.content} not in R2 — manifest references a missing blob`);
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const verified = await verifyBytes(address, bytes);
    if (!verified) {
        throw new Error(`sha256 mismatch for blob ${file.content}: manifest expects ${address.sha256}, ` +
            `R2 holds ${await sha256Hex(bytes)}`);
    }
    await l2Put(verified, 'application/octet-stream');
    return verified.bytes;
}
/** Read the entry at `address`, or null on miss, on a stripped Cache API,
 *  or when what came back does not hash to the key it was found under. */
async function l2Get(address) {
    try {
        const caches = globalThis.caches;
        if (!caches?.default)
            return null;
        const hit = await caches.default.match(new Request(l2Url(address)));
        if (!hit || !hit.ok)
            return null;
        const bytes = new Uint8Array(await hit.arrayBuffer());
        return await verifyBytes(address, bytes) ? bytes : null;
    }
    catch {
        return null;
    }
}
/** Write verified bytes under their own digest. Eternal-immutable: a
 *  content address cannot go stale, and new bytes land on a new key. */
async function l2Put(verified, contentType) {
    try {
        const caches = globalThis.caches;
        if (!caches?.default)
            return;
        const resp = new Response(verified.bytes, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        });
        await caches.default.put(new Request(l2Url(verified.address)), resp);
    }
    catch { /* best-effort */ }
}
function l2Url(address) {
    return `${L2_NS}/${address.scope}/${address.sha256}`;
}
function parseJsonBytes(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
}
let catalogPinWarned = false;
async function warnCatalogPinUnusable(bytes) {
    if (catalogPinWarned)
        return;
    catalogPinWarned = true;
    console.warn(`[nimbus/runtime-catalog] RUNTIME_CATALOG_SHA256 is ${RUNTIME_CATALOG_SHA256 || '(unset)'} ` +
        `but ${CATALOG_R2_KEY} hashes to ${await sha256Hex(bytes)}. Serving from R2 and skipping ` +
        'the colo cache. Rerun `node scripts/bundle-runtime.mjs --pin-catalog`, commit ' +
        'src/runtime-catalog.generated.ts, and redeploy.');
}
