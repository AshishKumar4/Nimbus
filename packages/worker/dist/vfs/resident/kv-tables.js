/**
 * The resident store's tables in the facet's key-value storage, written so
 * the output gate never holds what the process says next.
 *
 * A Durable Object turn that writes SQL holds its next outbound message until
 * the write is confirmed: 23-36 ms measured on every turn a fill wrote rows
 * (verify/consolidation/file-engine-d4-measurements.md). A put with
 * `allowUnconfirmed` holds nothing, and the synchronous `kv.get` and
 * `kv.list` read it at once, in the same turn. Both survive what SQL does: an
 * isolate killed for memory keeps them, one killed for CPU loses the stretch
 * it died in. So the rows are SQLite's (the same database, its __cf_kv
 * table), written without the gate, and read synchronously.
 *
 * Its answers are the tables' (tables.ts ResidentTables), in their key order:
 * keys are the rows' primary keys under one tag each, compared by UTF-8
 * bytes, with numbers zero-padded so their order is numeric; the one-shot's
 * heap answers alike (resident-store-backings). A value that is listed in a
 * scan (a chunk's, a page's) has a key-only index beside it, so a scan never
 * reads the bytes.
 */
import { RK_OWN_WRITE, NS_DIR, RESIDENT_SCHEMA } from './tables.js';
import { residentBytes } from './cell-cost.js';
import { Error, NumberOf, SafeList, SafeSet, StringFromCharCode, arrayCopy, stringOf } from '@nimbus-sh/core/_shared/primordials.js';
const UNCONFIRMED = { allowUnconfirmed: true };
/** The most keys one delete takes (the storage API's bound). */
const DELETE_BATCH = 128;
/** Between a key's parts: below every character a path or name holds, so a composite key sorts as its parts do ((parent, name)). */
const SEP = '\u0001';
/** Decimal, padded past Number.MAX_SAFE_INTEGER's 16 digits: key order is numeric order. */
const pad = (n) => stringOf(NumberOf(n)).padStart(17, '0');
// One tag a table. A row's key is its tag and its primary key.
const FILE = 'F';
const CHUNK = 'C';
const CHUNK_KEYS = 'X';
const BY_CKEY = 'K';
const NS = 'N';
const PAGE = 'P';
const PAGE_ROWS = 'Q';
const PAGE_USED = 'U';
const META = 'M';
const SEQ = META + 'seq';
const END = { [FILE]: StringFromCharCode(0x47), [NS]: StringFromCharCode(0x4f) };
export function kvTables(storage, rowsChanged = () => { }) {
    const writeRows = (path, write) => {
        rowsChanged(path);
        write();
    };
    const kv = storage.kv;
    const put = (key, value) => { storage.put(key, value, UNCONFIRMED); };
    const drop = (keys) => {
        let batch = new SafeList();
        for (let i = 0; i < keys.length; i++) {
            batch[batch.length] = keys[i];
            if (batch.length === DELETE_BATCH) {
                storage.delete(arrayCopy(batch), UNCONFIRMED);
                batch = new SafeList();
            }
        }
        if (batch.length > 0)
            storage.delete(arrayCopy(batch), UNCONFIRMED);
    };
    const dropOne = (key) => { storage.delete(key, UNCONFIRMED); };
    const keysOf = (options) => {
        const out = new SafeList();
        for (const [key] of kv.list(options))
            out[out.length] = key;
        return out;
    };
    const rangeOf = (tag, from, to) => ({
        start: tag + from, end: to === null ? END[tag] : tag + to,
    });
    const fileKey = (path) => FILE + path;
    const fileOf = (path) => kv.get(fileKey(path));
    const chunkKey = (path, part) => CHUNK + path + SEP + pad(part);
    const chunkIndex = (path, part) => CHUNK_KEYS + path + SEP + pad(part);
    const byKey = (row, path) => BY_CKEY + row[4] + SEP + pad(row[5]) + SEP + path;
    const nsKey = (parent, name) => NS + parent + SEP + name;
    const pageTail = (path, rev, part) => path + SEP + pad(rev) + SEP + pad(part);
    const unpage = (tail) => {
        const at = tail.length - 2 * 18;
        return { path: tail.slice(0, at), rev: NumberOf(tail.slice(at + 1, at + 18)), part: NumberOf(tail.slice(at + 19)) };
    };
    const chunkRow = (value) => (typeof value === 'string' ? { txt: value, bin: null } : { txt: null, bin: value });
    /** A new head row for `path`, its rowid the highest (INSERT OR REPLACE). */
    const setFile = (path, kind, size, chunks, rev, ckey) => {
        const had = fileOf(path);
        if (had !== undefined && had[4] !== null)
            dropOne(byKey(had, path));
        const seq = NumberOf(kv.get(SEQ) ?? 0) + 1;
        put(SEQ, seq);
        const row = [kind, size, chunks, rev, ckey, seq];
        put(fileKey(path), row);
        if (ckey !== null)
            put(byKey(row, path), 1);
    };
    /** `path`'s head row with `rev`, its rowid kept (UPDATE). */
    const setRev = (path, row, rev) => { put(fileKey(path), [row[0], row[1], row[2], NumberOf(rev), row[4], row[5]]); };
    const deleteFile = (path) => {
        const had = fileOf(path);
        if (had === undefined)
            return;
        if (had[4] !== null)
            dropOne(byKey(had, path));
        dropOne(fileKey(path));
    };
    const deleteChunks = (path) => {
        const parts = keysOf({ prefix: CHUNK_KEYS + path + SEP });
        const keys = new SafeList();
        for (let i = 0; i < parts.length; i++) {
            keys[keys.length] = parts[i];
            keys[keys.length] = CHUNK + parts[i].slice(1);
        }
        drop(keys);
    };
    const addChunk = (path, part, value, replace) => {
        const index = chunkIndex(path, part);
        if (!replace && kv.get(index) !== undefined)
            throw new Error('UNIQUE constraint failed: chunk.path, chunk.part');
        put(chunkKey(path, part), value);
        put(index, 1);
    };
    /** Every file row, in key order: [path, row]. */
    const files = () => {
        const out = new SafeList();
        for (const [key, value] of kv.list({ prefix: FILE }))
            out[out.length] = [key.slice(1), value];
        return out;
    };
    /** Every path that has chunk rows, in key order. */
    const chunkPaths = () => {
        const out = new SafeList();
        let last = null;
        for (const [key] of kv.list({ prefix: CHUNK_KEYS })) {
            const path = key.slice(1, key.lastIndexOf(SEP));
            if (path !== last) {
                out[out.length] = path;
                last = path;
            }
        }
        return out;
    };
    const dropWhere = (keepFile, keepChunkPath) => writeRows(undefined, () => {
        const paths = chunkPaths();
        for (let i = 0; i < paths.length; i++)
            if (!keepChunkPath(paths[i]))
                deleteChunks(paths[i]);
        const rows = files();
        for (let i = 0; i < rows.length; i++)
            if (!keepFile(rows[i][1]))
                deleteFile(rows[i][0]);
    });
    const ownPaths = () => {
        const own = new SafeSet();
        const rows = files();
        for (let i = 0; i < rows.length; i++)
            if (rows[i][1][3] === RK_OWN_WRITE)
                own.add(rows[i][0]);
        return own;
    };
    const nsRows = (options) => {
        const out = new SafeList();
        for (const [key, value] of kv.list(options)) {
            const at = key.indexOf(SEP);
            out[out.length] = [{ parent: key.slice(1, at), name: key.slice(at + 1) }, value];
        }
        return out;
    };
    const deleteKeys = (options) => drop(keysOf(options));
    if (kv.get(META + 'schema') !== RESIDENT_SCHEMA) {
        for (const tag of [FILE, CHUNK, CHUNK_KEYS, BY_CKEY, NS, PAGE, PAGE_ROWS, PAGE_USED, META])
            deleteKeys({ prefix: tag });
        put(META + 'schema', RESIDENT_SCHEMA);
    }
    return {
        bytes() { return NumberOf(storage.sql?.databaseSize ?? 0); },
        databaseSize() { return NumberOf(storage.sql?.databaseSize ?? 0); },
        metaGet(k) { const v = kv.get(META + k); return v === undefined ? undefined : stringOf(v); },
        metaSet(k, v) { put(META + k, stringOf(v)); },
        fileHead(path) { const row = fileOf(path); return row === undefined ? undefined : { kind: row[0], size: row[1], chunks: row[2] }; },
        fileRev(path) { return fileOf(path)?.[3]; },
        fileRevKey(path) { const row = fileOf(path); return row === undefined ? undefined : { rev: row[3], ckey: row[4] }; },
        fileOwnSize(path) { const row = fileOf(path); return row !== undefined && row[3] === RK_OWN_WRITE ? row[1] : undefined; },
        filePut(path, kind, size, chunks, rev, ckey) {
            if (!(rev >= -1))
                throw new Error('CHECK constraint failed: rev >= -1');
            writeRows(path, () => { setFile(path, NumberOf(kind), NumberOf(size), NumberOf(chunks), NumberOf(rev), ckey == null ? null : stringOf(ckey)); });
        },
        fileSetRev(path, rev) {
            writeRows(path, () => { const row = fileOf(path); if (row !== undefined)
                setRev(path, row, rev); });
        },
        fileStampOwn(path, rev) {
            writeRows(path, () => {
                const row = fileOf(path);
                if (row !== undefined && row[3] === RK_OWN_WRITE)
                    setRev(path, row, rev);
            });
        },
        fileDelete(path) { writeRows(path, () => { deleteFile(path); }); },
        fileByKey(ckey, notPath) {
            // The first that can be copied, in the ckey index's order (seq).
            for (const [key] of kv.list({ prefix: BY_CKEY + stringOf(ckey) + SEP })) {
                const path = key.slice(key.indexOf(SEP) + 1 + 17 + 1);
                if (path === notPath)
                    continue;
                const row = fileOf(path);
                if (row !== undefined && row[3] >= 0)
                    return { path, kind: row[0], size: row[1], chunks: row[2] };
            }
            return undefined;
        },
        filePaths(from, to) {
            const out = new SafeList();
            for (const [key] of kv.list(rangeOf(FILE, from, to)))
                out[out.length] = key.slice(1);
            return arrayCopy(out);
        },
        fileAny(from, to) { for (const _entry of kv.list({ ...rangeOf(FILE, from, to), limit: 1 }))
            return true; return false; },
        fileRevsIn(from, to) {
            const out = new SafeList();
            for (const [key, value] of kv.list(rangeOf(FILE, from, to)))
                out[out.length] = { path: key.slice(1), rev: value[3] };
            return arrayCopy(out);
        },
        fileAllPaths() { const rows = files(); const out = new SafeList(); for (let i = 0; i < rows.length; i++)
            out[out.length] = rows[i][0]; return arrayCopy(out); },
        fileRows() {
            const rows = files();
            const out = new SafeList();
            for (let i = 0; i < rows.length; i++)
                out[out.length] = { path: rows[i][0], rev: rows[i][1][3], ckey: rows[i][1][4] };
            return arrayCopy(out);
        },
        fileOwnPaths() {
            const rows = files();
            const out = new SafeList();
            for (let i = 0; i < rows.length; i++)
                if (rows[i][1][3] === RK_OWN_WRITE)
                    out[out.length] = rows[i][0];
            return arrayCopy(out);
        },
        fileStats() {
            const rows = files();
            let b = 0;
            for (let i = 0; i < rows.length; i++)
                b += rows[i][1][1];
            return { n: rows.length, b };
        },
        chunkFirst(path) { const value = kv.get(chunkKey(path, 0)); return value === undefined ? undefined : chunkRow(value); },
        chunkParts(path) {
            const out = new SafeList();
            for (const [, value] of kv.list({ prefix: CHUNK + path + SEP }))
                out[out.length] = chunkRow(value);
            return arrayCopy(out);
        },
        chunkAddText(path, part, txt) { addChunk(path, NumberOf(part), stringOf(txt), false); },
        chunkAddBin(path, part, bin) { addChunk(path, NumberOf(part), residentBytes(bin).slice(), false); },
        chunkSetBin(path, part, bin) { addChunk(path, NumberOf(part), residentBytes(bin).slice(), true); },
        chunkCopy(to, from) {
            const parts = new SafeList();
            for (const [key, value] of kv.list({ prefix: CHUNK + from + SEP }))
                parts[parts.length] = [key.slice(key.lastIndexOf(SEP) + 1), value];
            // One step: a conflicting part fails the whole copy, and nothing lands.
            for (let i = 0; i < parts.length; i++) {
                if (kv.get(CHUNK_KEYS + to + SEP + parts[i][0]) !== undefined)
                    throw new Error('UNIQUE constraint failed: chunk.path, chunk.part');
            }
            for (let i = 0; i < parts.length; i++) {
                put(CHUNK + to + SEP + parts[i][0], parts[i][1]);
                put(CHUNK_KEYS + to + SEP + parts[i][0], 1);
            }
        },
        chunkDelete(path) { writeRows(path, () => { deleteChunks(path); }); },
        dropOwn() { const own = ownPaths(); dropWhere((row) => row[3] !== RK_OWN_WRITE, (path) => !own.has(path)); },
        dropDated() { const own = ownPaths(); dropWhere((row) => row[3] === RK_OWN_WRITE, (path) => own.has(path)); },
        dropDatedFiles() {
            const dated = new SafeSet();
            const rows = files();
            for (let i = 0; i < rows.length; i++)
                if (rows[i][1][3] !== RK_OWN_WRITE)
                    dated.add(rows[i][0]);
            dropWhere((row) => row[3] === RK_OWN_WRITE, (path) => !dated.has(path));
        },
        clear() {
            writeRows(undefined, () => { for (const tag of [CHUNK, CHUNK_KEYS, FILE, BY_CKEY])
                deleteKeys({ prefix: tag }); });
            for (const tag of [NS, PAGE, PAGE_ROWS, PAGE_USED])
                deleteKeys({ prefix: tag });
            // The schema stamp is the tables', not their rows'.
            const meta = keysOf({ prefix: META });
            const keep = new SafeList();
            for (let i = 0; i < meta.length; i++)
                if (meta[i] !== META + 'schema')
                    keep[keep.length] = meta[i];
            drop(keep);
        },
        pageGet(path, rev, part) { const value = kv.get(PAGE + pageTail(path, rev, part)); return value === undefined ? undefined : value; },
        pageUse(path, rev, part, used) {
            const tail = pageTail(path, rev, part);
            const row = kv.get(PAGE_ROWS + tail);
            if (row === undefined)
                return;
            dropOne(PAGE_USED + pad(row[0]) + SEP + tail);
            put(PAGE_USED + pad(used) + SEP + tail, row[1]);
            put(PAGE_ROWS + tail, [NumberOf(used), row[1]]);
        },
        pagePut(path, rev, part, bin, used) {
            const tail = pageTail(path, rev, part);
            const had = kv.get(PAGE_ROWS + tail);
            const bytes = residentBytes(bin).slice();
            if (had !== undefined)
                dropOne(PAGE_USED + pad(had[0]) + SEP + tail);
            put(PAGE + tail, bytes);
            put(PAGE_ROWS + tail, [NumberOf(used), bytes.byteLength]);
            put(PAGE_USED + pad(used) + SEP + tail, bytes.byteLength);
            return had === undefined ? 0 : had[1];
        },
        pageDelete(path, rev, part) {
            const tail = pageTail(path, rev, part);
            const had = kv.get(PAGE_ROWS + tail);
            if (had === undefined)
                return;
            const keys = new SafeList();
            keys[0] = PAGE + tail;
            keys[1] = PAGE_ROWS + tail;
            keys[2] = PAGE_USED + pad(had[0]) + SEP + tail;
            drop(keys);
        },
        pageOldest(limit) {
            // Least recently used first; ties by path, rev, part: the index's key order.
            const out = new SafeList();
            for (const [key, value] of kv.list({ prefix: PAGE_USED, limit })) {
                const { path, rev, part } = unpage(key.slice(1 + 17 + 1));
                out[out.length] = { path, rev, part, size: value };
            }
            return arrayCopy(out);
        },
        pageBytes() { let n = 0; for (const [, value] of kv.list({ prefix: PAGE_ROWS }))
            n += value[1]; return n; },
        pageMaxUsed() { for (const [key] of kv.list({ prefix: PAGE_USED, reverse: true, limit: 1 }))
            return NumberOf(key.slice(1, 18)); return 0; },
        nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
            put(nsKey(parent, name), {
                kind: NumberOf(kind), size: NumberOf(size), mode: NumberOf(mode), uid: NumberOf(uid), gid: NumberOf(gid),
                atime: NumberOf(atime), mtime: NumberOf(mtime), ctime: NumberOf(ctime), ino: NumberOf(ino), rev: NumberOf(rev),
                target: target == null ? null : stringOf(target), dev: NumberOf(dev) || 0, nlink: NumberOf(nlink) || 1,
            });
        },
        nsGet(parent, name) { return kv.get(nsKey(parent, name)); },
        nsDelete(parent, name) { dropOne(nsKey(parent, name)); },
        nsDeleteChildren(parent) { deleteKeys({ prefix: NS + parent + SEP }); },
        nsDeleteParents(from, to) { deleteKeys(rangeOf(NS, from, to)); },
        nsClear() { deleteKeys({ prefix: NS }); },
        nsKeys() { const rows = nsRows({ prefix: NS }); const out = new SafeList(); for (let i = 0; i < rows.length; i++)
            out[out.length] = rows[i][0]; return arrayCopy(out); },
        nsOfKind(kind) {
            const rows = nsRows({ prefix: NS });
            const out = new SafeList();
            for (let i = 0; i < rows.length; i++)
                if (rows[i][1].kind === NumberOf(kind))
                    out[out.length] = rows[i][0];
            return arrayCopy(out);
        },
        nsUnlisted() {
            const rows = nsRows({ prefix: NS });
            const out = new SafeList();
            for (let i = 0; i < rows.length; i++) {
                const [key, row] = rows[i];
                if (row.kind === NS_DIR && row.target !== null)
                    out[out.length] = { parent: key.parent, name: key.name, target: row.target };
            }
            return arrayCopy(out);
        },
        nsChildren(parent) {
            const out = new SafeList();
            for (const [key, value] of kv.list({ prefix: NS + parent + SEP })) {
                const row = value;
                out[out.length] = { name: key.slice(key.indexOf(SEP) + 1), kind: row.kind, mode: row.mode };
            }
            return arrayCopy(out);
        },
        nsCount() { let n = 0; for (const _entry of kv.list({ prefix: NS }))
            n++; return n; },
    };
}
