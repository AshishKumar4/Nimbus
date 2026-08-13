/**
 * tarball.ts — a whole tarball, in memory, as a path→bytes map.
 *
 * The streaming primitives it walks with (`parseTarHeader`, `streamTarEntries`,
 * `readableStreamToAsyncIterable`) live in `./tarball-stream.ts` — a
 * dependency-free leaf, because `bundle-facet-workers.mjs` esbuilds that file
 * into a string the loader pool injects into dynamic workers, where an import
 * would not resolve.
 *
 * This half is for a caller that already holds the bytes: `gem install`, which
 * fetches a `.gem` (a tar holding a gzipped tar) and needs both layers open at
 * once. An installer streaming a tarball it is still downloading should drive
 * `streamTarEntries` itself and never hold the whole thing.
 */

import {
  streamTarEntries,
  readableStreamToAsyncIterable,
} from './tarball-stream.js';

/** Extract every regular file. Gzipped input is decompressed first. */
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
