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
// ── Cache key helpers ────────────────────────────────────────────────
/** Synthetic L2 cache URLs. Reserved-invalid TLD so they can never
 *  collide with real user requests. */
const L2_NS = 'https://nimbus-runtime-cache.invalid';
const catalogL2Key = () => `${L2_NS}/catalog/v1.json`;
const manifestL2Key = (key) => `${L2_NS}/${key}`;
const blobL2Key = (key) => `${L2_NS}/${key}`;
// ── Fetchers ─────────────────────────────────────────────────────────
/** Fetch the top-level catalog. Throws if neither L2 nor R2 has it. */
export async function fetchCatalog(env) {
    // L2 hot path.
    const text = await l2GetText(catalogL2Key());
    if (text)
        return JSON.parse(text);
    // R2 path.
    const r2 = env.NIMBUS_RUNTIME_CACHE;
    if (!r2) {
        throw new Error('NIMBUS_RUNTIME_CACHE binding missing — catalog cannot be fetched');
    }
    const obj = await r2.get('catalog/v1.json');
    if (!obj) {
        throw new Error('catalog/v1.json not in R2 — bundle pipeline has not seeded the catalog');
    }
    const catalogText = await obj.text();
    // Cache for next call. Catalog is small (~1 KB) — 5-min TTL via
    // Cache-Control: this matches Pyodide-research §D2's "5-min TTL on
    // packument-style metadata".
    await l2PutText(catalogL2Key(), catalogText, 300);
    return JSON.parse(catalogText);
}
/** Fetch a per-version manifest by its R2 key. */
export async function fetchManifest(env, manifestKey) {
    // L2 hot path.
    const text = await l2GetText(manifestL2Key(manifestKey));
    if (text)
        return JSON.parse(text);
    // R2 path.
    const r2 = env.NIMBUS_RUNTIME_CACHE;
    if (!r2) {
        throw new Error('NIMBUS_RUNTIME_CACHE binding missing — manifest cannot be fetched');
    }
    const obj = await r2.get(manifestKey);
    if (!obj) {
        throw new Error(`manifest ${manifestKey} not in R2 — catalog references a missing manifest`);
    }
    const manifestText = await obj.text();
    // 5-min TTL — manifests are content-addressed by version so we
    // could go eternal, but a short TTL lets us correct a bad upload
    // by re-running bundle-runtime.mjs without manual cache invalidation.
    await l2PutText(manifestL2Key(manifestKey), manifestText, 300);
    return JSON.parse(manifestText);
}
/**
 * Fetch a content-addressed blob by R2 key. Bytes are eternally
 * cacheable because the key encodes the version. Verifies sha256 if
 * `expectedSha256` is provided.
 */
export async function fetchBlob(env, blobKey, expectedSha256) {
    // L2 hot path.
    const cached = await l2GetBytes(blobL2Key(blobKey));
    if (cached) {
        if (expectedSha256)
            await assertSha256(cached, expectedSha256, blobKey);
        return cached;
    }
    // R2 path.
    const r2 = env.NIMBUS_RUNTIME_CACHE;
    if (!r2) {
        throw new Error('NIMBUS_RUNTIME_CACHE binding missing — blob cannot be fetched');
    }
    const obj = await r2.get(blobKey);
    if (!obj) {
        throw new Error(`blob ${blobKey} not in R2 — manifest references a missing blob`);
    }
    const ab = await obj.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (expectedSha256)
        await assertSha256(bytes, expectedSha256, blobKey);
    // Eternal-immutable write-back (content-addressed; never changes).
    await l2PutBytes(blobL2Key(blobKey), bytes);
    return bytes;
}
// ── sha256 verifier ──────────────────────────────────────────────────
async function assertSha256(bytes, expected, label) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = bytesToHex(new Uint8Array(digest));
    if (hex !== expected.toLowerCase()) {
        throw new Error(`sha256 mismatch for ${label}: expected ${expected} got ${hex}`);
    }
}
function bytesToHex(b) {
    let s = '';
    for (let i = 0; i < b.length; i++)
        s += b[i].toString(16).padStart(2, '0');
    return s;
}
// ── L2 (caches.default) helpers ──────────────────────────────────────
async function l2GetText(key) {
    try {
        const c = globalThis.caches;
        if (!c?.default)
            return null;
        const hit = await c.default.match(new Request(key));
        if (!hit || !hit.ok)
            return null;
        return await hit.text();
    }
    catch {
        return null;
    }
}
async function l2PutText(key, text, ttlSeconds) {
    try {
        const c = globalThis.caches;
        if (!c?.default)
            return;
        const resp = new Response(text, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${ttlSeconds}`,
            },
        });
        await c.default.put(new Request(key), resp);
    }
    catch { /* silent */ }
}
async function l2GetBytes(key) {
    try {
        const c = globalThis.caches;
        if (!c?.default)
            return null;
        const hit = await c.default.match(new Request(key));
        if (!hit || !hit.ok)
            return null;
        const ab = await hit.arrayBuffer();
        return new Uint8Array(ab);
    }
    catch {
        return null;
    }
}
async function l2PutBytes(key, bytes) {
    try {
        const c = globalThis.caches;
        if (!c?.default)
            return;
        const resp = new Response(bytes, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        });
        await c.default.put(new Request(key), resp);
    }
    catch { /* silent */ }
}
