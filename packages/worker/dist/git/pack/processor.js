/**
 * git/pack/processor.ts — one pass over a pack as its bytes arrive.
 *
 * Each entry, once its zlib stream is whole in the buffer, is inflated
 * (native zlib), its CRC taken, its delta resolved against the base cache,
 * its id hashed, its raw bytes passed on to be stored, and the resolved
 * object handed to the caller (who writes blobs into the worktree). Nothing
 * reads the pack back except a delta whose base has left the cache, and then
 * only that base's chain.
 *
 * Work is counted in units calibrated against the facet's CPU limit (see
 * WORK_UNIT_*). Past the budget the processor stops decoding and only stores
 * and hashes the rest of the stream, which needs no parsing: the trailer is
 * its last 20 bytes. `run` then reports where decoding stopped, and a later
 * invocation continues from the stored pack (`resume`).
 */
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { ByteLru } from './byte-lru.js';
import { OBJ_OFS_DELTA, OBJ_REF_DELTA, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, PackFormatError, applyDelta, deflateBound, inflateChunkSize, encodeObjectHeader, encodePackHeader, objectIdPrefix, oidFromHex, oidToHex, parseObjectHeader, parsePackHeader, typeCode, typeName, } from './format.js';
import { ENTRY_BYTES, entryOffset, sortEntries, writeEntry } from './idx.js';
import { MissingBaseError, PackObjectResolver, runAsync, } from './reader.js';
/**
 * Work units. One unit is the CPU of SHA-1 over one byte in bulk; each other
 * step is weighed against it.
 *
 * The limit: a Dynamic Worker LOADER.load()ed from the session DO, as this
 * facet is, with no load-level limits, runs ~30 s of CPU per invocation.
 * Measured 2026-10-05 on a throwaway: SHA-1 over 16 MiB units was killed with
 * "Worker exceeded CPU time limit" after 3,338 units, 32.2 s wall, so bulk
 * SHA-1 runs at ~1.8 GB/s there. WORK_BUDGET_UNITS is a third of the limit:
 * 10 s x 1.8e9 units/s = 18e9.
 *
 * The weights: each step timed alone in workerd 1.20260926 over the
 * TypeScript depth-1 pack (65,387 objects, 37 MB), three runs, relative to
 * bulk SHA-1 timed in the same run (0.36-0.45 ns/byte locally):
 *   inflate, per output byte   7.6-11.4  -> 8
 *   object SHA-1, per byte     2.6-4.1   -> 3   (per-call overhead on small objects)
 *   delta apply, per out byte  5.7-9.9   -> 8
 *   per object, the rest       1k-23k    -> 10,000 (~4 us; parse, crc, cache, emit)
 * With these the whole pass came to 3.35e9 units, predicting 1.2-1.5 s; it
 * measured 1.33-1.65 s.
 */
export const WORK_UNIT_PACK_HASH_BYTE = 1;
export const WORK_UNIT_OBJECT_HASH_BYTE = 3;
export const WORK_UNIT_INFLATE_BYTE = 8;
export const WORK_UNIT_DELTA_BYTE = 8;
export const WORK_UNIT_OBJECT = 10_000;
export const WORK_BUDGET_UNITS = 18_000_000_000;
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const FIRST_INFLATE_ATTEMPT_BYTES = 64 * 1024;
/** Stored bytes go out in pieces of this size: the VFS appends one in place below 512 KiB. */
const APPEND_PIECE_BYTES = 512 * 1024 - 64 * 1024;
/**
 * Stored bytes kept readable for base lookups, beyond what the cache holds:
 * a base evicted from the cache is re-inflated from these before any read of
 * the store. Packed bytes are several times denser than resolved ones.
 * Measured on react's full history in self-contained batches (8 MiB cache):
 * 39,950 base reads reach further back than 8 MiB, 9,620 past 16 MiB.
 */
const DEFAULT_RECENT_BYTES = 2 * 1024 * 1024;
/** A continuation reads the stored pack ahead in windows this long. */
const READ_AHEAD_BYTES = 8 * 1024 * 1024;
/** A growable byte buffer whose front is consumed. */
const INITIAL_STREAM_BUFFER_BYTES = 1024 * 1024;
const SHRINK_ABOVE_BYTES = 4 * 1024 * 1024;
class StreamBuffer {
    bytes = new Uint8Array(INITIAL_STREAM_BUFFER_BYTES);
    start = 0;
    end = 0;
    get length() {
        return this.end - this.start;
    }
    push(chunk) {
        if (this.end + chunk.byteLength > this.bytes.byteLength) {
            const live = this.end - this.start;
            const needed = live + chunk.byteLength;
            if (needed <= this.bytes.byteLength / 2) {
                this.bytes.copyWithin(0, this.start, this.end);
            }
            else {
                const grown = new Uint8Array(Math.max(needed * 2, this.bytes.byteLength));
                grown.set(this.bytes.subarray(this.start, this.end));
                this.bytes = grown;
            }
            this.start = 0;
            this.end = live;
        }
        this.bytes.set(chunk, this.end);
        this.end += chunk.byteLength;
    }
    view(from = 0, to = this.length) {
        return this.bytes.subarray(this.start + from, this.start + to);
    }
    consume(count) {
        this.start += count;
        // One large entry grows the buffer; give the memory back once it has passed.
        if (this.bytes.byteLength > SHRINK_ABOVE_BYTES && this.length * 8 < this.bytes.byteLength) {
            const shrunk = new Uint8Array(Math.max(INITIAL_STREAM_BUFFER_BYTES, this.length * 2));
            shrunk.set(this.bytes.subarray(this.start, this.end));
            this.bytes = shrunk;
            this.end = this.length;
            this.start = 0;
        }
    }
}
/**
 * The stored pack, as this run sees it. Appends leave in pieces, one in
 * flight while the next fills. The last few pieces stay readable here, so a
 * base that just left the cache costs no round trip; anything older is read
 * from the store once the pending pieces have landed.
 */
class PackOutput {
    store;
    recentBytes;
    readAheadBytes;
    piece = new Uint8Array(APPEND_PIECE_BYTES);
    filled = 0;
    inFlight = null;
    /** Bytes handed over so far, the piece being filled included. */
    written;
    /** Reads that reached the store (each one a subrequest where the store is remote). */
    storeReads = 0;
    /** Recently sent pieces, oldest first, with their pack offsets. */
    sent = [];
    window = null;
    constructor(store, written = 0, recentBytes = DEFAULT_RECENT_BYTES, readAheadBytes = READ_AHEAD_BYTES) {
        this.store = store;
        this.recentBytes = recentBytes;
        this.readAheadBytes = readAheadBytes;
        this.written = written;
    }
    /** Copy `bytes` out; a promise only when a full piece must wait for the one in flight. */
    write(bytes) {
        let at = 0;
        while (at < bytes.byteLength) {
            const take = Math.min(bytes.byteLength - at, APPEND_PIECE_BYTES - this.filled);
            this.piece.set(take === bytes.byteLength ? bytes : bytes.subarray(at, at + take), this.filled);
            this.filled += take;
            this.written += take;
            at += take;
            if (this.filled === APPEND_PIECE_BYTES) {
                const waiting = this.send();
                if (waiting !== undefined) {
                    const rest = bytes.subarray(at);
                    return waiting.then(() => this.write(rest));
                }
            }
        }
        return undefined;
    }
    async flush() {
        if (this.filled > 0)
            await this.send();
        if (this.inFlight)
            await this.inFlight;
        this.inFlight = null;
    }
    /** Random access, for a base that left the cache. */
    async read(offset, length) {
        const pieceStart = this.written - this.filled;
        const oldest = this.sent.length > 0 ? this.sent[0].offset : pieceStart;
        if (offset >= oldest && offset + length <= this.written) {
            const out = new Uint8Array(length);
            for (const part of [...this.sent, { offset: pieceStart, bytes: this.piece.subarray(0, this.filled) }]) {
                const from = Math.max(offset, part.offset);
                const to = Math.min(offset + length, part.offset + part.bytes.byteLength);
                if (to > from)
                    out.set(part.bytes.subarray(from - part.offset, to - part.offset), from - offset);
            }
            return out;
        }
        const window = this.window;
        if (window !== null && offset >= window.offset && offset + length <= window.offset + window.bytes.byteLength) {
            return window.bytes.subarray(offset - window.offset, offset - window.offset + length);
        }
        await this.flush();
        this.storeReads++;
        return await this.store.read(offset, length);
    }
    /** Sequential access, for a continuation's walk: read ahead a window at a time. */
    async readAhead(offset, length, end) {
        const window = this.window;
        if (window === null || offset < window.offset || offset + length > window.offset + window.bytes.byteLength) {
            const span = Math.min(Math.max(length, this.readAheadBytes), end - offset);
            this.storeReads++;
            this.window = { offset, bytes: await this.store.read(offset, span) };
        }
        return this.window.bytes.subarray(offset - this.window.offset, offset - this.window.offset + length);
    }
    /** Hand the filled piece to the store; a promise only while the previous one is still in flight. */
    send() {
        const full = this.piece.subarray(0, this.filled);
        this.sent.push({ offset: this.written - this.filled, bytes: full });
        while (this.sent.length > 1 && (this.sent.length - 1) * APPEND_PIECE_BYTES >= this.recentBytes)
            this.sent.shift();
        this.piece = new Uint8Array(APPEND_PIECE_BYTES);
        this.filled = 0;
        // The store owns what it is given (an RPC may transfer it); the copy kept here stays readable.
        const issue = () => {
            this.inFlight = this.store.append(full.slice());
        };
        if (this.inFlight === null) {
            issue();
            return undefined;
        }
        return this.inFlight.then(issue);
    }
}
class WorkCounter {
    units = 0;
    inflatedBytes = 0;
    hashedBytes = 0;
    deltaBytes = 0;
    objects = 0;
    baseRereads = 0;
    inflated(bytes) {
        this.inflatedBytes += bytes;
        this.units += bytes * WORK_UNIT_INFLATE_BYTE;
    }
    hashed(bytes, weight = WORK_UNIT_OBJECT_HASH_BYTE) {
        this.hashedBytes += bytes;
        this.units += bytes * weight;
    }
    delta(bytes) {
        this.deltaBytes += bytes;
        this.units += bytes * WORK_UNIT_DELTA_BYTE;
    }
    object() {
        this.objects++;
        this.units += WORK_UNIT_OBJECT;
    }
    tally() {
        const { units, inflatedBytes, hashedBytes, deltaBytes, objects, baseRereads } = this;
        return { units, inflatedBytes, hashedBytes, deltaBytes, objects, baseRereads };
    }
}
/** idx records, growing in place. */
class RecordList {
    bytes;
    count = 0;
    constructor(initial, capacity) {
        this.bytes = new Uint8Array(Math.max(capacity, initial === null ? 1 : initial.byteLength / ENTRY_BYTES, 1) * ENTRY_BYTES);
        if (initial !== null) {
            this.bytes.set(initial);
            this.count = initial.byteLength / ENTRY_BYTES;
        }
    }
    add(oid, offset, crc) {
        if ((this.count + 1) * ENTRY_BYTES > this.bytes.byteLength) {
            const grown = new Uint8Array(this.bytes.byteLength * 2);
            grown.set(this.bytes);
            this.bytes = grown;
        }
        writeEntry(this.bytes, this.count++, oid, 0, offset, crc);
    }
    view() {
        return this.bytes.subarray(0, this.count * ENTRY_BYTES);
    }
}
/**
 * zlib hands back a Node Buffer, whose slice() is a view: a copy taken from
 * one (for the wave writer, which takes ownership and may transfer it) would
 * share the cached base's memory. A plain Uint8Array's slice() copies.
 */
export function plainBytes(bytes) {
    return Object.getPrototypeOf(bytes) === Uint8Array.prototype ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function hashObject(type, data) {
    return createHash('sha1').update(objectIdPrefix(type, data.byteLength)).update(data).digest();
}
/** Records are read at most this many objects ahead of the pack header's count. */
const INITIAL_RECORD_CAPACITY = 1 << 16;
export class PackStreamProcessor {
    options;
    cache;
    work = new WorkCounter();
    budget;
    maxStoreReads;
    records = new RecordList(null, 1);
    /** In-pack ids → offsets, built the first time a ref-delta asks. */
    byOid = null;
    /** External bases used, by hex id: appended to the pack at its end. */
    externalBases = new Map();
    output;
    resolver;
    constructor(options) {
        this.options = options;
        const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
        this.cache = new ByteLru(cacheBytes, Math.floor(cacheBytes / 2));
        this.budget = options.budgetUnits ?? WORK_BUDGET_UNITS;
        this.maxStoreReads = options.maxStoreReads ?? Number.POSITIVE_INFINITY;
    }
    /** Consume a whole pack stream: decode within budget, store all of it. */
    async run(source) {
        this.output = new PackOutput(this.options.store, 0, this.options.recentBytes);
        const packHash = createHash('sha1');
        const buffer = new StreamBuffer();
        const iterator = source[Symbol.asyncIterator]();
        let ended = false;
        const pull = async () => {
            if (ended)
                return false;
            const next = await iterator.next();
            if (next.done) {
                ended = true;
                return false;
            }
            buffer.push(next.value);
            return true;
        };
        while (buffer.length < PACK_HEADER_BYTES) {
            if (!await pull())
                throw new PackFormatError('stream ended inside the pack header');
        }
        const header = buffer.view(0, PACK_HEADER_BYTES).slice();
        const { objects } = parsePackHeader(header);
        packHash.update(header);
        await this.output.write(header);
        buffer.consume(PACK_HEADER_BYTES);
        let offset = PACK_HEADER_BYTES;
        this.records = new RecordList(null, Math.min(objects, INITIAL_RECORD_CAPACITY));
        this.resolver = this.makeResolver(Number.MAX_SAFE_INTEGER);
        let checkpoint = null;
        for (let index = 0; index < objects; index++) {
            const entry = await this.nextEntry(buffer, pull, () => ended, offset);
            packHash.update(entry.packed);
            // A base re-read reaches back only into what is already stored.
            this.resolver.dataEnd = offset;
            await this.decode(entry.header, entry.packed, entry.payload, offset);
            const packedBytes = entry.packed.byteLength;
            const writing = this.output.write(entry.packed);
            if (writing !== undefined)
                await writing;
            buffer.consume(packedBytes);
            offset += packedBytes;
            if (this.spent() && index + 1 < objects) {
                checkpoint = {
                    offset,
                    decoded: index + 1,
                    records: this.records.view().slice(),
                    externalBases: [...this.externalBases.keys()],
                };
                break;
            }
        }
        // Past the budget, or past the last entry: store and hash what remains,
        // holding back the 20 bytes that may be the trailer.
        const entriesEnd = offset;
        let trailer;
        for (;;) {
            if (buffer.length > PACK_TRAILER_BYTES) {
                const body = buffer.view(0, buffer.length - PACK_TRAILER_BYTES);
                const bodyBytes = body.byteLength;
                packHash.update(body);
                await this.output.write(body);
                buffer.consume(bodyBytes);
                offset += bodyBytes;
            }
            if (!await pull()) {
                if (buffer.length !== PACK_TRAILER_BYTES)
                    throw new PackFormatError('stream ended inside the pack trailer');
                trailer = buffer.view().slice();
                break;
            }
        }
        this.work.hashed(offset, WORK_UNIT_PACK_HASH_BYTE);
        const digest = packHash.digest();
        if (oidToHex(digest) !== oidToHex(trailer)) {
            throw new PackFormatError('trailer ' + oidToHex(trailer) + " does not match the pack's SHA-1 " + oidToHex(digest));
        }
        if (checkpoint === null && offset !== entriesEnd) {
            throw new PackFormatError('pack holds ' + (offset - entriesEnd) + ' bytes past its ' + objects + ' entries');
        }
        if (checkpoint === null && this.externalBases.size > 0)
            return await this.completeThin(objects, offset);
        await this.output.write(trailer);
        await this.output.flush();
        return this.result(trailer, objects, offset + PACK_TRAILER_BYTES, checkpoint, 0);
    }
    /** Continue decoding a stored pack of `packBytes` bytes from a checkpoint. */
    async resume(checkpoint, packBytes) {
        this.output = new PackOutput(this.options.store, packBytes, this.options.recentBytes, this.options.readAheadBytes);
        const dataEnd = packBytes - PACK_TRAILER_BYTES;
        const { objects } = parsePackHeader(await this.options.store.read(0, PACK_HEADER_BYTES));
        this.records = new RecordList(checkpoint.records, objects);
        for (const hex of checkpoint.externalBases) {
            const object = await this.options.external?.read(oidFromHex(hex));
            if (!object)
                throw new PackFormatError('thin-pack base ' + hex + ' is no longer available');
            this.externalBases.set(hex, object);
        }
        this.resolver = this.makeResolver(dataEnd);
        let offset = checkpoint.offset;
        let next = null;
        for (let index = checkpoint.decoded; index < objects; index++) {
            const entry = await runAsync(this.resolver.entryAt(offset), (range) => this.output.readAhead(range.offset, range.length, dataEnd));
            this.work.inflated(entry.payload.byteLength);
            await this.decode(entry.header, entry.packed, entry.payload, offset);
            offset += entry.packed.byteLength;
            if (this.spent() && index + 1 < objects) {
                next = { offset, decoded: index + 1, records: this.records.view().slice(), externalBases: [...this.externalBases.keys()] };
                break;
            }
        }
        if (next === null && offset !== dataEnd)
            throw new PackFormatError('entries end at ' + offset + ', the trailer starts at ' + dataEnd);
        if (next === null && this.externalBases.size > 0) {
            await this.options.store.truncate(dataEnd);
            this.output = new PackOutput(this.options.store, dataEnd, this.options.recentBytes, this.options.readAheadBytes);
            return await this.completeThin(objects, dataEnd);
        }
        const packSha = await this.options.store.read(dataEnd, PACK_TRAILER_BYTES);
        return this.result(packSha, objects, packBytes, next, 0);
    }
    /** The invocation's budget is spent: its work units, or its store reads. */
    spent() {
        return this.work.units >= this.budget || this.output.storeReads >= this.maxStoreReads;
    }
    result(packSha, objects, packBytes, checkpoint, appendedBases) {
        return {
            packSha,
            objects,
            packBytes,
            entries: checkpoint === null ? sortEntries(this.records.view()) : null,
            checkpoint,
            work: { ...this.work.tally(), storeReads: this.output.storeReads },
            appendedBases,
        };
    }
    makeResolver(dataEnd) {
        return new PackObjectResolver({
            file: 'pack',
            dataEnd,
            cache: this.cache,
            refBase: (oid) => this.refBase(oid),
        });
    }
    /** Wait until the next entry's zlib stream is whole in the buffer, and inflate it. */
    async nextEntry(buffer, pull, ended, offset) {
        let header;
        while ((header = parseObjectHeader(buffer.view(), 0, offset)) === null) {
            if (!await pull())
                throw new PackFormatError('stream ended inside the entry at ' + offset);
        }
        const bound = header.headerBytes + deflateBound(header.size);
        let attempt = Math.min(bound, header.headerBytes + FIRST_INFLATE_ATTEMPT_BYTES);
        for (;;) {
            while (buffer.length < attempt && await pull())
                ;
            let inflated = null;
            try {
                inflated = inflateSync(buffer.view(header.headerBytes), { info: true, chunkSize: inflateChunkSize(header.size) });
            }
            catch (error) {
                // A stream not yet whole: retry on twice as much, so an entry costs at most twice its inflate.
                if (ended() || buffer.length >= bound) {
                    throw new PackFormatError('entry at ' + offset + ' does not inflate: ' + (error instanceof Error ? error.message : String(error)));
                }
                attempt = Math.min(bound, Math.max(attempt * 2, buffer.length + 1));
                continue;
            }
            if (inflated.buffer.byteLength !== header.size) {
                throw new PackFormatError('entry at ' + offset + ' inflates to ' + inflated.buffer.byteLength + ' bytes, its header says ' + header.size);
            }
            this.work.inflated(header.size);
            return { header, packed: buffer.view(0, header.headerBytes + inflated.engine.bytesWritten), payload: plainBytes(inflated.buffer) };
        }
    }
    async decode(header, packed, payload, offset) {
        this.work.object();
        let object;
        if (header.type === OBJ_OFS_DELTA || header.type === OBJ_REF_DELTA) {
            const base = header.type === OBJ_OFS_DELTA
                ? await this.baseAt(header.baseOffset)
                : await this.refBaseObject(header.baseOid);
            object = { type: base.type, data: applyDelta(base.data, payload) };
            this.work.delta(object.data.byteLength);
        }
        else {
            object = { type: typeName(header.type), data: payload };
        }
        this.cache.set(offset, { ...object, byteLength: object.data.byteLength });
        const oid = hashObject(object.type, object.data);
        this.work.hashed(object.data.byteLength);
        this.records.add(oid, offset, crc32(packed));
        this.byOid?.set(oidToHex(oid), offset);
        if (this.options.onObject) {
            const accepted = this.options.onObject({ oid, type: object.type, data: object.data, offset });
            if (accepted !== undefined)
                await accepted;
        }
    }
    async baseAt(offset) {
        const cached = this.cache.get(offset);
        if (cached !== undefined)
            return cached;
        this.work.baseRereads++;
        return await runAsync(this.resolver.objectAt(offset), (range) => this.output.read(range.offset, range.length));
    }
    /** A ref-delta's base: in this pack, or (a thin pack) in the repository. */
    async refBaseObject(oid) {
        let found;
        try {
            found = await runAsync(this.refBase(oid), (range) => this.output.read(range.offset, range.length));
        }
        catch (error) {
            if (!(error instanceof MissingBaseError))
                throw error;
            const object = this.options.external ? await this.options.external.read(oid) : null;
            // A base later in this pack is legal but no server we fetch from sends
            // one; git index-pack defers it, this refuses it by name.
            if (object === null)
                throw error;
            this.externalBases.set(oidToHex(oid), object);
            return object;
        }
        return 'object' in found ? found.object : await this.baseAt(found.offset);
    }
    *refBase(oid) {
        if (this.byOid === null) {
            this.byOid = new Map();
            const records = this.records.view();
            for (let i = 0; i < this.records.count; i++)
                this.byOid.set(oidToHex(records, i * ENTRY_BYTES), entryOffset(records, i));
        }
        const hex = oidToHex(oid);
        const offset = this.byOid.get(hex);
        if (offset !== undefined)
            return { offset };
        const external = this.externalBases.get(hex);
        if (external !== undefined)
            return { object: external };
        throw new MissingBaseError(oid);
    }
    /** index-pack --fix-thin: append each external base whole, rewrite the count, re-hash. */
    async completeThin(objects, dataEnd) {
        let offset = dataEnd;
        let appended = 0;
        for (const [hex, object] of this.externalBases) {
            // A base the pack also carries, later than the delta that needed it, is already in.
            if (this.byOid?.has(hex))
                continue;
            const entryHeader = encodeObjectHeader(typeCode(object.type), object.data.byteLength);
            const body = deflateSync(object.data);
            const packed = new Uint8Array(entryHeader.byteLength + body.byteLength);
            packed.set(entryHeader);
            packed.set(body, entryHeader.byteLength);
            await this.output.write(packed);
            this.records.add(hashObject(object.type, object.data), offset, crc32(packed));
            offset += packed.byteLength;
            appended++;
        }
        await this.output.flush();
        const header = encodePackHeader(objects + appended);
        await this.options.store.writeAt(0, header);
        const rehash = createHash('sha1').update(header);
        for (let at = PACK_HEADER_BYTES; at < offset; at += READ_AHEAD_BYTES) {
            rehash.update(await this.options.store.read(at, Math.min(READ_AHEAD_BYTES, offset - at)));
        }
        this.work.hashed(offset, WORK_UNIT_PACK_HASH_BYTE);
        const trailer = rehash.digest();
        await this.options.store.append(trailer);
        return this.result(trailer, objects + appended, offset + PACK_TRAILER_BYTES, null, appended);
    }
}
