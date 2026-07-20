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

const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const CatalogVersionEntrySchema = z.object({
  manifest: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  license: z.string(),
});

const RuntimeCatalogSchema: z.ZodType<RuntimeCatalog> = z.object({
  version: z.literal(1),
  runtimes: z.record(z.string(), z.object({
    default: z.string().min(1),
    versions: z.record(z.string(), CatalogVersionEntrySchema),
  })),
});

const ManifestFileSchema: z.ZodType<ManifestFile> = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  sha256: HexSha256Schema,
  size: z.number().int().nonnegative(),
  mode: z.literal('exec').optional(),
});

const ManifestEntrypointSchema: z.ZodType<ManifestEntrypoint> = z.object({
  binName: z.string().min(1),
  runner: z.string().min(1),
  args: z.array(z.string()),
  kind: z.string().optional(),
});

const RuntimeArtifactMetadataSchema: z.ZodType<RuntimeArtifactMetadata> = z.object({
  path: z.string().min(1),
  kind: z.string().min(1),
  id: z.string().min(1),
  source_sha256: HexSha256Schema.optional(),
  sha256: HexSha256Schema,
}).passthrough();

export const RuntimePythonPackageArtifactMetadataSchema: z.ZodType<RuntimePythonPackageArtifactMetadata> =
  RuntimeArtifactMetadataSchema.and(z.object({
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

const RuntimeManifestSchema: z.ZodType<RuntimeManifest> = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string(),
  wasi_namespace: z.string().nullable(),
  files: z.array(ManifestFileSchema),
  entrypoints: z.array(ManifestEntrypointSchema),
  runtime_artifacts: z.array(RuntimeArtifactMetadataSchema).optional(),
});

export function parseRuntimeCatalog(value: unknown): RuntimeCatalog {
  return RuntimeCatalogSchema.parse(value);
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  return RuntimeManifestSchema.parse(value);
}

export function isRuntimePythonPackageArtifactMetadata(
  artifact: RuntimeArtifactMetadata,
): artifact is RuntimePythonPackageArtifactMetadata {
  return RuntimePythonPackageArtifactMetadataSchema.safeParse(artifact).success;
}

// ── Cache key helpers ────────────────────────────────────────────────

/** Synthetic L2 cache URLs. Reserved-invalid TLD so they can never
 *  collide with real user requests. */
const L2_NS = 'https://nimbus-runtime-cache.invalid';
const catalogL2Key = () => `${L2_NS}/catalog/v1.json`;
const l2Key = (key: string) => `${L2_NS}/${key}`;

// ── Fetchers ─────────────────────────────────────────────────────────

/** Fetch the top-level catalog. Throws if neither L2 nor R2 has it. */
export async function fetchCatalog(env: RuntimeCatalogEnv): Promise<RuntimeCatalog> {
  // L2 hot path.
  const text = await l2GetText(catalogL2Key());
  if (text) return parseRuntimeCatalog(JSON.parse(text));

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
  return parseRuntimeCatalog(JSON.parse(catalogText));
}

/** Fetch a per-version manifest by its R2 key. */
export async function fetchManifest(
  env: RuntimeCatalogEnv,
  manifestKey: string,
): Promise<RuntimeManifest> {
  // L2 hot path.
  const text = await l2GetText(l2Key(manifestKey));
  if (text) return parseRuntimeManifest(JSON.parse(text));

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
  await l2PutText(l2Key(manifestKey), manifestText, 300);
  return parseRuntimeManifest(JSON.parse(manifestText));
}

/**
 * Fetch a content-addressed blob by R2 key. Bytes are eternally
 * cacheable when the manifest key includes the content digest. Older
 * manifests used version-only keys, so L2 can contain stale bytes after
 * a corrected runtime sync. A cached sha mismatch is therefore treated
 * as a stale cache entry and refetched from R2; an R2 mismatch remains
 * a hard integrity failure.
 */
export async function fetchBlob(
  env: RuntimeCatalogEnv,
  blobKey: string,
  expectedSha256?: string,
): Promise<Uint8Array> {
  // L2 hot path.
  const cached = await l2GetBytes(l2Key(blobKey));
  if (cached) {
    if (!expectedSha256 || await bytesMatchSha256(cached, expectedSha256)) {
      return cached;
    }
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

  // Eternal-immutable write-back. Integrity has already been verified
  // against the manifest before writing to L2.
  await l2PutBytes(l2Key(blobKey), bytes);
  return bytes;
}

// ── sha256 verifier ──────────────────────────────────────────────────

async function assertSha256(bytes: Uint8Array, expected: string, label: string): Promise<void> {
  const hex = await sha256Hex(bytes);
  if (hex !== expected.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${label}: expected ${expected} got ${hex}`);
  }
}

async function bytesMatchSha256(bytes: Uint8Array, expected: string): Promise<boolean> {
  return await sha256Hex(bytes) === expected.toLowerCase();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
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
