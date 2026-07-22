/**
 * npm-tarball.ts — streaming tarball extraction (gunzip + tar).
 *
 * `extractTarball` / `extractTarballFromResponse` walk a gzipped tar stream
 * entry-by-entry, holding at most one file's bytes at a time. Used by the
 * install-batch facet (whose own 128 MiB envelope, not the supervisor's,
 * holds the bytes) and the ruby-gems runtime.
 *
 * The legacy supervisor-resident `fetchWaves` / `buildBatchPayload` and the
 * `buildCacheRestorePayload` fast path were removed — they ran in supervisor
 * heap and held tarball bytes long enough to OOM the DO on large installs.
 * The single batch-facet path (install-batch-facet.ts) supersedes them and
 * consults the shared L2/L3 tarball cache directly.
 */

import {
  streamTarEntries,
  readableStreamToAsyncIterable,
} from './tarball-stream.js';

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
 * small carry buffer.
 *
 * The returned Map is per-file Uint8Arrays. If the response has no body
 * (unusual but possible with some proxies), we fall back to `arrayBuffer()`
 * + `extractTarball` so we still make progress.
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
