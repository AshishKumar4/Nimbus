/**
 * CRC-32 (IEEE 802.3, the zip/gzip/PNG polynomial), the one implementation
 * every Nimbus caller uses: the W7 write-batch framing and zip archives.
 *
 * `crc32(bytes, previous)` has node:zlib's contract: `previous` is the
 * finished CRC of the bytes before these, so a checksum computed in pieces
 * equals the checksum of the whole.
 *
 * Measured 2026-09-24 (5k files x 2 KiB; 64 MiB in 1 MiB buffers):
 * node:zlib's crc32 is 5-40x faster than any JavaScript loop in bun, node and
 * workerd (compat 2026-04-01, nodejs_compat), but each call costs ~0.14 us in
 * workerd, so below 128 bytes the table loop wins there. It is reached through
 * `process.getBuiltinModule`, like core's incremental SHA-256, so this module
 * imports nothing and still loads where node:zlib is absent (a browser,
 * workerd without nodejs_compat). The JavaScript path is slicing-by-8: 2-3x
 * the byte-at-a-time table loop in bun and node, and level with it in workerd.
 */
export declare function crc32(bytes: Uint8Array, previous?: number): number;
//# sourceMappingURL=crc32.d.ts.map