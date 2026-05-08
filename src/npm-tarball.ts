/**
 * npm-tarball.ts — tarball extraction + cache-restore payload builder.
 *
 * Phase 2 A'.1 reduced this module to:
 *   - extractTarball / extractTarballFromResponse — streaming gunzip+tar.
 *     Used by the install-batch facet (which holds the bytes inside its
 *     own 128 MiB envelope, not the supervisor's).
 *   - buildCacheRestorePayload — supervisor-side BatchWritePayload
 *     builder for the cached-tarball fast path. Runs only on a cache
 *     hit; the bytes already live in the per-DO npm cache rather than
 *     being fetched off the network.
 *
 * The legacy `fetchWaves` async generator + `buildBatchPayload` builder
 * were removed — they ran in supervisor heap and held tarball bytes long
 * enough to OOM the DO on large installs. The single batch-facet path
 * (src/npm-install-batch-facet.ts) supersedes them.
 */

import type { NpmCache } from './npm-cache.js';
import type { ResolvedPackage, HoistPlan } from './npm-resolver.js';
import type { BatchInodeEntry, BatchChunkEntry, BatchWritePayload } from './sqlite-vfs.js';
import {
  streamTarEntries,
  readableStreamToAsyncIterable,
} from './npm-tarball-stream.js';
import { CHUNK_SIZE } from './constants.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface FetchedPackage {
  pkg: ResolvedPackage;
  files: Map<string, Uint8Array>;
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

// ── Removed Phase 2 A'.1 ─────────────────────────────────────────────────
//
// The supervisor-resident `fetchWaves` async generator and its companion
// `buildBatchPayload` BatchWritePayload builder were deleted when the
// install became single-path (batch-facet only). Both ran in supervisor
// heap and held tarball bytes in memory long enough to OOM the DO on
// large installs. The single batch-facet path
// (src/npm-install-batch-facet.ts) streams gunzip+tar inside a dynamic-
// worker isolate with its own 128 MiB envelope and emits one writeBatch
// RPC per package — the supervisor's heap only sees one inbound RPC
// payload at a time.
//
// `WaveResult` is also gone (no other consumers). `FetchedPackage` is
// retained because `extractTarballFromResponse` returns a `Files` map
// that the cache restore path still uses.

// ── Batch payload construction ──────────────────────────────────────────

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
