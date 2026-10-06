/**
 * git/pack/idx.ts — pack index version 2 (Documentation/gitformat-pack.txt),
 * byte for byte what `git index-pack` writes for the same pack:
 *
 *   ff 74 4f 63, version 2
 *   fanout[256]          u32: objects whose first id byte is <= i
 *   ids[N]               20 bytes each, ascending
 *   crc32[N]             of each object's packed bytes, header included
 *   offset32[N]          offset, or 0x80000000 | index into offset64
 *   offset64[M]          u64, for every offset past 0x7fffffff, in id order
 *   pack checksum, then the SHA-1 of everything above
 *
 * Entries travel as fixed records (ENTRY_BYTES): id, u64 offset, u32 crc.
 */
import { createHash } from 'node:crypto';
import { OID_BYTES, PackFormatError, compareOids } from './format.js';
export const IDX_V2_SIGNATURE = Uint8Array.of(0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2);
export const IDX_HEADER_BYTES = IDX_V2_SIGNATURE.byteLength + 256 * 4;
export const ENTRY_BYTES = OID_BYTES + 8 + 4;
const OFFSET32_LIMIT = 0x7fffffff;
export function idxLayout(count) {
    const ids = IDX_HEADER_BYTES;
    const crcs = ids + count * OID_BYTES;
    const offsets32 = crcs + count * 4;
    return { count, ids, crcs, offsets32, offsets64: offsets32 + count * 4 };
}
/** The fanout of an idx's first IDX_HEADER_BYTES. */
export function parseIdxHeader(bytes) {
    if (bytes.byteLength < IDX_HEADER_BYTES)
        throw new PackFormatError('idx header is truncated');
    for (let i = 0; i < IDX_V2_SIGNATURE.byteLength; i++) {
        if (bytes[i] !== IDX_V2_SIGNATURE[i])
            throw new PackFormatError('not a version 2 pack index');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, IDX_HEADER_BYTES);
    const fanout = new Uint32Array(256);
    let previous = 0;
    for (let i = 0; i < 256; i++) {
        fanout[i] = view.getUint32(IDX_V2_SIGNATURE.byteLength + i * 4);
        if (fanout[i] < previous)
            throw new PackFormatError('idx fanout is not monotonic');
        previous = fanout[i];
    }
    return fanout;
}
export function writeEntry(records, index, oid, oidAt, offset, crc) {
    const at = index * ENTRY_BYTES;
    for (let i = 0; i < OID_BYTES; i++)
        records[at + i] = oid[oidAt + i];
    const high = Math.floor(offset / 0x100000000);
    const low = offset >>> 0;
    let p = at + OID_BYTES;
    records[p++] = high >>> 24;
    records[p++] = (high >>> 16) & 0xff;
    records[p++] = (high >>> 8) & 0xff;
    records[p++] = high & 0xff;
    records[p++] = low >>> 24;
    records[p++] = (low >>> 16) & 0xff;
    records[p++] = (low >>> 8) & 0xff;
    records[p++] = low & 0xff;
    records[p++] = crc >>> 24;
    records[p++] = (crc >>> 16) & 0xff;
    records[p++] = (crc >>> 8) & 0xff;
    records[p] = crc & 0xff;
}
export function entryOffset(records, index) {
    const view = new DataView(records.buffer, records.byteOffset + index * ENTRY_BYTES + OID_BYTES, 8);
    return view.getUint32(0) * 0x100000000 + view.getUint32(4);
}
export function entryCrc(records, index) {
    return new DataView(records.buffer, records.byteOffset + index * ENTRY_BYTES + OID_BYTES + 8, 4).getUint32(0);
}
/** Records in idx order: ascending id, then ascending offset for a repeated id. */
export function sortEntries(records) {
    const count = records.byteLength / ENTRY_BYTES;
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++)
        order[i] = i;
    order.sort((a, b) => compareOids(records, a * ENTRY_BYTES, records, b * ENTRY_BYTES) ||
        entryOffset(records, a) - entryOffset(records, b));
    const sorted = new Uint8Array(records.byteLength);
    for (let i = 0; i < count; i++) {
        sorted.set(records.subarray(order[i] * ENTRY_BYTES, (order[i] + 1) * ENTRY_BYTES), i * ENTRY_BYTES);
    }
    return sorted;
}
/**
 * The idx, as a sequence of pieces, for `count` entries that `sweep` yields in
 * idx order (each yield a whole number of records). The tables are columns of
 * the records, so the entries are swept once per table and never held whole.
 */
export async function* encodeIdxV2(count, packChecksum, sweep) {
    const hash = createHash('sha1');
    const emit = (bytes) => {
        hash.update(bytes);
        return bytes;
    };
    const header = new Uint8Array(IDX_HEADER_BYTES);
    header.set(IDX_V2_SIGNATURE);
    const counts = new Uint32Array(256);
    let seen = 0;
    for await (const records of sweep()) {
        for (let at = 0; at < records.byteLength; at += ENTRY_BYTES)
            counts[records[at]]++;
        seen += records.byteLength / ENTRY_BYTES;
    }
    if (seen !== count)
        throw new PackFormatError('idx expected ' + count + ' entries, swept ' + seen);
    const headerView = new DataView(header.buffer);
    let running = 0;
    for (let i = 0; i < 256; i++) {
        running += counts[i];
        headerView.setUint32(IDX_V2_SIGNATURE.byteLength + i * 4, running);
    }
    yield emit(header);
    for await (const records of sweep()) {
        const ids = new Uint8Array((records.byteLength / ENTRY_BYTES) * OID_BYTES);
        for (let i = 0; i * ENTRY_BYTES < records.byteLength; i++) {
            ids.set(records.subarray(i * ENTRY_BYTES, i * ENTRY_BYTES + OID_BYTES), i * OID_BYTES);
        }
        yield emit(ids);
    }
    for await (const records of sweep()) {
        const n = records.byteLength / ENTRY_BYTES;
        const crcs = new Uint8Array(n * 4);
        const view = new DataView(crcs.buffer);
        for (let i = 0; i < n; i++)
            view.setUint32(i * 4, entryCrc(records, i));
        yield emit(crcs);
    }
    let large = 0;
    for await (const records of sweep()) {
        const n = records.byteLength / ENTRY_BYTES;
        const offsets = new Uint8Array(n * 4);
        const view = new DataView(offsets.buffer);
        for (let i = 0; i < n; i++) {
            const offset = entryOffset(records, i);
            view.setUint32(i * 4, offset > OFFSET32_LIMIT ? (0x80000000 | large++) >>> 0 : offset);
        }
        yield emit(offsets);
    }
    if (large > 0) {
        for await (const records of sweep()) {
            const n = records.byteLength / ENTRY_BYTES;
            const wide = [];
            for (let i = 0; i < n; i++) {
                const offset = entryOffset(records, i);
                if (offset > OFFSET32_LIMIT)
                    wide.push(offset);
            }
            const bytes = new Uint8Array(wide.length * 8);
            const view = new DataView(bytes.buffer);
            wide.forEach((offset, i) => {
                view.setUint32(i * 8, Math.floor(offset / 0x100000000));
                view.setUint32(i * 8 + 4, offset >>> 0);
            });
            yield emit(bytes);
        }
    }
    yield emit(packChecksum.slice());
    yield hash.digest();
}
const RIDX_SIGNATURE = Uint8Array.of(0x52, 0x49, 0x44, 0x58, 0, 0, 0, 1, 0, 0, 0, 1);
/**
 * The pack's reverse index (gitformat-pack.txt "pack-*.rev"), byte for byte
 * what `git index-pack --rev-index` writes: 'RIDX', version 1, SHA-1, then
 * each object's idx position in pack-offset order, the pack checksum and
 * the SHA-1 of everything above. `records` are in idx order. git reads it
 * instead of building the same table, 16 bytes an object, in memory.
 */
export function encodeRev(records, packChecksum) {
    const count = records.byteLength / ENTRY_BYTES;
    // Offset and position in one key: a native numeric sort, no comparator.
    const keys = new BigUint64Array(count);
    for (let i = 0; i < count; i++)
        keys[i] = (BigInt(entryOffset(records, i)) << 32n) | BigInt(i);
    keys.sort();
    const out = new Uint8Array(RIDX_SIGNATURE.byteLength + count * 4 + 2 * OID_BYTES);
    out.set(RIDX_SIGNATURE);
    const view = new DataView(out.buffer);
    for (let i = 0; i < count; i++)
        view.setUint32(RIDX_SIGNATURE.byteLength + i * 4, Number(keys[i] & 0xffffffffn));
    const trailer = RIDX_SIGNATURE.byteLength + count * 4;
    out.set(packChecksum, trailer);
    out.set(createHash('sha1').update(out.subarray(0, trailer + OID_BYTES)).digest(), trailer + OID_BYTES);
    return out;
}
