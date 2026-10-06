/**
 * git/pack/reader.ts — objects out of one pack, by range.
 *
 * Every read is a generator that yields the byte ranges it needs and is
 * handed their bytes back, so one implementation serves two kinds of
 * storage: driven synchronously over the session's SQLite (readRange is a
 * local call there) or asynchronously over a facet's range RPC, possibly with
 * many reads batched into one round trip. Nothing here holds a pack: an
 * object costs its entry's bytes, the deltas of its chain, and the
 * delta-base cache's budget.
 */
import { inflateSync } from 'node:zlib';
import { MAX_OBJECT_HEADER_BYTES, OBJ_OFS_DELTA, OBJ_REF_DELTA, PackFormatError, applyDelta, deflateBound, inflateChunkSize, deltaSizes, oidToHex, parseObjectHeader, typeName, } from './format.js';
/** A ref-delta's base is not in this pack and nothing else supplied it. */
export class MissingBaseError extends Error {
    baseOid;
    constructor(baseOid) {
        super('pack: delta base ' + oidToHex(baseOid) + ' is missing');
        this.baseOid = baseOid;
        this.name = 'MissingBaseError';
    }
}
/**
 * A first read this long holds a typical entry whole; a longer one is read
 * again at its deflate bound. Pages of the page-cached drivers are larger.
 */
export const ENTRY_PROBE_BYTES = 16 * 1024;
if (ENTRY_PROBE_BYTES <= MAX_OBJECT_HEADER_BYTES)
    throw new Error('entry probe must hold any object header');
export class PackObjectResolver {
    options;
    dataEnd;
    constructor(options) {
        this.options = options;
        this.dataEnd = options.dataEnd;
    }
    /** The entry at `offset`: one probe, and one more read only when its stream is longer. */
    *entryAt(offset) {
        if (offset < 0 || offset >= this.dataEnd)
            throw new PackFormatError('object offset ' + offset + ' is outside the pack');
        const file = this.options.file;
        let bytes = yield { file, offset, length: Math.min(ENTRY_PROBE_BYTES, this.dataEnd - offset) };
        // The probe is longer than any header, so only the pack's end can cut one short.
        const header = parseObjectHeader(bytes, 0, offset);
        if (header === null)
            throw new PackFormatError('object header at ' + offset + ' runs past the pack');
        const bound = Math.min(header.headerBytes + deflateBound(header.size), this.dataEnd - offset);
        if (bytes.byteLength < bound)
            bytes = yield { file, offset, length: bound };
        let inflated;
        try {
            inflated = inflateSync(bytes.subarray(header.headerBytes), { info: true, chunkSize: inflateChunkSize(header.size) });
        }
        catch (error) {
            throw new PackFormatError('object at ' + offset + ' does not inflate: ' + (error instanceof Error ? error.message : String(error)));
        }
        if (inflated.buffer.byteLength !== header.size) {
            throw new PackFormatError('object at ' + offset + ' inflates to ' + inflated.buffer.byteLength + ' bytes, header says ' + header.size);
        }
        return {
            header,
            // A plain view: zlib's Buffer would make every later slice() a view too.
            payload: new Uint8Array(inflated.buffer.buffer, inflated.buffer.byteOffset, inflated.buffer.byteLength),
            packed: bytes.subarray(0, header.headerBytes + inflated.engine.bytesWritten),
        };
    }
    /**
     * The object at `offset`, its delta chain applied, cached at every link.
     * The walk to the base reads only headers; the deltas are then applied
     * outward, each inflated as it is applied, so a long chain of large
     * deltas holds one of them, never all.
     */
    *objectAt(offset) {
        const chain = [];
        let base = null;
        let at = offset;
        while (base === null) {
            const cached = this.options.cache.get(at);
            if (cached !== undefined) {
                base = cached;
                break;
            }
            const header = yield* this.headerOf(at);
            if (header.type === OBJ_OFS_DELTA) {
                chain.push(at);
                at = header.baseOffset;
            }
            else if (header.type === OBJ_REF_DELTA) {
                chain.push(at);
                const found = yield* this.options.refBase(header.baseOid);
                if ('object' in found)
                    base = found.object;
                else
                    at = found.offset;
            }
            else {
                const entry = yield* this.entryAt(at);
                base = { type: typeName(entry.header.type), data: entry.payload };
                this.remember(at, base);
            }
            if (chain.length > 10_000)
                throw new PackFormatError('delta chain at ' + offset + ' is longer than 10000');
        }
        for (let i = chain.length - 1; i >= 0; i--) {
            const delta = yield* this.entryAt(chain[i]);
            base = { type: base.type, data: applyDelta(base.data, delta.payload) };
            this.remember(chain[i], base);
        }
        return base;
    }
    /** The header of the entry at `offset`, its payload unread. */
    *headerOf(offset) {
        if (offset < 0 || offset >= this.dataEnd)
            throw new PackFormatError('object offset ' + offset + ' is outside the pack');
        const bytes = yield { file: this.options.file, offset, length: Math.min(MAX_OBJECT_HEADER_BYTES, this.dataEnd - offset) };
        const header = parseObjectHeader(bytes, 0, offset);
        if (header === null)
            throw new PackFormatError('object header at ' + offset + ' runs past the pack');
        return header;
    }
    /** An object's type and size, inflating no more than each delta's leading sizes. */
    *headerAt(offset) {
        let size = null;
        let at = offset;
        for (let depth = 0; depth <= 10_000; depth++) {
            const cached = this.options.cache.get(at);
            if (cached !== undefined)
                return { type: cached.type, size: size ?? cached.data.byteLength };
            const entry = yield* this.entryAt(at);
            if (entry.header.type !== OBJ_OFS_DELTA && entry.header.type !== OBJ_REF_DELTA) {
                return { type: typeName(entry.header.type), size: size ?? entry.header.size };
            }
            size ??= deltaSizes(entry.payload).resultSize;
            if (entry.header.type === OBJ_OFS_DELTA) {
                at = entry.header.baseOffset;
                continue;
            }
            const found = yield* this.options.refBase(entry.header.baseOid);
            if ('object' in found)
                return { type: found.object.type, size };
            at = found.offset;
        }
        throw new PackFormatError('delta chain at ' + offset + ' is longer than 10000');
    }
    remember(offset, object) {
        this.options.cache.set(offset, { ...object, byteLength: object.data.byteLength });
    }
}
/** Run a read to completion over synchronous storage. */
export function runSync(read, fetch) {
    let step = read.next();
    while (!step.done)
        step = read.next(fetch(step.value));
    return step.value;
}
/** Run a read to completion over asynchronous storage. */
export async function runAsync(read, fetch) {
    let step = read.next();
    while (!step.done)
        step = read.next(await fetch(step.value));
    return step.value;
}
