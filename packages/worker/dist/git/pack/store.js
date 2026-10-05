/**
 * git/pack/store.ts — a repository's packed objects, read by range.
 *
 * No pack and no idx is ever read whole: an idx is consulted a page at a
 * time (its fanout, then a binary search over the pages of its id table),
 * and an object costs its entry and its delta chain's entries, the bases
 * held in a byte-bounded cache shared by every pack. A clone of any size can
 * be read with the memory of its largest object and the two caches.
 *
 * cf-git's readObjectPacked, hasObjectPacked and expandOidPacked delegate
 * here when the filesystem it is given carries a store (the tracked patch's
 * seam); Nimbus's filesystems always do.
 */
import { ByteLru } from './byte-lru.js';
import { OID_BYTES, PACK_TRAILER_BYTES, compareOids, oidFromHex, oidToHex, PackFormatError } from './format.js';
import { IDX_HEADER_BYTES, idxLayout, parseIdxHeader } from './idx.js';
import { MissingBaseError, PackObjectResolver, runAsync } from './reader.js';
const PAGE_BYTES = 64 * 1024;
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_CACHE_BYTES = 4 * 1024 * 1024;
class PackHandle {
    name;
    idxPath;
    packPath;
    fanout = null;
    packBytes = 0;
    resolver = null;
    constructor(name, idxPath, packPath) {
        this.name = name;
        this.idxPath = idxPath;
        this.packPath = packPath;
    }
    get count() {
        return this.fanout === null ? 0 : this.fanout[255];
    }
}
export class PackObjectStore {
    fs;
    gitdir;
    packs = null;
    cache;
    pages;
    constructor(fs, gitdir, options = {}) {
        this.fs = fs;
        this.gitdir = gitdir;
        const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
        this.cache = new ByteLru(cacheBytes, Math.floor(cacheBytes / 2));
        this.pages = new ByteLru(options.pageCacheBytes ?? DEFAULT_PAGE_CACHE_BYTES);
    }
    /** Whether some pack holds `oid`; no rescan on a miss (a prefetch asks of many it lacks). */
    async has(oid) {
        return (await this.locate(oid, true)) !== null;
    }
    /** The object, its deltas applied; null when no pack holds it. */
    async read(oid) {
        const found = await this.locate(oid);
        if (found === null)
            return null;
        const object = await runAsync(found.pack.resolver.objectAt(found.offset), (range) => this.fetch(range));
        return { ...object, source: 'objects/pack/' + found.pack.name + '.pack' };
    }
    /** Every packed id starting with `prefix` (hex). */
    async expand(prefix) {
        const out = [];
        if (prefix.length === 0)
            return out;
        const first = parseInt(prefix.slice(0, 2).padEnd(2, '0'), 16);
        const last = prefix.length >= 2 ? first : first + 15;
        for (const pack of await this.list()) {
            const layout = idxLayout(pack.count);
            for (let i = first === 0 ? 0 : pack.fanout[first - 1]; i < pack.fanout[last]; i++) {
                const hex = oidToHex(await runAsync(this.page(pack.idxPath, layout.ids + i * OID_BYTES, OID_BYTES), (range) => this.fetch(range)), 0);
                if (hex.startsWith(prefix))
                    out.push(hex);
            }
        }
        return out;
    }
    /** Forget the pack list: a fetch added one. */
    refresh() {
        this.packs = null;
    }
    async list() {
        if (this.packs !== null)
            return this.packs;
        const dir = this.gitdir + '/objects/pack';
        const names = (await this.fs.readdir(dir)).filter((name) => name.startsWith('pack-') && name.endsWith('.idx')).sort();
        const packs = [];
        for (const idxName of names) {
            const name = idxName.slice(0, -4);
            const pack = new PackHandle(name, dir + '/' + idxName, dir + '/' + name + '.pack');
            const packBytes = await this.fs.size(pack.packPath);
            // An idx without its pack is a fetch caught between the two; git skips it too.
            if (packBytes === null)
                continue;
            pack.fanout = parseIdxHeader(await runAsync(this.page(pack.idxPath, 0, IDX_HEADER_BYTES), (range) => this.fetch(range)));
            pack.packBytes = packBytes;
            pack.resolver = new PackObjectResolver({
                file: pack.packPath,
                dataEnd: packBytes - PACK_TRAILER_BYTES,
                cache: new CacheView(this.cache, pack.name),
                refBase: (base) => this.refBase(pack, base),
            });
            packs.push(pack);
        }
        this.packs = packs;
        return packs;
    }
    async locate(oid, retried = false) {
        const target = oidFromHex(oid);
        for (const pack of await this.list()) {
            const offset = await runAsync(this.find(pack, target), (range) => this.fetch(range));
            if (offset !== null)
                return { pack, offset };
        }
        // A pack written since the list was taken (git's reprepare_packed_git).
        if (!retried) {
            this.refresh();
            return this.locate(oid, true);
        }
        return null;
    }
    /** Binary search of one idx's fanout bucket, a page at a time; null when absent. */
    *find(pack, oid) {
        const layout = idxLayout(pack.count);
        let lo = oid[0] === 0 ? 0 : pack.fanout[oid[0] - 1];
        let hi = pack.fanout[oid[0]];
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const id = yield* this.page(pack.idxPath, layout.ids + mid * OID_BYTES, OID_BYTES);
            const order = compareOids(id, 0, oid, 0);
            if (order === 0) {
                const word = yield* this.page(pack.idxPath, layout.offsets32 + mid * 4, 4);
                const value = ((word[0] << 24) | (word[1] << 16) | (word[2] << 8) | word[3]) >>> 0;
                if ((value & 0x80000000) === 0)
                    return value;
                const wide = yield* this.page(pack.idxPath, layout.offsets64 + (value & 0x7fffffff) * 8, 8);
                const view = new DataView(wide.buffer, wide.byteOffset, 8);
                return view.getUint32(0) * 0x100000000 + view.getUint32(4);
            }
            if (order < 0)
                lo = mid + 1;
            else
                hi = mid;
        }
        return null;
    }
    /** `length` bytes at `at` of `path`, from whole cached pages (a range spans at most two). */
    *page(path, at, length) {
        const first = Math.floor(at / PAGE_BYTES);
        const last = Math.floor((at + length - 1) / PAGE_BYTES);
        const out = first === last ? null : new Uint8Array(length);
        for (let p = first, filled = 0; p <= last; p++) {
            const key = path + '#' + p;
            let page = this.pages.get(key);
            if (page === undefined) {
                const bytes = yield { file: path, offset: p * PAGE_BYTES, length: PAGE_BYTES };
                page = { bytes, byteLength: bytes.byteLength };
                this.pages.set(key, page);
            }
            const from = Math.max(at, p * PAGE_BYTES) - p * PAGE_BYTES;
            const to = Math.min(at + length, (p + 1) * PAGE_BYTES) - p * PAGE_BYTES;
            if (to > page.byteLength)
                throw new PackFormatError(path + ' is truncated at ' + (at + length));
            if (out === null)
                return page.bytes.subarray(from, to);
            out.set(page.bytes.subarray(from, to), filled);
            filled += to - from;
        }
        return out;
    }
    async fetch(range) {
        const bytes = await this.fs.readRange(range.file, range.offset, range.length);
        // An idx page may end early: the file does, and page() checks what it uses.
        if (bytes.byteLength < range.length && !range.file.endsWith('.idx')) {
            throw new PackFormatError(range.file + ': ' + range.length + ' bytes at ' + range.offset + ' came back as ' + bytes.byteLength);
        }
        return bytes;
    }
    /** A ref-delta's base in a stored pack: in the same pack, which on disk is self-contained. */
    *refBase(pack, oid) {
        const offset = yield* this.find(pack, oid);
        if (offset === null)
            throw new MissingBaseError(oid);
        return { offset };
    }
}
/** One pack's view of the shared base cache: its offsets, keyed under the pack's name. */
class CacheView {
    shared;
    pack;
    constructor(shared, pack) {
        this.shared = shared;
        this.pack = pack;
    }
    get(offset) {
        return this.shared.get(this.pack + ':' + offset);
    }
    set(offset, object) {
        this.shared.set(this.pack + ':' + offset, object);
    }
}
export function packsSeam(fs, options = {}) {
    const stores = new Map();
    const store = (gitdir) => {
        let found = stores.get(gitdir);
        if (found === undefined)
            stores.set(gitdir, found = new PackObjectStore(fs, gitdir, options));
        return found;
    };
    const fetchMissing = async (gitdir, oids) => {
        if (options.promisor === undefined || oids.length === 0)
            return false;
        if (!await options.promisor(gitdir, oids))
            return false;
        store(gitdir).refresh();
        return true;
    };
    return {
        async read(gitdir, oid) {
            const found = await store(gitdir).read(oid);
            if (found !== null)
                return found;
            // A read the command did not prefetch: git's lazy fetch of one object.
            return await fetchMissing(gitdir, [oid]) ? await store(gitdir).read(oid) : null;
        },
        has: (gitdir, oid) => store(gitdir).has(oid),
        expand: (gitdir, prefix) => store(gitdir).expand(prefix),
        async prefetch(gitdir, oids) {
            const missing = [];
            for (const oid of new Set(oids))
                if (!await store(gitdir).has(oid))
                    missing.push(oid);
            await fetchMissing(gitdir, missing);
        },
    };
}
