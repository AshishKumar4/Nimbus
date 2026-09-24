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
/** Below this many bytes the native call's overhead exceeds the JavaScript loop's work (workerd). */
const CRC_NATIVE_MIN_BYTES = 128;
const nativeCrc32 = (() => {
    try {
        const crc32 = globalThis.process?.getBuiltinModule?.('node:zlib')?.crc32;
        return typeof crc32 === 'function' ? crc32 : null;
    }
    catch {
        return null;
    }
})();
/** Eight 256-entry tables: table k maps a byte to its CRC after k further zero bytes. */
let crcTables = null;
function createCrcTables() {
    const table = new Uint32Array(256 * 8);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++)
            value = (value & 1) !== 0 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
        table[index] = value;
    }
    for (let index = 0; index < 256; index++) {
        let value = table[index];
        for (let k = 1; k < 8; k++) {
            value = table[value & 0xff] ^ (value >>> 8);
            table[k * 256 + index] = value;
        }
    }
    return table;
}
export function crc32(bytes, previous = 0) {
    if (nativeCrc32 !== null && bytes.length >= CRC_NATIVE_MIN_BYTES)
        return nativeCrc32(bytes, previous) >>> 0;
    const t = crcTables ??= createCrcTables();
    let value = ~previous;
    const length = bytes.length;
    const whole = length - (length & 7);
    let i = 0;
    for (; i < whole; i += 8) {
        const low = value ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
        const high = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
        value = t[1792 + (low & 0xff)] ^ t[1536 + ((low >>> 8) & 0xff)]
            ^ t[1280 + ((low >>> 16) & 0xff)] ^ t[1024 + (low >>> 24)]
            ^ t[768 + (high & 0xff)] ^ t[512 + ((high >>> 8) & 0xff)]
            ^ t[256 + ((high >>> 16) & 0xff)] ^ t[high >>> 24];
    }
    for (; i < length; i++)
        value = t[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
    return ~value >>> 0;
}
