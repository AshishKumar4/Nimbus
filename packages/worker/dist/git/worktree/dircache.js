/**
 * git/worktree/dircache.ts — the git index (Documentation/gitformat-index.txt)
 * as its own bytes.
 *
 * A repository's index is held as the file read (every entry in on-disk
 * version 2/3 layout, a version 4 file's prefix-compressed names expanded)
 * and a table of where each entry starts: about 110 bytes a file, no object
 * per entry. A path is decoded only when asked for, and a lookup compares
 * bytes. A stat refresh patches the entry where it lies; any other change is
 * written by one ordered merge of the old entries' bytes with the new ones.
 */
import { createHash } from 'node:crypto';
import { oidFromHex, oidToHex } from '../pack/format.js';
import { CacheTree } from './cachetree.js';
export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IFGITLINK = 0o160000;
/** The empty blob's id: a size-0 entry naming it is not racily smudged (read-cache.c). */
export const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const HEADER_BYTES = 12;
const OID_BYTES = 20;
/** ctime, mtime, dev, ino, mode, uid, gid, size, then the object id. */
const FLAGS_AT = 40 + OID_BYTES;
const FIXED_BYTES = FLAGS_AT + 2;
const NAME_MASK = 0x0fff;
const STAGE_MASK = 0x3000;
const EXTENDED = 0x4000;
const VALID = 0x8000;
/** The second flags word (version 3 and up). */
const SKIP_WORKTREE = 0x4000;
const INTENT_TO_ADD = 0x2000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** git's name order: the bytes of the path. */
export function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            return a[i] - b[i];
    return a.length - b.length;
}
/** A path's bytes as a string: ASCII without the decoder's cost. */
export function decodePath(bytes) {
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] >= 0x80)
            return decoder.decode(bytes);
    }
    return String.fromCharCode.apply(null, bytes);
}
/** git's order of two paths as strings: their UTF-8 bytes, which is code point order rather than UTF-16's. */
export function comparePaths(a, b) {
    for (let i = 0; i < a.length && i < b.length; i++) {
        let x = a.charCodeAt(i);
        let y = b.charCodeAt(i);
        if (x === y)
            continue;
        // Surrogates (astral code points) sort above the rest of the BMP.
        if (x >= 0xd800)
            x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
        if (y >= 0xd800)
            y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
        return x - y;
    }
    return a.length - b.length;
}
/** An entry's length in version 2/3 layout: the name and 1-8 NULs to a multiple of 8. */
function paddedLength(extended, nameLength) {
    return (FIXED_BYTES + (extended ? 2 : 0) + nameLength + 8) & ~7;
}
/** decode_varint (varint.c), for version 4's strip counts. */
function decodeVarint(bytes, at) {
    let c = bytes[at++];
    let value = c & 127;
    while (c & 128) {
        value += 1;
        c = bytes[at++];
        value = value * 128 + (c & 127);
    }
    return [value, at];
}
function encodeVarint(value) {
    const out = [value & 127];
    for (let rest = Math.floor(value / 128); rest; rest = Math.floor(rest / 128)) {
        rest--;
        out.unshift(128 | (rest & 127));
    }
    return out;
}
/** An object's id: SHA-1 of `<type> <size>\0` and the bytes. */
export function objectId(type, data) {
    return oidToHex(createHash('sha1').update(encoder.encode(`${type} ${data.length}\0`)).update(data).digest());
}
export class IndexFormatError extends Error {
}
/**
 * The index of one repository. `timestamp` is the index file's mtime in
 * seconds as read (git's istate->timestamp), 0 when there was none: an entry
 * whose mtime is not older is racily clean.
 */
export class DirCache {
    bytes;
    offsets;
    version;
    timestamp;
    extensions;
    /** Entries verified against the worktree by this command: never smudged (CE_UPTODATE). */
    uptodate;
    /** A stat refresh happened: the index is worth writing. */
    refreshed = false;
    /** The checksum the file read ended with (null: there was none): what a revision check compares. */
    trailer;
    /** The TREE extension's bytes as read, or as set; null for none. */
    treeBytes;
    /** Those bytes read (undefined until asked for); null when there are none git would read. */
    tree;
    /** The cache tree changed: written, it saves the next command reading trees. */
    cacheTreeChanged = false;
    /** `bytes` are this index's own: a refresh patches them. */
    constructor(bytes, offsets, version, timestamp, extensions, trailer) {
        this.bytes = bytes;
        this.offsets = offsets;
        this.version = version;
        this.timestamp = timestamp;
        this.extensions = extensions;
        this.uptodate = new Uint8Array(offsets.length);
        this.trailer = trailer;
        this.treeBytes = extensions.find(({ signature }) => signature === 'TREE')?.bytes ?? null;
    }
    get count() {
        return this.offsets.length;
    }
    /** A repository's index before anything is added: no file yet. */
    static empty() {
        return new DirCache(new Uint8Array(0), new Uint32Array(0), 2, 0, [], null);
    }
    /** The index at `file`, empty when there is none. */
    static async read(fs, file) {
        let bytes;
        let mtime;
        try {
            mtime = (await fs.lstat(file)).mtime;
            bytes = await fs.readFileUncached(file);
        }
        catch {
            return DirCache.empty();
        }
        return DirCache.parse(bytes, Math.floor(mtime / 1000));
    }
    /** read_index_from on bytes already read. */
    static parse(bytes, timestamp) {
        if (bytes.length < HEADER_BYTES + OID_BYTES || decodePath(bytes.subarray(0, 4)) !== 'DIRC') {
            throw new IndexFormatError('index file corrupt');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = view.getUint32(4);
        if (version < 2 || version > 4)
            throw new IndexFormatError(`bad index version ${version}`);
        const count = view.getUint32(8);
        const end = bytes.length - OID_BYTES;
        const digest = createHash('sha1').update(bytes.subarray(0, end)).digest();
        if (compareBytes(new Uint8Array(digest.buffer, digest.byteOffset, OID_BYTES), bytes.subarray(end)) !== 0) {
            throw new IndexFormatError('index file corrupt: bad signature');
        }
        let at = HEADER_BYTES;
        let entries = bytes;
        const offsets = new Uint32Array(count);
        if (version === 4) {
            // Expanded to version 3 layout once, so every later read is the same.
            const expanded = [];
            let size = 0;
            let previous = new Uint8Array(0);
            for (let i = 0; i < count; i++) {
                const flags = view.getUint16(at + FLAGS_AT);
                const extended = (flags & EXTENDED) !== 0;
                const fixed = FIXED_BYTES + (extended ? 2 : 0);
                const [strip, suffixAt] = decodeVarint(bytes, at + fixed);
                if (strip > previous.length)
                    throw new IndexFormatError('malformed name field in the index');
                const nul = bytes.indexOf(0, suffixAt);
                const name = new Uint8Array(previous.length - strip + nul - suffixAt);
                name.set(previous.subarray(0, previous.length - strip));
                name.set(bytes.subarray(suffixAt, nul), previous.length - strip);
                const entry = new Uint8Array(paddedLength(extended, name.length));
                entry.set(bytes.subarray(at, at + fixed));
                entry.set(name, fixed);
                offsets[i] = HEADER_BYTES + size;
                size += entry.length;
                expanded.push(entry);
                previous = name;
                at = nul + 1;
            }
            entries = new Uint8Array(HEADER_BYTES + size);
            entries.set(bytes.subarray(0, HEADER_BYTES));
            let offset = HEADER_BYTES;
            for (const entry of expanded) {
                entries.set(entry, offset);
                offset += entry.length;
            }
        }
        else {
            for (let i = 0; i < count; i++) {
                if (at + FIXED_BYTES > end)
                    throw new IndexFormatError('index file corrupt: truncated entry');
                offsets[i] = at;
                const flags = view.getUint16(at + FLAGS_AT);
                const extended = (flags & EXTENDED) !== 0;
                const nameAt = at + FIXED_BYTES + (extended ? 2 : 0);
                let length = flags & NAME_MASK;
                if (length === NAME_MASK)
                    length = bytes.indexOf(0, nameAt) - nameAt;
                at += paddedLength(extended, length);
            }
        }
        const extensions = [];
        while (at + 8 <= end) {
            const signature = decodePath(bytes.subarray(at, at + 4));
            const size = view.getUint32(at + 4);
            const data = bytes.subarray(at + 8, at + 8 + size);
            at += 8 + size;
            if (signature === 'link')
                throw new IndexFormatError('the index is split (core.splitIndex), which this git does not read');
            if (signature === 'sdir')
                throw new IndexFormatError('the index is sparse (index.sparse), which this git does not read');
            if (signature[0] < 'A' || signature[0] > 'Z') {
                throw new IndexFormatError(`index uses ${signature} extension, which we do not understand`);
            }
            extensions.push({ signature, bytes: data });
        }
        return new DirCache(entries, offsets, version, timestamp, extensions, bytes.slice(end));
    }
    u32(i, field) {
        const at = this.offsets[i] + field;
        const b = this.bytes;
        return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
    }
    flags(i) {
        const at = this.offsets[i] + FLAGS_AT;
        return (this.bytes[at] << 8) | this.bytes[at + 1];
    }
    extendedFlags(i) {
        if (!(this.flags(i) & EXTENDED))
            return 0;
        const at = this.offsets[i] + FIXED_BYTES;
        return (this.bytes[at] << 8) | this.bytes[at + 1];
    }
    /** Entry `i`'s name bytes, a view of the index. */
    pathBytes(i) {
        const at = this.offsets[i];
        const flags = this.flags(i);
        const nameAt = at + FIXED_BYTES + (flags & EXTENDED ? 2 : 0);
        let length = flags & NAME_MASK;
        if (length === NAME_MASK)
            length = this.bytes.indexOf(0, nameAt) - nameAt;
        return this.bytes.subarray(nameAt, nameAt + length);
    }
    path(i) {
        return decodePath(this.pathBytes(i));
    }
    mode(i) {
        return this.u32(i, 24);
    }
    oidBytes(i) {
        const at = this.offsets[i] + 40;
        return this.bytes.subarray(at, at + OID_BYTES);
    }
    oid(i) {
        return oidToHex(this.bytes, this.offsets[i] + 40);
    }
    stage(i) {
        return (this.flags(i) & STAGE_MASK) >> 12;
    }
    /** CE_VALID: assume unchanged, never stat'd. */
    assumeValid(i) {
        return (this.flags(i) & VALID) !== 0;
    }
    skipWorktree(i) {
        return (this.extendedFlags(i) & SKIP_WORKTREE) !== 0;
    }
    intentToAdd(i) {
        return (this.extendedFlags(i) & INTENT_TO_ADD) !== 0;
    }
    ctimeSeconds(i) { return this.u32(i, 0); }
    mtimeSeconds(i) { return this.u32(i, 8); }
    ino(i) { return this.u32(i, 20); }
    uid(i) { return this.u32(i, 28); }
    gid(i) { return this.u32(i, 32); }
    size(i) { return this.u32(i, 36); }
    /** The first entry at or after `key` (path bytes) in [lo, hi). */
    lowerBound(key, lo = 0, hi = this.count) {
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (compareBytes(this.pathBytes(mid), key) < 0)
                lo = mid + 1;
            else
                hi = mid;
        }
        return lo;
    }
    /** The paths with unmerged entries (stages 1-3), each once, in index order. */
    unmergedPaths() {
        const out = [];
        for (let i = 0; i < this.count; i++) {
            if (this.stage(i) === 0)
                continue;
            const path = this.path(i);
            if (out[out.length - 1] !== path)
                out.push(path);
        }
        return out;
    }
    /** The first entry at `path` (its lowest stage), or -1. */
    find(path) {
        const key = encoder.encode(path);
        const at = this.lowerBound(key);
        return at < this.count && compareBytes(this.pathBytes(at), key) === 0 ? at : -1;
    }
    /** [lo, hi): the entries below directory `dir` ('' is the whole index). */
    rangeUnder(dir, lo = 0, hi = this.count) {
        if (!dir)
            return [lo, hi];
        const key = encoder.encode(`${dir}/`);
        const first = this.lowerBound(key, lo, hi);
        // '0' follows '/': the first name past the directory's.
        key[key.length - 1] = 0x30;
        return [first, this.lowerBound(key, first, hi)];
    }
    /** The index's cache tree (its TREE extension), or null when it has none git would read. */
    cacheTree() {
        if (this.tree === undefined)
            this.tree = this.treeBytes === null ? null : CacheTree.parse(this.treeBytes);
        return this.tree;
    }
    /** Record `bytes` as the index's TREE extension, when they say something the one held does not. */
    setCacheTree(bytes) {
        if (this.treeBytes !== null && compareBytes(this.treeBytes, bytes) === 0)
            return;
        this.treeBytes = bytes;
        this.tree = undefined;
        this.cacheTreeChanged = true;
    }
    /** Mark entry `i` checked against the worktree by this command. */
    markUptodate(i) {
        this.uptodate[i] = 1;
    }
    isUptodate(i) {
        return this.uptodate[i] === 1;
    }
    /** is_racy_timestamp: entry `i`'s matching stat proves nothing, as it is not older than the index. */
    isRacy(i) {
        return this.timestamp !== 0 && (this.mode(i) & S_IFMT) !== S_IFGITLINK && this.mtimeSeconds(i) >= this.timestamp;
    }
    /** fill_stat_cache_info: entry `i` takes the file's fresh stat, its content having matched. */
    refresh(i, stat) {
        writeStat(this.bytes, this.offsets[i], stat);
        this.uptodate[i] = 1;
        this.refreshed = true;
    }
    /**
     * The index file with `edit` applied: header, entries in path order, the
     * extensions that still hold, and the checksum. `smudged` entries get size
     * 0 (ce_smudge_racily_clean_entry). The cache tree goes once an entry
     * changes, and the untracked cache and monitor tokens always: nothing here
     * keeps them, and git rebuilds them.
     */
    encode(edit = {}, smudged = new Set()) {
        const removed = edit.removed ?? new Set();
        // Nothing but stat refreshes, which patched these bytes where they lie: the file is these bytes
        // with a new checksum, and no second copy of the index is made (a status refresh at 96,000 entries).
        if (removed.size === 0 && (edit.added ?? []).length === 0 && smudged.size === 0 && !this.cacheTreeChanged
            && this.version !== 4 && this.trailer !== null && this.extensions.every(({ signature }) => signature === 'TREE' || signature === 'REUC')) {
            const end = this.bytes.length - OID_BYTES;
            this.bytes.set(createHash('sha1').update(this.bytes.subarray(0, end)).digest(), end);
            return this.bytes;
        }
        const added = (edit.added ?? []).map((entry) => ({ entry, key: encoder.encode(entry.path), stage: entry.stage ?? 0 }));
        added.sort((a, b) => compareBytes(a.key, b.key) || a.stage - b.stage);
        for (let i = 1; i < added.length; i++) {
            if (compareBytes(added[i - 1].key, added[i].key) === 0 && added[i - 1].stage === added[i].stage) {
                throw new IndexFormatError(`index: ${added[i].entry.path} added twice`);
            }
        }
        const pieces = [];
        let extended = false;
        let a = 0;
        let count = 0;
        let runEnd = -1;
        for (let i = 0; i <= this.count; i++) {
            const key = i < this.count ? this.pathBytes(i) : null;
            // New entries before this one; one at its path replaces it.
            while (a < added.length && (key === null || compareBytes(added[a].key, key) <= 0)) {
                const { entry, key: name, stage } = added[a++];
                extended ||= entry.skipWorktree === true;
                pieces.push(encodeIndexEntry(name, entry.mode, entry.oid, entry.stat, { stage, skipWorktree: entry.skipWorktree }));
                runEnd = -1;
                count++;
            }
            if (key === null)
                break;
            if (removed.has(i))
                continue;
            if (a > 0 && compareBytes(added[a - 1].key, key) === 0)
                continue;
            const start = this.offsets[i];
            const end = i + 1 < this.count ? this.offsets[i + 1] : start + paddedLength((this.flags(i) & EXTENDED) !== 0, this.pathBytes(i).length);
            let piece = this.bytes.subarray(start, end);
            if (smudged.has(i)) {
                piece = piece.slice();
                piece.fill(0, 36, 40);
            }
            // An entry is copied in its own layout: one with the second flags word keeps the file at version 3.
            extended ||= (this.flags(i) & EXTENDED) !== 0;
            // Entries kept one after another are copied as one run (version 4 re-encodes each name, so it keeps them apart).
            const last = pieces[pieces.length - 1];
            if (this.version !== 4 && last !== undefined && runEnd === start && last.buffer === piece.buffer && piece.byteOffset === last.byteOffset + last.length) {
                pieces[pieces.length - 1] = this.bytes.subarray(start - last.length, end);
            }
            else {
                pieces.push(piece);
            }
            runEnd = end;
            count++;
        }
        // The cache tree loses the directories a changed entry is in (cache_tree_invalidate_path); the rest holds.
        const tree = this.cacheTree();
        const changedPaths = [...[...removed].map((i) => this.path(i)), ...added.map(({ entry }) => entry.path)];
        const extensions = [
            ...(tree === null ? [] : [{ signature: 'TREE', bytes: tree.invalidate(changedPaths) }]),
            ...this.extensions.filter(({ signature }) => signature === 'REUC'),
        ];
        // Version 3 demotes to 2 when no entry needs the second flags word (do_write_index).
        const version = this.version === 4 ? 4 : extended ? 3 : 2;
        return writeIndexFile(version, count, version === 4 ? toVersion4(pieces) : pieces, extensions);
    }
}
/** The file: header, the entries as given, the extensions, the checksum. */
function writeIndexFile(version, count, body, extensions) {
    let size = HEADER_BYTES + OID_BYTES;
    for (const piece of body)
        size += piece.length;
    for (const ext of extensions)
        size += 8 + ext.bytes.length;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out.set(encoder.encode('DIRC'));
    view.setUint32(4, version);
    view.setUint32(8, count);
    let at = HEADER_BYTES;
    for (const piece of body) {
        out.set(piece, at);
        at += piece.length;
    }
    for (const ext of extensions) {
        out.set(encoder.encode(ext.signature), at);
        view.setUint32(at + 4, ext.bytes.length);
        out.set(ext.bytes, at + 8);
        at += 8 + ext.bytes.length;
    }
    out.set(createHash('sha1').update(out.subarray(0, at)).digest(), at);
    return out;
}
/** An entry's name bytes, in version 2/3 layout. */
function entryName(entry) {
    const flags = (entry[FLAGS_AT] << 8) | entry[FLAGS_AT + 1];
    const nameAt = FIXED_BYTES + (flags & EXTENDED ? 2 : 0);
    const length = flags & NAME_MASK;
    return entry.subarray(nameAt, length < NAME_MASK ? nameAt + length : entry.indexOf(0, nameAt));
}
/** Entries in version 2/3 layout laid back to back (a clone batch's share of the index), one by one. */
export function splitIndexEntries(bytes) {
    const entries = [];
    for (let at = 0; at < bytes.length;) {
        const entry = bytes.subarray(at);
        const extended = (entry[FLAGS_AT] & (EXTENDED >> 8)) !== 0;
        const length = paddedLength(extended, entryName(entry).length);
        entries.push(bytes.subarray(at, at + length));
        at += length;
    }
    return entries;
}
/**
 * An index file of `entries` (encodeIndexEntry's, in any order; one path
 * twice at one stage is refused), then `extensions`: version 2, or 3 when an
 * entry has the second flags word. How a clone writes the index it checked
 * out; DirCache.encode writes every later one.
 */
export function encodeIndexFile(entries, extensions = []) {
    const stageOf = (entry) => (entry[FLAGS_AT] >> 4) & 3;
    const keyed = entries.map((entry) => ({ entry, name: entryName(entry), stage: stageOf(entry) }));
    keyed.sort((a, b) => compareBytes(a.name, b.name) || a.stage - b.stage);
    let extended = false;
    for (let i = 0; i < keyed.length; i++) {
        if (i > 0 && compareBytes(keyed[i - 1].name, keyed[i].name) === 0 && keyed[i - 1].stage === keyed[i].stage) {
            throw new IndexFormatError(`index: ${decodePath(keyed[i].name)} appears twice`);
        }
        extended ||= (keyed[i].entry[FLAGS_AT] & (EXTENDED >> 8)) !== 0;
    }
    return writeIndexFile(extended ? 3 : 2, keyed.length, keyed.map(({ entry }) => entry), extensions);
}
function writeStat(bytes, at, stat) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 40);
    const u32 = (field, value) => view.setUint32(field, Math.floor(value) % 0x100000000);
    u32(0, stat.ctimeMs / 1000);
    u32(4, (Math.floor(stat.ctimeMs) % 1000) * 1e6);
    u32(8, stat.mtimeMs / 1000);
    u32(12, (Math.floor(stat.mtimeMs) % 1000) * 1e6);
    u32(16, stat.dev);
    u32(20, stat.ino);
    u32(28, stat.uid);
    u32(32, stat.gid);
    u32(36, stat.size);
}
/**
 * One entry in version 2/3 layout: its stat (all zero when null, as for an
 * entry never checked out or a gitlink), mode, id, flags, then its name and
 * 1-8 NULs to a multiple of 8. A skip-worktree entry takes the second flags
 * word, which makes the file version 3.
 */
export function encodeIndexEntry(path, mode, oid, stat, { stage = 0, skipWorktree = false } = {}) {
    const name = typeof path === 'string' ? encoder.encode(path) : path;
    const out = new Uint8Array(paddedLength(skipWorktree, name.length));
    if (stat)
        writeStat(out, 0, stat);
    const view = new DataView(out.buffer);
    view.setUint32(24, mode);
    out.set(typeof oid === 'string' ? oidFromHex(oid) : oid.subarray(0, OID_BYTES), 40);
    view.setUint16(FLAGS_AT, (skipWorktree ? EXTENDED : 0) | (stage << 12) | Math.min(name.length, NAME_MASK));
    if (skipWorktree)
        view.setUint16(FIXED_BYTES, SKIP_WORKTREE);
    out.set(name, FIXED_BYTES + (skipWorktree ? 2 : 0));
    return out;
}
/** Version 4's entries: each name as the bytes it strips from the last one's end and the bytes it adds, unpadded. */
function toVersion4(pieces) {
    const out = [];
    let previous = new Uint8Array(0);
    for (const piece of pieces) {
        const view = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
        const flags = view.getUint16(FLAGS_AT);
        const fixed = FIXED_BYTES + (flags & EXTENDED ? 2 : 0);
        let length = flags & NAME_MASK;
        if (length === NAME_MASK)
            length = piece.indexOf(0, fixed) - fixed;
        const name = piece.subarray(fixed, fixed + length);
        let common = 0;
        while (common < previous.length && common < name.length && previous[common] === name[common])
            common++;
        const strip = encodeVarint(previous.length - common);
        const entry = new Uint8Array(fixed + strip.length + name.length - common + 1);
        entry.set(piece.subarray(0, fixed));
        entry.set(strip, fixed);
        entry.set(name.subarray(common), fixed + strip.length);
        out.push(entry);
        previous = name;
    }
    return out;
}
