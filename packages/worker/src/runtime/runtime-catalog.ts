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

import { z } from 'zod/v4';
import { sha256Hex, sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
import {
  HexSha256Schema,
  parseRuntimeManifest,
  type ManifestFile,
  type RuntimeManifest,
} from '@nimbus-sh/core/runtime/runtime-manifest.js';
import { runtimeEntrypoints } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import {
  blobPieces,
  RuntimeBlobDigestMismatch,
  splitRuntimeSpec,
  SUPERSEDED_RUNTIMES,
  type RuntimeAvailability,
  type RuntimePackage,
  type RuntimeSource,
} from '@nimbus-sh/core/runtime/runtime-package.js';
import {
  NIMBUS_RUNTIME_ABIS,
  NATIVE_UNSUPPORTED_ABI,
  type RuntimePackageAbi,
} from '@nimbus-sh/core/runtime/os-contracts.js';

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

// ── Schemas ──────────────────────────────────────────────────────────

export interface CatalogVersionEntry {
  manifest: string;       // R2 key, e.g. "manifests/clang-binji-2020.json"
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

const CatalogVersionEntrySchema = z.object({
  manifest: z.string().min(1),
  manifest_sha256: HexSha256Schema.optional(),
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

export function parseRuntimeCatalog(value: unknown): RuntimeCatalog {
  return RuntimeCatalogSchema.parse(value);
}

// ── L2 content addressing ────────────────────────────────────────────

/**
 * R2 key of the catalog whose bytes hash to `sha256`. bundle-runtime.mjs
 * writes the same key (catalogKey there); tests/unit/bundle-runtime-catalog-pin.mjs
 * holds the two to one spelling.
 */
export function catalogKey(sha256: string): string {
  return `catalog/sha256/${sha256}.json`;
}

/** Synthetic L2 cache-key host. Reserved-invalid TLD so keys can never
 *  collide with a real user request. Bumped to `-v2` when the keyspace
 *  moved from R2 keys to content addresses: every `v1` entry was written
 *  under a key its contents did not have to match, so none of them is
 *  trustworthy and all of them are abandoned rather than validated. */
const L2_NS = 'https://nimbus-runtime-cache-v2.invalid';

type L2Scope = 'catalog' | 'manifest' | 'blob';

/**
 * The address of an L2 entry: the SHA-256 of its own bytes. Holding the
 * parsed digest (rather than an R2 key plus a hopefully-matching digest
 * string) is what makes an unverifiable cache access impossible to write
 * — `l2Address` is the only way to obtain one, and the cache helpers
 * accept nothing else.
 */
interface L2Address {
  readonly scope: L2Scope;
  readonly sha256: string;
}

/**
 * Bytes that have been hashed and match their address. `l2Put` takes only
 * this, so unverified bytes cannot be written into the shared tier even
 * by a future edit that forgets to check.
 */
interface VerifiedBytes {
  readonly address: L2Address;
  readonly bytes: Uint8Array;
}

const HEX_SHA256 = /^[a-f0-9]{64}$/;

/**
 * Address an L2 entry by the digest of its contents.
 *
 * Returns null for anything unverifiable — a digest we were never given,
 * or one that is not a hex SHA-256. A null address takes the value out of
 * the shared cache entirely: it is read from R2 and not written back.
 */
function l2Address(scope: L2Scope, sha256: string | undefined): L2Address | null {
  if (!sha256) return null;
  const hex = sha256.toLowerCase();
  return HEX_SHA256.test(hex) ? { scope, sha256: hex } : null;
}

/** Pair bytes with their address if they hash to it; null otherwise. */
async function verifyBytes(address: L2Address, bytes: Uint8Array): Promise<VerifiedBytes | null> {
  return await sha256Hex(bytes) === address.sha256 ? { address, bytes } : null;
}

// ── Fetchers ─────────────────────────────────────────────────────────

/** What `nimbus install` says when the deployment does not name its catalog. */
export const CATALOG_PIN_MISSING =
  'NIMBUS_RUNTIME_CATALOG_SHA256 is not set on this Worker. It is the SHA-256 of the runtime ' +
  'catalog in the NIMBUS_RUNTIME_CACHE bucket: `nimbus runtime sync` prints it after filling the ' +
  'bucket; set it under "vars" in wrangler.jsonc and redeploy.';

/**
 * Fetch the catalog the deployment names (NIMBUS_RUNTIME_CATALOG_SHA256),
 * by its digest, and only if its bytes hash to it.
 */
export async function fetchCatalog(env: RuntimeCatalogEnv): Promise<RuntimeCatalog> {
  const address = l2Address('catalog', env.NIMBUS_RUNTIME_CATALOG_SHA256);
  if (!address) {
    throw new Error(env.NIMBUS_RUNTIME_CATALOG_SHA256
      ? `NIMBUS_RUNTIME_CATALOG_SHA256 is '${env.NIMBUS_RUNTIME_CATALOG_SHA256}', not a hex SHA-256. ${CATALOG_PIN_MISSING}`
      : CATALOG_PIN_MISSING);
  }

  const cached = await l2Get(address);
  if (cached) return parseRuntimeCatalog(parseJsonBytes(cached));

  const r2 = env.NIMBUS_RUNTIME_CACHE;
  if (!r2) {
    throw new Error('NIMBUS_RUNTIME_CACHE binding missing — catalog cannot be fetched');
  }
  const key = catalogKey(address.sha256);
  const obj = await r2.get(key);
  if (!obj) {
    throw new Error(`${key} is not in NIMBUS_RUNTIME_CACHE: NIMBUS_RUNTIME_CATALOG_SHA256 names a catalog this bucket does not hold`);
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const verified = await verifyBytes(address, bytes);
  if (!verified) {
    throw new Error(`${key} holds bytes whose SHA-256 is ${await sha256Hex(bytes)}, not ${address.sha256}: refusing an unverified catalog`);
  }
  await l2Put(verified, 'application/json');
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
export async function fetchManifest(
  env: RuntimeCatalogEnv,
  entry: CatalogVersionEntry,
): Promise<RuntimeManifest> {
  const address = l2Address('manifest', entry.manifest_sha256);

  if (address) {
    const cached = await l2Get(address);
    if (cached) return parseRuntimeManifest(parseJsonBytes(cached));
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
      throw new Error(
        `sha256 mismatch for manifest ${entry.manifest}: catalog expects ` +
          `${address.sha256}, R2 holds ${await sha256Hex(bytes)}`,
      );
    }
    await l2Put(verified, 'application/json');
  }

  return parseRuntimeManifest(parseJsonBytes(bytes));
}

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
export async function fetchBlob(
  env: RuntimeCatalogEnv,
  file: ManifestFile,
): Promise<ReadableStream<Uint8Array>> {
  const address = l2Address('blob', file.sha256);
  if (!address) {
    throw new Error(`manifest entry ${file.path} has no usable sha256 (${file.sha256})`);
  }

  const cached = l2Distrusted.has(address.sha256) ? null : await l2GetBody(address);
  if (cached) {
    return verifiedRead(address, cached, null, async (actual) => {
      l2Distrusted.add(address.sha256);
      await l2Evict(address);
      return `sha256 mismatch for blob ${file.content}: manifest expects ${address.sha256}, `
        + `the colo cache held ${actual} and was evicted`;
    });
  }

  const r2 = env.NIMBUS_RUNTIME_CACHE;
  if (!r2) {
    throw new Error('NIMBUS_RUNTIME_CACHE binding missing — blob cannot be fetched');
  }
  const obj = await r2.get(file.content);
  if (!obj) {
    throw new Error(`blob ${file.content} not in R2 — manifest references a missing blob`);
  }
  return verifiedRead(
    address,
    obj.body,
    l2FillWriter(address),
    (actual) => `sha256 mismatch for blob ${file.content}: manifest expects ${address.sha256}, R2 holds ${actual}`,
  );
}

/**
 * `body` as a stream that errors at its end, with a
 * {@link RuntimeBlobDigestMismatch}, rather than closing, unless it hashed to
 * `address`. It is read once. When `fill` is given, the same read feeds L2:
 * each piece reaches the cache before the consumer, and the cache entry is
 * closed only after the digest matched; a mismatch, a failed read or an
 * abandoned stream aborts it, and an aborted body stores nothing. The
 * cache's own pace bounds the pair, so neither side buffers what the other
 * lags by.
 */
function verifiedRead(
  address: L2Address,
  body: ReadableStream<Uint8Array>,
  fill: WritableStreamDefaultWriter<Uint8Array> | null,
  mismatch: (actual: string) => string | Promise<string>,
): ReadableStream<Uint8Array> {
  const pieces = blobPieces(body);
  const digest = sha256Incremental();
  const drop = (reason: unknown): void => {
    fill?.abort(reason).catch(() => {});
    fill = null;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await pieces.next();
        if (next.done) {
          const actual = await digest.hex();
          if (actual !== address.sha256) throw new RuntimeBlobDigestMismatch(await mismatch(actual));
          fill?.close().catch(() => {});
          controller.close();
          return;
        }
        await digest.update(next.value);
        if (fill) {
          try {
            await fill.ready;
            fill.write(next.value).catch(() => {});
          } catch (error) {
            drop(error);
          }
        }
        controller.enqueue(next.value);
      } catch (error) {
        drop(error);
        throw error;
      }
    },
    async cancel(reason) {
      drop(reason);
      await pieces.return(undefined);
    },
  }, { highWaterMark: 0 });
}

// ── RuntimeSource ────────────────────────────────────────────────────

export function runtimeAbiForCatalogName(name: string): RuntimePackageAbi {
  return NIMBUS_RUNTIME_ABIS[name] ?? NATIVE_UNSUPPORTED_ABI;
}

/**
 * The R2 catalog as a core `RuntimeSource` — the worker adapter half of the
 * install path, so a workspace composed inside this Worker resolves
 * `nimbus install <spec>` against the same bucket and digest chain the
 * session's installer always used. Aliases resolve the way the old
 * resolver did: `python` redirects to `cpython` unless a version pins it,
 * and any bin a runtime's default manifest declares resolves to that
 * runtime — except a superseded one, which never answers for a bin.
 */
export function runtimeCatalogSource(env: RuntimeCatalogEnv): RuntimeSource {
  return {
    async list() {
      const catalog = await fetchCatalog(env);
      return Object.entries(catalog.runtimes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => ({
          name,
          abi: runtimeAbiForCatalogName(name),
          defaultVersion: entry.default,
          // The publisher appends; the catalog's own order is publish order.
          versions: Object.entries(entry.versions)
            .map(([version, v]) => ({
              version,
              sizeBytes: v.size_bytes,
              license: v.license,
            })),
        }));
    },

    async resolve(spec) {
      const { name, versionOverride } = splitRuntimeSpec(spec);
      const catalog = await fetchCatalog(env);

      let resolved = catalogRuntimeNamed(catalog, name, versionOverride);
      if (resolved === null) {
        for await (const provider of catalogCommandProviders(env, catalog, versionOverride)) {
          if (runtimeEntrypoints(provider.manifest).some((ep) => ep.binName === name)) {
            resolved = provider.runtimeName;
            break;
          }
        }
      }
      if (resolved === null) return null;

      const entry = catalog.runtimes[resolved];
      const version = versionOverride ?? entry.default;
      const versionEntry = entry.versions[version];
      if (!versionEntry) {
        throw new Error(`'${resolved}@${version}' not in catalog`);
      }
      const manifest = await fetchManifest(env, versionEntry);
      const pkg: RuntimePackage = {
        manifest,
        readBlob: (file) => fetchBlob(env, file),
      };
      return pkg;
    },
  };
}

/**
 * The runtime a catalog name stands for. `python` is CPython now: a bare
 * name follows the supersession, an explicit `python@<version>` is a
 * deliberate request and bypasses it. Null when the catalog has neither.
 */
function catalogRuntimeNamed(catalog: RuntimeCatalog, name: string, versionOverride: string | null): string | null {
  const superseding = versionOverride === null ? SUPERSEDED_RUNTIMES[name] : undefined;
  if (superseding !== undefined && catalog.runtimes[superseding]) return superseding;
  return catalog.runtimes[name] ? name : null;
}

/**
 * The runtimes that answer for a command name, in catalog order, each with
 * its default version's manifest: bin-name aliasing is catalog-driven, so
 * any command a runtime provides resolves to that runtime. A superseded
 * runtime answers for none unless the request names a version: its runner
 * is no longer registered, and its successor declares the same commands.
 * A manifest that fails to load suppresses only its own runtime's aliases,
 * never the catalog's canonical names.
 */
async function* catalogCommandProviders(
  env: RuntimeCatalogEnv,
  catalog: RuntimeCatalog,
  versionOverride: string | null,
): AsyncGenerator<{ runtimeName: string; manifest: RuntimeManifest }> {
  for (const [runtimeName, entry] of Object.entries(catalog.runtimes)) {
    if (versionOverride === null
      && SUPERSEDED_RUNTIMES[runtimeName] !== undefined
      && catalog.runtimes[SUPERSEDED_RUNTIMES[runtimeName]]) continue;
    const versionEntry = entry.versions[entry.default];
    if (!versionEntry) continue;
    let manifest: RuntimeManifest;
    try {
      manifest = await fetchManifest(env, versionEntry);
    } catch {
      continue;
    }
    yield { runtimeName, manifest };
  }
}

/**
 * Every command a bare `nimbus install <command>` resolves, mapped to the
 * runtime it installs: the catalog's names first, then each runtime's
 * commands, exactly as runtimeCatalogSource.resolve picks them.
 */
export async function catalogCommandIndex(env: RuntimeCatalogEnv): Promise<Map<string, string>> {
  const catalog = await fetchCatalog(env);
  const index = new Map<string, string>();
  for (const name of Object.keys(catalog.runtimes)) {
    const runtimeName = catalogRuntimeNamed(catalog, name, null);
    if (runtimeName !== null) index.set(name, runtimeName);
  }
  for await (const { runtimeName, manifest } of catalogCommandProviders(env, catalog, null)) {
    for (const ep of runtimeEntrypoints(manifest)) {
      if (!index.has(ep.binName)) index.set(ep.binName, runtimeName);
    }
  }
  return index;
}

// ── L2 (caches.default) helpers ──────────────────────────────────────
//
// The only access this module has to `caches.default`. Both sides are
// digest-checked, so neither a poisoned entry nor a mis-keyed write can
// get past them.

type CacheGlobal = { caches?: { default?: Cache } };

/** Read the entry at `address`, or null on miss, on a stripped Cache API,
 *  or when what came back does not hash to the key it was found under. */
async function l2Get(address: L2Address): Promise<Uint8Array | null> {
  try {
    const caches = (globalThis as CacheGlobal).caches;
    if (!caches?.default) return null;
    const hit = await caches.default.match(new Request(l2Url(address)));
    if (!hit || !hit.ok) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    return await verifyBytes(address, bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** Write verified bytes under their own digest. Eternal-immutable: a
 *  content address cannot go stale, and new bytes land on a new key. */
async function l2Put(verified: VerifiedBytes, contentType: string): Promise<void> {
  try {
    const caches = (globalThis as CacheGlobal).caches;
    if (!caches?.default) return;
    const resp = new Response(verified.bytes, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
    await caches.default.put(new Request(l2Url(verified.address)), resp);
  } catch { /* best-effort */ }
}

/**
 * The body of the blob entry at `address`, or null on a miss or a stripped
 * Cache API. Unverified: served only through {@link verifiedRead}, whose
 * mismatch evicts it and sends later reads of that blob to R2. Hashing an entry before serving it would read every
 * blob from the cache twice, which was most of an install's time.
 */
async function l2GetBody(address: L2Address): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const caches = (globalThis as CacheGlobal).caches;
    if (!caches?.default) return null;
    const hit = await caches.default.match(new Request(l2Url(address)));
    return hit?.ok && hit.body ? hit.body : null;
  } catch {
    return null;
  }
}

/**
 * Blob digests whose colo-cache entry failed verification in this isolate.
 * Their reads go to R2 from then on: a purge lands some time after it is
 * asked for, and a shared cache can be poisoned again, so the installer's
 * second read of a failed blob must not depend on either.
 */
const l2Distrusted = new Set<string>();

/** Drop the entry at `address` from the colo cache for other isolates. */
async function l2Evict(address: L2Address): Promise<void> {
  try {
    await (globalThis as CacheGlobal).caches?.default?.delete(new Request(l2Url(address)));
  } catch { /* best-effort */ }
}

/** A writer whose bytes become the L2 entry at `address` when it closes;
 *  aborting it stores nothing. Null where there is no cache. */
function l2FillWriter(address: L2Address): WritableStreamDefaultWriter<Uint8Array> | null {
  try {
    const caches = (globalThis as CacheGlobal).caches;
    if (!caches?.default) return null;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const resp = new Response(readable, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
    caches.default.put(new Request(l2Url(address)), resp).catch(() => { /* best-effort */ });
    return writable.getWriter();
  } catch {
    return null;
  }
}

function l2Url(address: L2Address): string {
  return `${L2_NS}/${address.scope}/${address.sha256}`;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}
