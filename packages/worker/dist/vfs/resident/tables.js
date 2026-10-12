/**
 * The resident store's tables, and its two backings (store.ts decides; a
 * backing only stores). Four tables: 'file' (one row per held path: kind,
 * size, chunk count, revision, content key), 'chunk' (the bytes), 'meta'
 * (schema, cursor, namespace readiness) and 'ns' (the namespace: a stat per
 * visible name, keyed (parent, name)).
 *
 * - sqlTables: the process facet's own SQLite (ctx.storage.sql), durable
 *   across the facet's incarnations. Every statement the store has ever
 *   issued lives here, unchanged.
 * - heapTables: a one-shot process's store, in its heap, for the life of the
 *   run (runOnce hosts no SQLite). Same rows, same answers, and a byte count
 *   that plays the database's size for the store's budget.
 *
 * Rows come back as plain objects with the column names as keys: file heads
 * { kind, size, chunks }, chunks { txt, bin } (bin as the backing holds it;
 * callers normalise with residentBytes), ns rows with every stat column.
 */
import { RESIDENT_ROW_BYTES, namespaceRowBytes, residentBytes, utf8Length } from './cell-cost.js';
/**
 * Cell kinds. A cell is one of the three things __vfsBundle has always held,
 * and the kind is stored rather than inferred so a text file whose bytes happen
 * to be valid UTF-8 does not change shape between a write and a read.
 */
export const RESIDENT_SCHEMA = '3';
export const RK_TEXT = 0;
export const RK_BINARY = 1;
export const RK_DENIED = 2;
/**
 * The revision of a cell holding this facet's own bytes that the authority has
 * not acknowledged yet: a write that has not flushed, or a cell one of its own
 * mutations holds while that mutation is in flight (store.lease).
 *
 * Read-your-writes: strictly newer than anything the authority could report,
 * so it is never evicted by a delta and never mistaken for something the
 * authority vouched for. A distinct sentinel rather than NULL, because NULL
 * would reintroduce the undated row the NOT NULL constraint exists to forbid.
 *
 * It is the ONE revision a delta cannot evict, so it must mean exactly that
 * and nothing else. The acknowledgement dates the row (store.stamp), and
 * bytes the authority served are dated as they are installed (store.fill). A
 * row left here after either would hold its bytes against every later write
 * by anyone, for the life of the store.
 */
export const RK_OWN_WRITE = -1;
/** Namespace row kinds. */
export const NS_FILE = 0;
export const NS_DIR = 1;
export const NS_LINK = 2;
const num = (value) => Number(value);
const keyOf = (value) => (value == null ? null : String(value));
const chunkRow = (row) => ({
    txt: row.txt == null ? null : String(row.txt),
    bin: row.bin == null ? null : row.bin,
});
const nsRow = (row) => ({
    kind: num(row.kind), size: num(row.size), mode: num(row.mode), uid: num(row.uid), gid: num(row.gid),
    atime: num(row.atime), mtime: num(row.mtime), ctime: num(row.ctime), ino: num(row.ino), rev: num(row.rev),
    target: keyOf(row.target), dev: num(row.dev), nlink: num(row.nlink),
});
export function sqlTables(sql) {
    let schema = null;
    for (const _row of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"))
        schema = '';
    if (schema !== null)
        for (const row of sql.exec("SELECT v FROM meta WHERE k = 'schema'"))
            schema = String(row.v);
    if (schema !== RESIDENT_SCHEMA) {
        for (const table of ['chunk', 'file', 'ns', 'meta'])
            sql.exec('DROP TABLE IF EXISTS ' + table);
    }
    // 'ckey' is the authority's content identity for the bytes (equal keys,
    // equal bytes), when it said so; null for bytes it did not describe.
    sql.exec('CREATE TABLE IF NOT EXISTS file ('
        + 'path TEXT PRIMARY KEY, kind INTEGER NOT NULL, size INTEGER NOT NULL, '
        + 'chunks INTEGER NOT NULL, rev INTEGER NOT NULL CHECK (rev >= -1), ckey TEXT'
        + ')');
    sql.exec('CREATE INDEX IF NOT EXISTS file_ckey ON file (ckey) WHERE ckey IS NOT NULL');
    sql.exec('CREATE TABLE IF NOT EXISTS chunk ('
        + 'path TEXT NOT NULL, part INTEGER NOT NULL, txt TEXT, bin BLOB, '
        + 'PRIMARY KEY (path, part)'
        + ')');
    // The store's own cursor, in the same storage as the rows it describes, so
    // the two cannot be separated by an isolate restart.
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)", RESIDENT_SCHEMA);
    // The namespace: every name the process's credential can see, with its stat
    // and no content. Keyed (parent, name) so a point lookup and a directory
    // listing are both one index seek, and no path is stored twice.
    sql.exec('CREATE TABLE IF NOT EXISTS ns ('
        + 'parent TEXT NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL, size INTEGER NOT NULL, '
        + 'mode INTEGER NOT NULL, uid INTEGER NOT NULL, gid INTEGER NOT NULL, atime REAL NOT NULL, '
        + 'mtime REAL NOT NULL, ctime REAL NOT NULL, ino INTEGER NOT NULL, rev INTEGER NOT NULL, target TEXT, '
        + 'dev INTEGER NOT NULL DEFAULT 0, nlink INTEGER NOT NULL DEFAULT 1, '
        + 'PRIMARY KEY (parent, name)'
        + ') WITHOUT ROWID');
    const first = (rows) => {
        for (const row of rows)
            return row;
        return undefined;
    };
    const ranged = (select, from, to, tail = '') => (to === null
        ? sql.exec(select + ' WHERE path >= ?' + tail, from)
        : sql.exec(select + ' WHERE path >= ? AND path < ?' + tail, from, to));
    return {
        bytes() {
            const size = sql.databaseSize;
            if (typeof size === 'number' && size > 0)
                return size;
            for (const row of sql.exec('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()'))
                return num(row.n);
            return 0;
        },
        databaseSize() { return num(sql.databaseSize ?? 0); },
        metaGet(k) { const row = first(sql.exec('SELECT v FROM meta WHERE k = ?', k)); return row === undefined ? undefined : String(row.v); },
        metaSet(k, v) { sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v); },
        fileHead(path) {
            const row = first(sql.exec('SELECT kind, size, chunks FROM file WHERE path = ?', path));
            return row === undefined ? undefined : { kind: num(row.kind), size: num(row.size), chunks: num(row.chunks) };
        },
        fileRev(path) { const row = first(sql.exec('SELECT rev FROM file WHERE path = ?', path)); return row === undefined ? undefined : num(row.rev); },
        fileRevKey(path) {
            const row = first(sql.exec('SELECT rev, ckey FROM file WHERE path = ?', path));
            return row === undefined ? undefined : { rev: num(row.rev), ckey: keyOf(row.ckey) };
        },
        fileOwnSize(path) {
            const row = first(sql.exec('SELECT size FROM file WHERE path = ? AND rev = ?', path, RK_OWN_WRITE));
            return row === undefined ? undefined : num(row.size);
        },
        filePut(path, kind, size, chunks, rev, ckey) {
            sql.exec('INSERT OR REPLACE INTO file (path, kind, size, chunks, rev, ckey) VALUES (?, ?, ?, ?, ?, ?)', path, kind, size, chunks, rev, ckey);
        },
        fileSetRev(path, rev) { sql.exec('UPDATE file SET rev = ? WHERE path = ?', rev, path); },
        fileStampOwn(path, rev) { sql.exec('UPDATE file SET rev = ? WHERE path = ? AND rev = ?', rev, path, RK_OWN_WRITE); },
        fileDelete(path) { sql.exec('DELETE FROM file WHERE path = ?', path); },
        fileByKey(ckey, notPath) {
            const row = first(sql.exec('SELECT path, kind, size, chunks FROM file WHERE ckey = ? AND rev >= 0 AND path <> ? LIMIT 1', ckey, notPath));
            return row === undefined ? undefined : { path: String(row.path), kind: num(row.kind), size: num(row.size), chunks: num(row.chunks) };
        },
        filePaths(from, to) { return [...ranged('SELECT path FROM file', from, to)].map((row) => String(row.path)); },
        fileAny(from, to) { return first(ranged('SELECT path FROM file', from, to, ' LIMIT 1')) !== undefined; },
        fileRevsIn(from, to) { return [...ranged('SELECT path, rev FROM file', from, to)].map((row) => ({ path: String(row.path), rev: num(row.rev) })); },
        // In key order, as every other scan here is: the primary key's index
        // serves it, and both backings then answer in one order.
        fileAllPaths() { return [...sql.exec('SELECT path FROM file ORDER BY path')].map((row) => String(row.path)); },
        fileRows() {
            return [...sql.exec('SELECT path, rev, ckey FROM file ORDER BY path')].map((row) => ({ path: String(row.path), rev: num(row.rev), ckey: keyOf(row.ckey) }));
        },
        fileOwnPaths() { return [...sql.exec('SELECT path FROM file WHERE rev = ? ORDER BY path', RK_OWN_WRITE)].map((row) => String(row.path)); },
        fileStats() { const row = first(sql.exec('SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM file')); return row === undefined ? undefined : { n: num(row.n), b: num(row.b) }; },
        chunkFirst(path) { const row = first(sql.exec('SELECT txt, bin FROM chunk WHERE path = ? AND part = 0', path)); return row === undefined ? undefined : chunkRow(row); },
        chunkParts(path) { return [...sql.exec('SELECT txt, bin FROM chunk WHERE path = ? ORDER BY part', path)].map(chunkRow); },
        chunkAddText(path, part, txt) { sql.exec('INSERT INTO chunk (path, part, txt) VALUES (?, ?, ?)', path, part, txt); },
        chunkAddBin(path, part, bin) { sql.exec('INSERT INTO chunk (path, part, bin) VALUES (?, ?, ?)', path, part, bin); },
        chunkSetBin(path, part, bin) { sql.exec('INSERT OR REPLACE INTO chunk (path, part, bin) VALUES (?, ?, ?)', path, part, bin); },
        chunkCopy(to, from) { sql.exec('INSERT INTO chunk (path, part, txt, bin) SELECT ?, part, txt, bin FROM chunk WHERE path = ?', to, from); },
        chunkDelete(path) { sql.exec('DELETE FROM chunk WHERE path = ?', path); },
        dropOwn() {
            sql.exec('DELETE FROM chunk WHERE path IN (SELECT path FROM file WHERE rev = ?)', RK_OWN_WRITE);
            sql.exec('DELETE FROM file WHERE rev = ?', RK_OWN_WRITE);
        },
        dropDated() {
            sql.exec('DELETE FROM chunk WHERE path NOT IN (SELECT path FROM file WHERE rev = ?)', RK_OWN_WRITE);
            sql.exec('DELETE FROM file WHERE rev <> ?', RK_OWN_WRITE);
        },
        dropDatedFiles() {
            sql.exec('DELETE FROM chunk WHERE path IN (SELECT path FROM file WHERE rev <> ?)', RK_OWN_WRITE);
            sql.exec('DELETE FROM file WHERE rev <> ?', RK_OWN_WRITE);
        },
        clear() {
            sql.exec('DELETE FROM chunk');
            sql.exec('DELETE FROM file');
            sql.exec('DELETE FROM ns');
            sql.exec('DELETE FROM meta');
        },
        nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
            sql.exec('INSERT OR REPLACE INTO ns (parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) '
                + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, Number(dev) || 0, Number(nlink) || 1);
        },
        nsGet(parent, name) {
            const row = first(sql.exec('SELECT kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink FROM ns WHERE parent = ? AND name = ?', parent, name));
            return row === undefined ? undefined : nsRow(row);
        },
        nsDelete(parent, name) { sql.exec('DELETE FROM ns WHERE parent = ? AND name = ?', parent, name); },
        nsDeleteChildren(parent) { sql.exec('DELETE FROM ns WHERE parent = ?', parent); },
        nsDeleteParents(from, to) {
            if (to === null)
                sql.exec('DELETE FROM ns WHERE parent >= ?', from);
            else
                sql.exec('DELETE FROM ns WHERE parent >= ? AND parent < ?', from, to);
        },
        nsClear() { sql.exec('DELETE FROM ns'); },
        nsKeys() { return [...sql.exec('SELECT parent, name FROM ns')].map((row) => ({ parent: String(row.parent), name: String(row.name) })); },
        nsOfKind(kind) { return [...sql.exec('SELECT parent, name FROM ns WHERE kind = ?', kind)].map((row) => ({ parent: String(row.parent), name: String(row.name) })); },
        nsUnlisted() {
            return [...sql.exec('SELECT parent, name, target FROM ns WHERE kind = ? AND target IS NOT NULL', NS_DIR)]
                .map((row) => ({ parent: String(row.parent), name: String(row.name), target: String(row.target) }));
        },
        nsChildren(parent) {
            return [...sql.exec('SELECT name, kind, mode FROM ns WHERE parent = ?', parent)].map((row) => ({ name: String(row.name), kind: num(row.kind), mode: num(row.mode) }));
        },
        nsCount() { const row = first(sql.exec('SELECT count(*) AS n FROM ns')); return row === undefined ? 0 : num(row.n); },
    };
}
/**
 * The one-shot backing: the same tables, in the process's heap, for the life
 * of one run. A one-shot is hosted by runOnce, which gives it no SQLite, and
 * it keeps nothing after it exits. Its answers are the SQLite backing's:
 * scans come back in key order (a b-tree's), reads hand back copies (a
 * program that writes into a Buffer it read must not change the store), and
 * `bytes()` counts what it holds in the units residentCellCost charges (a
 * row, and the payload's bytes), so the store's one budget rule serves both.
 */
export function heapTables() {
    const files = new Map();
    const chunks = new Map();
    const meta = new Map();
    const ns = new Map();
    const byKey = new Map();
    let sorted = null;
    let used = 0;
    let names = 0;
    let namespaceBytes = 0;
    // SQLite's binary collation orders TEXT by its UTF-8 bytes: code-point
    // order, which UTF-16 comparison is not past the BMP.
    const cmp = (a, b) => {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const x = a.codePointAt(i), y = b.codePointAt(i);
            if (x !== y)
                return x < y ? -1 : 1;
            if (x > 0xffff)
                i++;
        }
        return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    };
    const payload = (cell) => (cell.txt != null ? utf8Length(cell.txt) : cell.bin ? cell.bin.byteLength : 0);
    const unkey = (path, row) => {
        if (row && row.ckey != null) {
            const set = byKey.get(row.ckey);
            if (set) {
                set.delete(path);
                if (set.size === 0)
                    byKey.delete(row.ckey);
            }
        }
    };
    const paths = () => {
        if (sorted === null)
            sorted = [...files.keys()].sort(cmp);
        return sorted;
    };
    const lowerBound = (list, from) => {
        let lo = 0, hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (cmp(list[mid], from) < 0)
                lo = mid + 1;
            else
                hi = mid;
        }
        return lo;
    };
    const inRange = (from, to) => {
        const list = paths();
        const out = [];
        for (let i = lowerBound(list, from); i < list.length && (to === null || cmp(list[i], to) < 0); i++)
            out.push(list[i]);
        return out;
    };
    const copy = (cell) => ({ txt: cell.txt ?? null, bin: cell.bin ? cell.bin.slice() : null });
    const dropChunks = (path) => {
        const parts = chunks.get(path);
        if (!parts)
            return;
        for (const cell of parts.values())
            used -= RESIDENT_ROW_BYTES + payload(cell);
        chunks.delete(path);
    };
    const dropFile = (path) => {
        const row = files.get(path);
        if (row === undefined)
            return;
        unkey(path, row);
        files.delete(path);
        sorted = null;
        used -= RESIDENT_ROW_BYTES;
    };
    const addChunk = (path, part, cell, replace) => {
        let parts = chunks.get(path);
        if (!parts) {
            parts = new Map();
            chunks.set(path, parts);
        }
        const had = parts.get(part);
        if (had !== undefined) {
            if (!replace)
                throw new Error('UNIQUE constraint failed: chunk.path, chunk.part');
            used -= RESIDENT_ROW_BYTES + payload(had);
        }
        parts.set(part, cell);
        used += RESIDENT_ROW_BYTES + payload(cell);
    };
    const nsGetRow = (parent, name) => { const dir = ns.get(parent); return dir ? dir.get(name) : undefined; };
    const nsDrop = (parent, name) => {
        const dir = ns.get(parent);
        const row = dir?.get(name);
        if (dir === undefined || row === undefined)
            return;
        dir.delete(name);
        names--;
        const bytes = namespaceRowBytes(parent, name, row.target);
        used -= bytes;
        namespaceBytes -= bytes;
        if (dir.size === 0)
            ns.delete(parent);
    };
    const nsDropParent = (parent) => {
        const dir = ns.get(parent);
        if (!dir)
            return;
        names -= dir.size;
        for (const [name, row] of dir) {
            const bytes = namespaceRowBytes(parent, name, row.target);
            used -= bytes;
            namespaceBytes -= bytes;
        }
        ns.delete(parent);
    };
    const dropWhere = (keepFile, keepChunkPath) => {
        for (const path of [...chunks.keys()])
            if (!keepChunkPath(path))
                dropChunks(path);
        for (const [path, row] of [...files])
            if (!keepFile(row))
                dropFile(path);
    };
    const sortedNames = (dir) => [...dir.keys()].sort(cmp);
    return {
        bytes() { return used; },
        databaseSize() { return used; },
        metaGet(k) { return meta.get(k); },
        metaSet(k, v) { meta.set(k, String(v)); },
        fileHead(path) { const row = files.get(path); return row === undefined ? undefined : { kind: row.kind, size: row.size, chunks: row.chunks }; },
        fileRev(path) { const row = files.get(path); return row === undefined ? undefined : row.rev; },
        fileRevKey(path) { const row = files.get(path); return row === undefined ? undefined : { rev: row.rev, ckey: row.ckey }; },
        fileOwnSize(path) { const row = files.get(path); return row !== undefined && row.rev === RK_OWN_WRITE ? row.size : undefined; },
        filePut(path, kind, size, chunkCount, rev, ckey) {
            if (!(rev >= -1))
                throw new Error('CHECK constraint failed: rev >= -1');
            const had = files.get(path);
            if (had === undefined) {
                sorted = null;
                used += RESIDENT_ROW_BYTES;
            }
            else
                unkey(path, had);
            const row = { kind: Number(kind), size: Number(size), chunks: Number(chunkCount), rev: Number(rev), ckey: ckey == null ? null : String(ckey) };
            files.set(path, row);
            if (row.ckey !== null) {
                let set = byKey.get(row.ckey);
                if (!set) {
                    set = new Set();
                    byKey.set(row.ckey, set);
                }
                set.add(path);
            }
        },
        fileSetRev(path, rev) { const row = files.get(path); if (row !== undefined)
            row.rev = Number(rev); },
        fileStampOwn(path, rev) { const row = files.get(path); if (row !== undefined && row.rev === RK_OWN_WRITE)
            row.rev = Number(rev); },
        fileDelete(path) { dropFile(path); },
        fileByKey(ckey, notPath) {
            const set = byKey.get(String(ckey));
            if (!set)
                return undefined;
            for (const path of set) {
                const row = files.get(path);
                if (path !== notPath && row && row.rev >= 0)
                    return { path, kind: row.kind, size: row.size, chunks: row.chunks };
            }
            return undefined;
        },
        filePaths(from, to) { return inRange(from, to); },
        fileAny(from, to) { const list = paths(); const i = lowerBound(list, from); return i < list.length && (to === null || cmp(list[i], to) < 0); },
        fileRevsIn(from, to) { return inRange(from, to).map((path) => ({ path, rev: files.get(path).rev })); },
        fileAllPaths() { return [...paths()]; },
        fileRows() { return paths().map((path) => { const row = files.get(path); return { path, rev: row.rev, ckey: row.ckey }; }); },
        fileOwnPaths() { return paths().filter((path) => files.get(path).rev === RK_OWN_WRITE); },
        fileStats() { let b = 0; for (const row of files.values())
            b += row.size; return { n: files.size, b }; },
        chunkFirst(path) { const parts = chunks.get(path); const cell = parts && parts.get(0); return cell === undefined ? undefined : copy(cell); },
        chunkParts(path) {
            const parts = chunks.get(path);
            if (!parts)
                return [];
            return [...parts.keys()].sort((a, b) => a - b).map((part) => copy(parts.get(part)));
        },
        chunkAddText(path, part, txt) { addChunk(path, Number(part), { txt: String(txt), bin: null }, false); },
        chunkAddBin(path, part, bin) { addChunk(path, Number(part), { txt: null, bin: residentBytes(bin).slice() }, false); },
        chunkSetBin(path, part, bin) { addChunk(path, Number(part), { txt: null, bin: residentBytes(bin).slice() }, true); },
        chunkCopy(to, from) {
            const parts = chunks.get(from);
            if (!parts)
                return;
            // One statement in SQLite: a conflicting part fails the whole copy, and nothing lands.
            const held = chunks.get(to);
            if (held)
                for (const part of parts.keys())
                    if (held.has(part))
                        throw new Error('UNIQUE constraint failed: chunk.path, chunk.part');
            for (const [part, cell] of [...parts])
                addChunk(to, part, { txt: cell.txt, bin: cell.bin ? cell.bin.slice() : null }, false);
        },
        chunkDelete(path) { dropChunks(path); },
        dropOwn() {
            const own = new Set(paths().filter((path) => files.get(path).rev === RK_OWN_WRITE));
            dropWhere((row) => row.rev !== RK_OWN_WRITE, (path) => !own.has(path));
        },
        dropDated() {
            const own = new Set(paths().filter((path) => files.get(path).rev === RK_OWN_WRITE));
            dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => own.has(path));
        },
        dropDatedFiles() {
            const dated = new Set(paths().filter((path) => files.get(path).rev !== RK_OWN_WRITE));
            dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => !dated.has(path));
        },
        clear() {
            files.clear();
            chunks.clear();
            meta.clear();
            ns.clear();
            byKey.clear();
            sorted = null;
            used = 0;
            names = 0;
            namespaceBytes = 0;
        },
        nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
            let dir = ns.get(parent);
            const previous = dir?.get(name);
            const bytes = namespaceRowBytes(parent, name, target);
            const growth = bytes - (previous === undefined ? 0 : namespaceRowBytes(parent, name, previous.target));
            if (!dir) {
                dir = new Map();
                ns.set(parent, dir);
            }
            if (previous === undefined)
                names++;
            used += growth;
            namespaceBytes += growth;
            dir.set(name, {
                kind: Number(kind), size: Number(size), mode: Number(mode), uid: Number(uid), gid: Number(gid),
                atime: Number(atime), mtime: Number(mtime), ctime: Number(ctime), ino: Number(ino), rev: Number(rev),
                target: target == null ? null : String(target), dev: Number(dev) || 0, nlink: Number(nlink) || 1,
            });
        },
        nsGet(parent, name) { const row = nsGetRow(parent, name); return row === undefined ? undefined : { ...row }; },
        nsDelete(parent, name) { nsDrop(parent, name); },
        nsDeleteChildren(parent) { nsDropParent(parent); },
        nsDeleteParents(from, to) {
            for (const parent of [...ns.keys()])
                if (cmp(parent, from) >= 0 && (to === null || cmp(parent, to) < 0))
                    nsDropParent(parent);
        },
        nsClear() { used -= namespaceBytes; names = 0; namespaceBytes = 0; ns.clear(); },
        nsBytes() { return namespaceBytes; },
        nsGrowth(parent, name, target) {
            const previous = nsGetRow(parent, name);
            return namespaceRowBytes(parent, name, target) - (previous === undefined ? 0 : namespaceRowBytes(parent, name, previous.target));
        },
        nsKeys() {
            const out = [];
            for (const parent of [...ns.keys()].sort(cmp))
                for (const name of sortedNames(ns.get(parent)))
                    out.push({ parent, name });
            return out;
        },
        nsOfKind(kind) {
            const out = [];
            for (const parent of [...ns.keys()].sort(cmp)) {
                const dir = ns.get(parent);
                for (const name of sortedNames(dir))
                    if (dir.get(name).kind === Number(kind))
                        out.push({ parent, name });
            }
            return out;
        },
        nsUnlisted() {
            const out = [];
            for (const parent of [...ns.keys()].sort(cmp)) {
                const dir = ns.get(parent);
                for (const name of sortedNames(dir)) {
                    const row = dir.get(name);
                    if (row.kind === NS_DIR && row.target !== null)
                        out.push({ parent, name, target: row.target });
                }
            }
            return out;
        },
        nsChildren(parent) {
            const dir = ns.get(parent);
            if (!dir)
                return [];
            return sortedNames(dir).map((name) => ({ name, kind: dir.get(name).kind, mode: dir.get(name).mode }));
        },
        nsCount() { return names; },
    };
}
