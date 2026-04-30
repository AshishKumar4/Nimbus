/**
 * npm-tarball.ts — Tarball fetching, extraction, and cache integration for Nimbus npm.
 *
 * Features:
 *   - Separate fetch + extract for composability
 *   - Wave-based concurrent fetching with pLimit concurrency control
 *   - Integrates with NpmCache for per-package file caching
 *   - Produces BatchWritePayload for atomic VFS writes
 *   - **Streaming extraction** (H1): gunzip + tar parsing happen as bytes
 *     arrive from the fetch Response body, so we never materialize the full
 *     decompressed tarball as one Uint8Array. Worst-case transient heap per
 *     package is ~1 file's bytes instead of ~3× the compressed tarball size.
 *     STABILITY-AUDIT / WORKERD-CRASH H1.
 */

import type { NpmCache } from './npm-cache.js';
import { pLimit, type ResolvedPackage, type HoistPlan, type FetchFn } from './npm-resolver.js';
import type { BatchInodeEntry, BatchChunkEntry, BatchWritePayload } from './sqlite-vfs.js';
import {
  streamTarEntries,
  readableStreamToAsyncIterable,
} from './npm-tarball-stream.js';
import { retryableFetch, DEFAULT_RETRIES } from './retry.js';
import { CHUNK_SIZE } from './constants.js';

/** Max concurrent tarball downloads. Bounded to avoid port exhaustion. */
const FETCH_CONCURRENCY = 5;
/** Timeout for tarball fetches (ms). */
const TARBALL_TIMEOUT_MS = 30_000;

// ── Types ───────────────────────────────────────────────────────────────

export interface FetchedPackage {
  pkg: ResolvedPackage;
  files: Map<string, Uint8Array>;
}

export interface WaveResult {
  fetched: FetchedPackage[];
  failed: string[];
}

// ── Tarball extraction ──────────────────────────────────────────────────
//
// The streaming primitives (parseTarHeader, streamTarEntries,
// readableStreamToAsyncIterable, MAX_FILE_BYTES) live in
// ./npm-tarball-stream.ts — a dependency-free leaf so
// scripts/bundle-facet-workers.mjs can esbuild it into a string the facet
// pool injects into dynamic workers. Import them directly from that module.

/**
 * Streaming extractor driven by a `Response` body.
 *
 * Pipes `resp.body` through `DecompressionStream('gzip')` (npm tarballs are
 * always gzipped) and walks the tar stream entry-by-entry. Never buffers the
 * full decompressed tarball — peak transient heap is one file's bytes plus a
 * small carry buffer. This is the path used by live installs; the cache
 * restore path (in-memory bytes from SQLite) still uses `extractTarball`.
 *
 * The returned Map is per-file Uint8Arrays, same shape as the legacy
 * extractor so downstream `putTarballFiles` / `buildBatchPayload` don't care.
 * If the response has no body (unusual but possible with some proxies), we
 * fall back to `arrayBuffer()` + `extractTarball` so we still make progress.
 */
export async function extractTarballFromResponse(
  resp: Response,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  const body = resp.body;
  if (!body) {
    // Fallback: no streamable body (shouldn't happen, but handle it).
    const buf = await resp.arrayBuffer();
    return extractTarball(buf);
  }

  // Time-bound the whole extraction to detect hung gunzip streams.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const decompressed = body.pipeThrough(new DecompressionStream('gzip'));
    const source = readableStreamToAsyncIterable(decompressed);
    for await (const entry of streamTarEntries(source)) {
      if (controller.signal.aborted) throw new Error('tarball extract timeout');
      files.set(entry.name, entry.data);
    }
  } catch (e: any) {
    // On any error, just return whatever we managed to extract. Callers
    // treat `files.size === 0` as a failed fetch and mark the package failed.
    // If partial data is present (some files succeeded before the stream
    // broke), we propagate it; the installer will re-fetch on mismatch.
    if (files.size === 0) {
      clearTimeout(timer);
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }

  return files;
}

/**
 * Legacy buffered extractor. Kept for code paths that receive a fully-buffered
 * tarball (e.g. the tarball cache restore path, which already stores bytes in
 * SQLite as Uint8Arrays). New install paths use `streamTarEntries` instead.
 */
export async function extractTarball(
  tarball: ArrayBuffer,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const raw = new Uint8Array(tarball);

  // Adapter: wrap the single buffer as an async iterable. If gzipped, pipe
  // through DecompressionStream so the streaming parser still sees tar bytes.
  let source: AsyncIterable<Uint8Array>;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    const rs = new Blob([tarball]).stream().pipeThrough(new DecompressionStream('gzip'));
    source = readableStreamToAsyncIterable(rs);
  } else {
    source = (async function* () { yield raw; })();
  }

  try {
    for await (const entry of streamTarEntries(source)) {
      files.set(entry.name, entry.data);
    }
  } catch {
    return files;
  }
  return files;
}

// ── Wave-based fetching ─────────────────────────────────────────────────

/**
 * Fetch tarballs in waves of `waveSize` packages.
 * Each wave is fully fetched + extracted before yielding its results.
 * This bounds memory usage (only one wave's tarballs in memory at once).
 */
export async function* fetchWaves(
  packages: ResolvedPackage[],
  cache: NpmCache,
  ctx: DurableObjectState | undefined,
  waveSize: number = 15,
  onProgress?: (msg: string) => void,
  fetchFn?: FetchFn,
): AsyncGenerator<WaveResult, void, undefined> {
  for (let waveStart = 0; waveStart < packages.length; waveStart += waveSize) {
    const wave = packages.slice(waveStart, waveStart + waveSize);
    const waveNum = Math.floor(waveStart / waveSize) + 1;
    const totalWaves = Math.ceil(packages.length / waveSize);
    onProgress?.(`Fetching wave ${waveNum}/${totalWaves} (${wave.length} packages)...`);

    const fetched: FetchedPackage[] = [];
    const failed: string[] = [];
    const limit = pLimit(FETCH_CONCURRENCY);

    // Concurrent fetch within the wave, bounded by pLimit
    await Promise.all(
      wave.map((pkg) => limit(async () => {
        // Check tarball cache first
        if (cache.hasTarballCache(pkg.name, pkg.version)) {
          onProgress?.(`  cached ${pkg.name}@${pkg.version}`);
          // Don't fetch — will be restored from cache in the write phase
          return;
        }

        if (!pkg.tarballUrl) {
          failed.push(`${pkg.name}@${pkg.version}`);
          return;
        }

        onProgress?.(`  fetching ${pkg.name}@${pkg.version}...`);
        try {
          // retryableFetch: 3 retries on 5xx/network errors with
          // jittered exponential backoff, per-attempt timeout equal to
          // the prior single-attempt budget (TARBALL_TIMEOUT_MS) so a
          // slow failure doesn't consume the whole retry window.
          // `fetchFn` (proxy) is forwarded; defaults to global fetch.
          const resp = await retryableFetch(pkg.tarballUrl, undefined, {
            retries: DEFAULT_RETRIES,
            name: `${pkg.name}@${pkg.version}`,
            fetchImpl: fetchFn,
            perAttemptTimeoutMs: TARBALL_TIMEOUT_MS,
            onRetry: (attempt, total, delayMs, reason) => {
              onProgress?.(
                `  ${pkg.name}@${pkg.version}: retry ${attempt}/${total} after ${delayMs}ms (${reason})`,
              );
            },
          });
          // Dispose the (possibly RPC-backed) Response stub after we've
          // drained its body via extractTarballFromResponse. See the
          // matching comment in npm-resolver.ts — without this, stubs
          // accumulate within the install's event-handler context and
          // trip workerd's "RPC result was not disposed" warning which
          // precedes the queueState != ACTIVE fatal.
          try {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const files = await extractTarballFromResponse(resp);

            if (files.size === 0) {
              failed.push(`${pkg.name}@${pkg.version}`);
              return;
            }

            // Store in tarball cache for future installs (non-fatal)
            try {
              cache.putTarballFiles(pkg.name, pkg.version, files, ctx);
            } catch (cacheErr: any) {
              console.error(`[npm-tarball] cache write failed for ${pkg.name}@${pkg.version}:`, cacheErr?.message);
            }

            fetched.push({ pkg, files });
          } finally {
            // Dispose the RPC stub once body is drained. Symbol.dispose
            // is ES2023; tsconfig targets ES2022 so we any-cast. On
            // non-RPC Response objects the lookup yields undefined and
            // the branch is skipped.
            const disposerKey = (Symbol as any).dispose;
            const disposer = disposerKey ? (resp as any)?.[disposerKey] : undefined;
            if (typeof disposer === 'function') {
              try { disposer.call(resp); } catch { /* best-effort */ }
            }
          }
        } catch (e: any) {
          onProgress?.(`  FAILED ${pkg.name}@${pkg.version}: ${e?.message}`);
          failed.push(`${pkg.name}@${pkg.version}`);
        }
      })),
    );

    yield { fetched, failed };
  }
}

// ── Batch payload construction ──────────────────────────────────────────

/**
 * Build a BatchWritePayload from fetched packages.
 * Computes all inodes (dirs + files) and chunks for a single wave.
 */
export function buildBatchPayload(
  packages: FetchedPackage[],
  hoistPlan: HoistPlan,
  nodeModulesDir: string,
): BatchWritePayload {
  const inodes: BatchInodeEntry[] = [];
  const chunks: BatchChunkEntry[] = [];
  const dirs = new Set<string>();
  const mtime = Date.now();

  for (const { pkg, files } of packages) {
    // Determine install path from hoist plan
    const pkgDir = hoistPlan.root.has(pkg.name)
      ? nodeModulesDir + '/' + pkg.name
      : nodeModulesDir + '/' + pkg.name; // nested not yet implemented

    // Add package directory itself
    dirs.add(pkgDir);

    for (const [relPath, data] of files) {
      const filePath = pkgDir + '/' + relPath;

      // Collect all parent directories
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }

      // File inode
      const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
      inodes.push({
        path: filePath,
        parentPath: parentOf(filePath),
        isDir: false,
        size: data.length,
        mtime,
        mode: 0o644,
        chunkCount,
      });

      // File chunks
      if (data.length <= CHUNK_SIZE) {
        if (data.length > 0) {
          chunks.push({ path: filePath, chunkId: 0, data });
        }
      } else {
        for (let c = 0; c < chunkCount; c++) {
          chunks.push({
            path: filePath,
            chunkId: c,
            data: data.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE),
          });
        }
      }
    }
  }

  // Add directory inodes
  for (const dir of dirs) {
    inodes.push({
      path: dir,
      parentPath: parentOf(dir),
      isDir: true,
      size: 0,
      mtime,
      mode: 0o755,
      chunkCount: 0,
    });
  }

  return { inodes, chunks };
}

/**
 * Build a BatchWritePayload from the tarball cache (for packages that were
 * already cached — no fetch needed).
 */
export function buildCacheRestorePayload(
  packages: ResolvedPackage[],
  hoistPlan: HoistPlan,
  nodeModulesDir: string,
  cache: NpmCache,
): BatchWritePayload {
  const inodes: BatchInodeEntry[] = [];
  const chunks: BatchChunkEntry[] = [];
  const dirs = new Set<string>();
  const mtime = Date.now();

  for (const pkg of packages) {
    const files = cache.getTarballFiles(pkg.name, pkg.version);
    if (files.length === 0) continue;

    const pkgDir = hoistPlan.root.has(pkg.name)
      ? nodeModulesDir + '/' + pkg.name
      : nodeModulesDir + '/' + pkg.name;

    dirs.add(pkgDir);

    for (const file of files) {
      const filePath = pkgDir + '/' + file.relPath;

      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }

      const chunkCount = file.data.length === 0 ? 0 : Math.ceil(file.data.length / CHUNK_SIZE);
      inodes.push({
        path: filePath,
        parentPath: parentOf(filePath),
        isDir: false,
        size: file.data.length,
        mtime,
        mode: 0o644,
        chunkCount,
      });

      if (file.data.length <= CHUNK_SIZE) {
        if (file.data.length > 0) {
          chunks.push({ path: filePath, chunkId: 0, data: file.data });
        }
      } else {
        for (let c = 0; c < chunkCount; c++) {
          chunks.push({
            path: filePath,
            chunkId: c,
            data: file.data.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE),
          });
        }
      }
    }
  }

  for (const dir of dirs) {
    inodes.push({
      path: dir,
      parentPath: parentOf(dir),
      isDir: true,
      size: 0,
      mtime,
      mode: 0o755,
      chunkCount: 0,
    });
  }

  return { inodes, chunks };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parentOf(path: string): string {
  return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
}
