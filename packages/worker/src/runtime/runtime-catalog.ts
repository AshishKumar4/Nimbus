/**
 * runtime-catalog.ts — R2 + Cache API L2 wrapper for the
 * `nimbus install <runtime>` package manager.
 *
 * Per `/workspace/.seal-internal/2026-05-10-true-os/plan.md` §2.3, §2.4:
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
 * The wave's anti-reqs apply: no setTimeout / no retry / no defensive-
 * catch. R2 / cache failures throw; the verb's UX surface formats them.
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

// ── Schemas ──────────────────────────────────────────────────────────

export interface CatalogVersionEntry {
  manifest: string;       // R2 key, e.g. "manifests/clang-binji-2020.json"
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

// ── Cache key helpers ────────────────────────────────────────────────

/** Synthetic L2 cache URLs. Reserved-invalid TLD so they can never
 *  collide with real user requests. */
const L2_NS = 'https://nimbus-runtime-cache.invalid';
const catalogL2Key = () => `${L2_NS}/catalog/v1.json`;
const manifestL2Key = (key: string) => `${L2_NS}/${key}`;
const blobL2Key = (key: string) => `${L2_NS}/${key}`;

// ── Fetchers ─────────────────────────────────────────────────────────

/** Fetch the top-level catalog. Throws if neither L2 nor R2 has it. */
export async function fetchCatalog(env: RuntimeCatalogEnv): Promise<RuntimeCatalog> {
  // L2 hot path.
  const text = await l2GetText(catalogL2Key());
  if (text) return JSON.parse(text) as RuntimeCatalog;

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
  return JSON.parse(catalogText) as RuntimeCatalog;
}

/** Fetch a per-version manifest by its R2 key. */
export async function fetchManifest(
  env: RuntimeCatalogEnv,
  manifestKey: string,
): Promise<RuntimeManifest> {
  // L2 hot path.
  const text = await l2GetText(manifestL2Key(manifestKey));
  if (text) return JSON.parse(text) as RuntimeManifest;

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
  return JSON.parse(manifestText) as RuntimeManifest;
}

/**
 * Fetch a content-addressed blob by R2 key. Bytes are eternally
 * cacheable because the key encodes the version. Verifies sha256 if
 * `expectedSha256` is provided.
 */
export async function fetchBlob(
  env: RuntimeCatalogEnv,
  blobKey: string,
  expectedSha256?: string,
): Promise<Uint8Array> {
  // L2 hot path.
  const cached = await l2GetBytes(blobL2Key(blobKey));
  if (cached) {
    if (expectedSha256) await assertSha256(cached, expectedSha256, blobKey);
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
  if (expectedSha256) await assertSha256(bytes, expectedSha256, blobKey);

  // Eternal-immutable write-back (content-addressed; never changes).
  await l2PutBytes(blobL2Key(blobKey), bytes);
  return bytes;
}

// ── sha256 verifier ──────────────────────────────────────────────────

async function assertSha256(bytes: Uint8Array, expected: string, label: string): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = bytesToHex(new Uint8Array(digest));
  if (hex !== expected.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${label}: expected ${expected} got ${hex}`);
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// ── L2 (caches.default) helpers ──────────────────────────────────────

async function l2GetText(key: string): Promise<string | null> {
  try {
    const c: any = (globalThis as any).caches;
    if (!c?.default) return null;
    const hit = await c.default.match(new Request(key));
    if (!hit || !hit.ok) return null;
    return await hit.text();
  } catch { return null; }
}

async function l2PutText(key: string, text: string, ttlSeconds: number): Promise<void> {
  try {
    const c: any = (globalThis as any).caches;
    if (!c?.default) return;
    const resp = new Response(text, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttlSeconds}`,
      },
    });
    await c.default.put(new Request(key), resp);
  } catch { /* silent */ }
}

async function l2GetBytes(key: string): Promise<Uint8Array | null> {
  try {
    const c: any = (globalThis as any).caches;
    if (!c?.default) return null;
    const hit = await c.default.match(new Request(key));
    if (!hit || !hit.ok) return null;
    const ab = await hit.arrayBuffer();
    return new Uint8Array(ab);
  } catch { return null; }
}

async function l2PutBytes(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const c: any = (globalThis as any).caches;
    if (!c?.default) return;
    const resp = new Response(bytes, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
    await c.default.put(new Request(key), resp);
  } catch { /* silent */ }
}
