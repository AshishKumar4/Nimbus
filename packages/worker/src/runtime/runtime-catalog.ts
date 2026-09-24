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
import { sha256Hex, sha256HexOfStream, sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
import { RUNTIME_CATALOG_SHA256 } from '../runtime-catalog.generated.js';
import {
  HexSha256Schema,
  parseRuntimeManifest,
  type ManifestFile,
  type RuntimeManifest,
} from '@nimbus-sh/core/runtime/runtime-manifest.js';
import { runtimeEntrypoints } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import {
  blobPieces,
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

/** R2 key of the top-level catalog. */
const CATALOG_R2_KEY = 'catalog/v1.json';

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

/**
 * Fetch the top-level catalog, verified against the build-time pin.
 *
 * A pin that has drifted behind a fresh publish is not an error: R2 is the
 * trusted tier, so the catalog is served from it and simply not cached.
 * The condition is logged once per isolate because a silently disabled
 * cache is otherwise invisible.
 */
export async function fetchCatalog(env: RuntimeCatalogEnv): Promise<RuntimeCatalog> {
  const address = l2Address('catalog', RUNTIME_CATALOG_SHA256);

  if (address) {
    const cached = await l2Get(address);
    if (cached) return parseRuntimeCatalog(parseJsonBytes(cached));
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
  if (verified) await l2Put(verified, 'application/json');
  else await warnCatalogPinUnusable(bytes);

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
 * digest that same entry carries. A colo-cache entry is verified whole
 * before any of it is served, so a poisoned one is a miss. An R2 read errors
 * at its end, rather than closing, when its bytes do not hash to the digest.
 * The consumer hashes what it reads as well (the installer does, before it
 * commits a blob), so no step holds a blob whole.
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

  const cached = await l2GetStream(address);
  if (cached) return cached;

  const r2 = env.NIMBUS_RUNTIME_CACHE;
  if (!r2) {
    throw new Error('NIMBUS_RUNTIME_CACHE binding missing — blob cannot be fetched');
  }
  const obj = await r2.get(file.content);
  if (!obj) {
    throw new Error(`blob ${file.content} not in R2 — manifest references a missing blob`);
  }
  return readOnceFillingL2(
    address,
    obj.body,
    (actual) => `sha256 mismatch for blob ${file.content}: manifest expects ${address.sha256}, R2 holds ${actual}`,
  );
}

/**
 * `body` as a stream that errors at its end, rather than closing, unless it
 * hashed to `address`, feeding L2 from the same read. Each piece reaches the
 * cache before the consumer, and the cache entry is closed only after the
 * digest matched: a mismatch, a failed read or an abandoned stream aborts it,
 * and an aborted body stores nothing. The cache's own pace bounds the pair,
 * so neither side buffers what the other lags by.
 */
function readOnceFillingL2(
  address: L2Address,
  body: ReadableStream<Uint8Array>,
  mismatch: (actual: string) => string,
): ReadableStream<Uint8Array> {
  const pieces = blobPieces(body);
  const digest = sha256Incremental();
  let fill = l2FillWriter(address);
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
          if (actual !== address.sha256) throw new Error(mismatch(actual));
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

      // `python` is CPython now: a bare spec follows the supersession, an
      // explicit `python@<version>` is a deliberate request and bypasses it.
      const superseding = versionOverride === null ? SUPERSEDED_RUNTIMES[name] : undefined;
      const runtimeName =
        (superseding !== undefined && catalog.runtimes[superseding] ? superseding : null)
        ?? (catalog.runtimes[name] ? name : null);

      let resolved = runtimeName;
      if (resolved === null) {
        // Bin-name aliasing is catalog-driven: any command a runtime
        // provides resolves to that runtime. A superseded runtime does not
        // answer for a command name either — its runner is no longer
        // registered, and the successor declares the same commands further
        // down this same loop.
        for (const [candidate, entry] of Object.entries(catalog.runtimes)) {
          if (versionOverride === null
            && SUPERSEDED_RUNTIMES[candidate] !== undefined
            && catalog.runtimes[SUPERSEDED_RUNTIMES[candidate]]) continue;
          const versionEntry = entry.versions[entry.default];
          if (!versionEntry) continue;
          try {
            const manifest = await fetchManifest(env, versionEntry);
            if (runtimeEntrypoints(manifest).some((ep) => ep.binName === name)) {
              resolved = candidate;
              break;
            }
          } catch {
            // A bad manifest should not prevent canonical catalog names from
            // resolving; it only suppresses bin-name aliasing for that runtime.
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
 * The blob entry at `address` as a stream, or null on the same terms as
 * {@link l2Get}. The entry is hashed whole before any of it is served, so a
 * poisoned entry stays a miss; it is then served from a second read, so
 * neither read holds it. That read is not checked again here: its consumer
 * verifies what it reads, which also catches an entry swapped in between.
 */
async function l2GetStream(address: L2Address): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const caches = (globalThis as CacheGlobal).caches;
    if (!caches?.default) return null;
    const probe = await caches.default.match(new Request(l2Url(address)));
    if (!probe?.ok || !probe.body) return null;
    if (await sha256HexOfStream(probe.body) !== address.sha256) return null;
    const hit = await caches.default.match(new Request(l2Url(address)));
    return hit?.ok && hit.body ? hit.body : null;
  } catch {
    return null;
  }
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

let catalogPinWarned = false;

async function warnCatalogPinUnusable(bytes: Uint8Array): Promise<void> {
  if (catalogPinWarned) return;
  catalogPinWarned = true;
  console.warn(
    `[nimbus/runtime-catalog] RUNTIME_CATALOG_SHA256 is ${RUNTIME_CATALOG_SHA256 || '(unset)'} ` +
      `but ${CATALOG_R2_KEY} hashes to ${await sha256Hex(bytes)}. Serving from R2 and skipping ` +
      'the colo cache. Rerun `node scripts/bundle-runtime.mjs --pin-catalog`, commit ' +
      'src/runtime-catalog.generated.ts, and redeploy.',
  );
}
