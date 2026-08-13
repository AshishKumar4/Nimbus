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
/** Extract every regular file. Gzipped input is decompressed first. */
export declare function extractTarball(tarball: ArrayBuffer): Promise<Map<string, Uint8Array>>;
//# sourceMappingURL=tarball.d.ts.map