/**
 * The resident store's tables, and its two backings (store.ts decides; a
 * backing only stores). Five tables: 'file' (one row per held path: kind,
 * size, chunk count, revision, content key), 'chunk' (the bytes), 'meta'
 * (schema, cursor, namespace readiness), 'ns' (the namespace: a stat per
 * visible name, keyed (parent, name)) and 'page' (pages of files too big to
 * hold whole, each at the revision it was read at: pages.ts).
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
import {
  arrayBufferByteLength, arrayCopy, arraySort, Error, mathMin, NumberOf, SafeList, SafeMap, SafeSet, stringCodePointAt,
  stringOf, typedArrayBuffer, typedArrayByteLength, typedArrayByteOffset, Uint8ArrayConstructor,
} from '@nimbus-sh/core/_shared/primordials.js';

/**
 * Cell kinds. A cell is one of the three things __vfsBundle has always held,
 * and the kind is stored rather than inferred so a text file whose bytes happen
 * to be valid UTF-8 does not change shape between a write and a read.
 */
export const RESIDENT_SCHEMA = '4';
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

export interface FileHead { kind: number; size: number; chunks: number }
export interface FileRow { path: string; rev: number; ckey: string | null }
export interface FileByKey extends FileHead { path: string }
export interface ChunkRow { txt: string | null; bin: Uint8Array | ArrayBuffer | null }
export interface NsRow {
  kind: number;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  atime: number;
  mtime: number;
  ctime: number;
  ino: number;
  rev: number;
  target: string | null;
  dev: number;
  nlink: number;
}
export interface NsKey { parent: string; name: string }
export interface NsChild { name: string; kind: number; mode: number }
export interface PageRow { path: string; rev: number; part: number; size: number }

/** The one contract both backings keep. */
export interface ResidentTables {
  /** What the store's budget counts it as holding. */
  bytes(): number;
  databaseSize(): number;
  metaGet(k: string): string | undefined;
  metaSet(k: string, v: string): void;
  fileHead(path: string): FileHead | undefined;
  fileRev(path: string): number | undefined;
  fileRevKey(path: string): { rev: number; ckey: string | null } | undefined;
  fileOwnSize(path: string): number | undefined;
  filePut(path: string, kind: number, size: number, chunks: number, rev: number, ckey: string | null): void;
  fileSetRev(path: string, rev: number): void;
  fileStampOwn(path: string, rev: number): void;
  fileDelete(path: string): void;
  fileByKey(ckey: string, notPath: string): FileByKey | undefined;
  filePaths(from: string, to: string | null): string[];
  fileAny(from: string, to: string | null): boolean;
  fileRevsIn(from: string, to: string | null): { path: string; rev: number }[];
  fileAllPaths(): string[];
  fileRows(): FileRow[];
  fileOwnPaths(): string[];
  fileStats(): { n: number; b: number } | undefined;
  chunkFirst(path: string): ChunkRow | undefined;
  chunkParts(path: string): ChunkRow[];
  chunkAddText(path: string, part: number, txt: string): void;
  chunkAddBin(path: string, part: number, bin: Uint8Array): void;
  chunkSetBin(path: string, part: number, bin: Uint8Array): void;
  chunkCopy(to: string, from: string): void;
  chunkDelete(path: string): void;
  /** Own rows are the one provenance a new incarnation cannot date. */
  dropOwn(): void;
  /** Every dated row, and any chunk no own row claims. */
  dropDated(): void;
  /** Every dated row and its chunks. */
  dropDatedFiles(): void;
  clear(): void;
  nsPut(
    parent: string, name: string, kind: number, size: number, mode: number, uid: number, gid: number,
    atime: number, mtime: number, ctime: number, ino: number, rev: number, target: string | null, dev: number, nlink: number,
  ): void;
  nsGet(parent: string, name: string): NsRow | undefined;
  nsDelete(parent: string, name: string): void;
  nsDeleteChildren(parent: string): void;
  nsDeleteParents(from: string, to: string | null): void;
  nsClear(): void;
  nsKeys(): NsKey[];
  nsOfKind(kind: number): NsKey[];
  /** Directories whose entries the listing did not name (namespace unlisted): their target is the mount point. */
  nsUnlisted(): (NsKey & { target: string })[];
  nsChildren(parent: string): NsChild[];
  nsCount(): number;
  pageGet(path: string, rev: number, part: number): Uint8Array | ArrayBuffer | undefined;
  pageUse(path: string, rev: number, part: number, used: number): void;
  /** Hold a page, answering the bytes of the one it replaced (0 for none). */
  pagePut(path: string, rev: number, part: number, bin: Uint8Array, used: number): number;
  pageDelete(path: string, rev: number, part: number): void;
  /** The least recently used pages, `limit` at most. */
  pageOldest(limit: number): PageRow[];
  pageBytes(): number;
  pageMaxUsed(): number;
}

/**
 * The heap backing's own measures. Its namespace rows count against the
 * one-shot's single budget, which the store judges before it puts one
 * (namespace.ts): what a put would add is asked first, and nothing is
 * written for a put the budget refuses.
 */
export interface HeapTables extends ResidentTables {
  /** What the namespace rows take of bytes(). */
  nsBytes(): number;
  /** What putting a row at (parent, name) with `target` would add to bytes() (negative: free). */
  nsGrowth(parent: string, name: string, target: string | null): number;
}

/** workerd's ctx.storage.sql, as far as the store uses it. */
export interface ResidentSql {
  exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
  readonly databaseSize?: number;
}

const num = (value: unknown): number => Number(value);
/**
 * A row as SQLite gives it, with the types its columns hold: every number
 * column INTEGER or REAL, every text column TEXT (NULL only where nullable).
 * Handed over as is, as the store always read it: a lookup allocates no copy.
 */
const rowOf = <T>(rows: Iterable<Record<string, unknown>>): T | undefined => {
  for (const row of rows) return row as T;
  return undefined;
};
const rowsOf = <T>(rows: Iterable<Record<string, unknown>>): T[] => [...rows] as T[];

export function sqlTables(sql: ResidentSql): ResidentTables {
  let schema: string | null = null;
  for (const _row of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")) schema = '';
  if (schema !== null) for (const row of sql.exec("SELECT v FROM meta WHERE k = 'schema'")) schema = String(row.v);
  if (schema !== RESIDENT_SCHEMA) {
    for (const table of ['chunk', 'file', 'ns', 'meta', 'page']) sql.exec('DROP TABLE IF EXISTS ' + table);
  }
  // 'ckey' is the authority's content identity for the bytes (equal keys,
  // equal bytes), when it said so; null for bytes it did not describe.
  sql.exec(
    'CREATE TABLE IF NOT EXISTS file ('
      + 'path TEXT PRIMARY KEY, kind INTEGER NOT NULL, size INTEGER NOT NULL, '
      + 'chunks INTEGER NOT NULL, rev INTEGER NOT NULL CHECK (rev >= -1), ckey TEXT'
    + ')',
  );
  sql.exec('CREATE INDEX IF NOT EXISTS file_ckey ON file (ckey) WHERE ckey IS NOT NULL');
  sql.exec(
    'CREATE TABLE IF NOT EXISTS chunk ('
      + 'path TEXT NOT NULL, part INTEGER NOT NULL, txt TEXT, bin BLOB, '
      + 'PRIMARY KEY (path, part)'
    + ')',
  );
  // Pages of files too big to hold whole, each at the revision it was read
  // at; 'used' orders them for eviction (pages.ts).
  sql.exec(
    'CREATE TABLE IF NOT EXISTS page ('
      + 'path TEXT NOT NULL, rev INTEGER NOT NULL, part INTEGER NOT NULL, bin BLOB NOT NULL, used INTEGER NOT NULL, '
      + 'PRIMARY KEY (path, rev, part)'
    + ') WITHOUT ROWID',
  );
  sql.exec('CREATE INDEX IF NOT EXISTS page_used ON page (used)');
  // The store's own cursor, in the same storage as the rows it describes, so
  // the two cannot be separated by an isolate restart.
  sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)", RESIDENT_SCHEMA);
  // The namespace: every name the process's credential can see, with its stat
  // and no content. Keyed (parent, name) so a point lookup and a directory
  // listing are both one index seek, and no path is stored twice.
  sql.exec(
    'CREATE TABLE IF NOT EXISTS ns ('
      + 'parent TEXT NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL, size INTEGER NOT NULL, '
      + 'mode INTEGER NOT NULL, uid INTEGER NOT NULL, gid INTEGER NOT NULL, atime REAL NOT NULL, '
      + 'mtime REAL NOT NULL, ctime REAL NOT NULL, ino INTEGER NOT NULL, rev INTEGER NOT NULL, target TEXT, '
      + 'dev INTEGER NOT NULL DEFAULT 0, nlink INTEGER NOT NULL DEFAULT 1, '
      + 'PRIMARY KEY (parent, name)'
    + ') WITHOUT ROWID',
  );
  const first = (rows: Iterable<Record<string, unknown>>): Record<string, unknown> | undefined => {
    for (const row of rows) return row;
    return undefined;
  };
  const ranged = (select: string, from: string, to: string | null, tail = '') => (to === null
    ? sql.exec(select + ' WHERE path >= ?' + tail, from)
    : sql.exec(select + ' WHERE path >= ? AND path < ?' + tail, from, to));
  return {
    bytes() {
      const size = sql.databaseSize;
      if (typeof size === 'number' && size > 0) return size;
      for (const row of sql.exec('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')) return num(row.n);
      return 0;
    },
    databaseSize() { return num(sql.databaseSize ?? 0); },
    metaGet(k) { const row = first(sql.exec('SELECT v FROM meta WHERE k = ?', k)); return row === undefined ? undefined : String(row.v); },
    metaSet(k, v) { sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v); },
    fileHead(path) { return rowOf<FileHead>(sql.exec('SELECT kind, size, chunks FROM file WHERE path = ?', path)); },
    fileRev(path) { const row = first(sql.exec('SELECT rev FROM file WHERE path = ?', path)); return row === undefined ? undefined : num(row.rev); },
    fileRevKey(path) { return rowOf<{ rev: number; ckey: string | null }>(sql.exec('SELECT rev, ckey FROM file WHERE path = ?', path)); },
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
      return rowOf<FileByKey>(sql.exec('SELECT path, kind, size, chunks FROM file WHERE ckey = ? AND rev >= 0 AND path <> ? LIMIT 1', ckey, notPath));
    },
    filePaths(from, to) { return [...ranged('SELECT path FROM file', from, to)].map((row) => String(row.path)); },
    fileAny(from, to) { return first(ranged('SELECT path FROM file', from, to, ' LIMIT 1')) !== undefined; },
    fileRevsIn(from, to) { return rowsOf<{ path: string; rev: number }>(ranged('SELECT path, rev FROM file', from, to)); },
    // In key order, as every other scan here is: the primary key's index
    // serves it, and both backings then answer in one order.
    fileAllPaths() { return [...sql.exec('SELECT path FROM file ORDER BY path')].map((row) => String(row.path)); },
    fileRows() { return rowsOf<FileRow>(sql.exec('SELECT path, rev, ckey FROM file ORDER BY path')); },
    fileOwnPaths() { return [...sql.exec('SELECT path FROM file WHERE rev = ? ORDER BY path', RK_OWN_WRITE)].map((row) => String(row.path)); },
    fileStats() { return rowOf<{ n: number; b: number }>(sql.exec('SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM file')); },
    chunkFirst(path) { return rowOf<ChunkRow>(sql.exec('SELECT txt, bin FROM chunk WHERE path = ? AND part = 0', path)); },
    chunkParts(path) { return rowsOf<ChunkRow>(sql.exec('SELECT txt, bin FROM chunk WHERE path = ? ORDER BY part', path)); },
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
      // The schema stamp is the tables', not their rows': without it the next
      // binding would take the store for another schema's and drop it.
      sql.exec("DELETE FROM meta WHERE k <> 'schema'");
      sql.exec('DELETE FROM page');
    },
    pageGet(path, rev, part) {
      return rowOf<{ bin: Uint8Array | ArrayBuffer }>(sql.exec('SELECT bin FROM page WHERE path = ? AND rev = ? AND part = ?', path, rev, part))?.bin;
    },
    pageUse(path, rev, part, used) { sql.exec('UPDATE page SET used = ? WHERE path = ? AND rev = ? AND part = ?', used, path, rev, part); },
    pagePut(path, rev, part, bin, used) {
      const had = first(sql.exec('SELECT length(bin) AS n FROM page WHERE path = ? AND rev = ? AND part = ?', path, rev, part));
      sql.exec('INSERT OR REPLACE INTO page (path, rev, part, bin, used) VALUES (?, ?, ?, ?, ?)', path, rev, part, bin, used);
      return had === undefined ? 0 : num(had.n);
    },
    pageDelete(path, rev, part) { sql.exec('DELETE FROM page WHERE path = ? AND rev = ? AND part = ?', path, rev, part); },
    pageOldest(limit) { return rowsOf<PageRow>(sql.exec('SELECT path, rev, part, length(bin) AS size FROM page ORDER BY used, path, rev, part LIMIT ?', limit)); },
    pageBytes() { const row = first(sql.exec('SELECT coalesce(sum(length(bin)), 0) AS n FROM page')); return row === undefined ? 0 : num(row.n); },
    pageMaxUsed() { const row = first(sql.exec('SELECT coalesce(max(used), 0) AS n FROM page')); return row === undefined ? 0 : num(row.n); },
    nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
      sql.exec(
        'INSERT OR REPLACE INTO ns (parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, Number(dev) || 0, Number(nlink) || 1,
      );
    },
    nsGet(parent, name) {
      return rowOf<NsRow>(sql.exec(
        'SELECT kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink FROM ns WHERE parent = ? AND name = ?',
        parent, name,
      ));
    },
    nsDelete(parent, name) { sql.exec('DELETE FROM ns WHERE parent = ? AND name = ?', parent, name); },
    nsDeleteChildren(parent) { sql.exec('DELETE FROM ns WHERE parent = ?', parent); },
    nsDeleteParents(from, to) {
      if (to === null) sql.exec('DELETE FROM ns WHERE parent >= ?', from);
      else sql.exec('DELETE FROM ns WHERE parent >= ? AND parent < ?', from, to);
    },
    nsClear() { sql.exec('DELETE FROM ns'); },
    nsKeys() { return rowsOf<NsKey>(sql.exec('SELECT parent, name FROM ns')); },
    nsOfKind(kind) { return rowsOf<NsKey>(sql.exec('SELECT parent, name FROM ns WHERE kind = ?', kind)); },
    nsUnlisted() { return rowsOf<NsKey & { target: string }>(sql.exec('SELECT parent, name, target FROM ns WHERE kind = ? AND target IS NOT NULL', NS_DIR)); },
    nsChildren(parent) { return rowsOf<NsChild>(sql.exec('SELECT name, kind, mode FROM ns WHERE parent = ?', parent)); },
    nsCount() { const row = first(sql.exec('SELECT count(*) AS n FROM ns')); return row === undefined ? 0 : num(row.n); },
  };
}

interface HeapFile { kind: number; size: number; chunks: number; rev: number; ckey: string | null }
interface HeapChunk { txt: string | null; bin: Uint8Array | null }

/**
 * The one-shot backing: the same tables, in the process's heap, for the life
 * of one run. A one-shot is hosted by runOnce, which gives it no SQLite, and
 * it keeps nothing after it exits. Its answers are the SQLite backing's:
 * scans come back in key order (a b-tree's), reads hand back copies (a
 * program that writes into a Buffer it read must not change the store), and
 * `bytes()` counts what it holds in the units residentCellCost charges (a
 * row, and the payload's bytes), so the store's one budget rule serves both.
 */
export function heapTables(): HeapTables {
  // What a read asks (a row, a file's head, its first chunk) goes through
  // SafeMap's methods, as the launch captured them: module loading reads
  // here after a program may have replaced Map.prototype.get.
  const files = new SafeMap<string, HeapFile>();
  const chunks = new SafeMap<string, SafeMap<number, HeapChunk>>();
  const meta = new SafeMap<string, string>();
  const ns = new SafeMap<string, SafeMap<string, NsRow>>();
  const byKey = new SafeMap<string, SafeSet<string>>();
  // Pages by "path\0rev\0part".
  const pages = new SafeMap<string, { path: string; rev: number; part: number; bin: Uint8Array; used: number }>();
  const pageKey = (path: string, rev: number, part: number): string => path + '\u0000' + rev + '\u0000' + part;
  let sorted: SafeList<string> | null = null;
  let used = 0;
  let names = 0;
  let namespaceBytes = 0;
  // SQLite's binary collation orders TEXT by its UTF-8 bytes: code-point
  // order, which UTF-16 comparison is not past the BMP.
  const cmp = (a: string, b: string): number => {
    const n = mathMin(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = stringCodePointAt(a, i) ?? 0, y = stringCodePointAt(b, i) ?? 0;
      if (x !== y) return x < y ? -1 : 1;
      if (x > 0xffff) i++;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  };
  const payload = (cell: HeapChunk): number => (cell.txt != null ? utf8Length(cell.txt) : cell.bin ? typedArrayByteLength(cell.bin) : 0);
  const unkey = (path: string, row: HeapFile | undefined): void => {
    if (row && row.ckey != null) {
      const set = byKey.get(row.ckey);
      if (set) { set.delete(path); if (set.size === 0) byKey.delete(row.ckey); }
    }
  };
  const paths = (): SafeList<string> => {
    if (sorted === null) {
      const list = new SafeList<string>();
      files.forEach((_row, path) => { list[list.length] = path; });
      sorted = arraySort(list, cmp);
    }
    return sorted;
  };
  const lowerBound = (list: string[], from: string): number => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cmp(list[mid], from) < 0) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const inRange = (from: string, to: string | null): SafeList<string> => {
    const list = paths();
    const out = new SafeList<string>();
    for (let i = lowerBound(list, from); i < list.length && (to === null || cmp(list[i], to) < 0); i++) out[out.length] = list[i];
    return out;
  };
  const copy = (cell: HeapChunk): ChunkRow => ({ txt: cell.txt ?? null, bin: cell.bin ? new Uint8ArrayConstructor(cell.bin) : null });
  // Bytes given to the table are its own from then on, as SQLite's are once
  // inserted: nothing that gives them changes them after (the shims' cells
  // are copies of what a program wrote, never changed within their length;
  // a fill's are the session's answer). A view into a larger buffer is
  // copied, so the table holds no more memory than it counts.
  const owned = (bin: unknown): Uint8Array => {
    const bytes = residentBytes(bin);
    return typedArrayByteOffset(bytes) === 0 && typedArrayByteLength(bytes) === arrayBufferByteLength(typedArrayBuffer(bytes))
      ? bytes : new Uint8ArrayConstructor(bytes);
  };
  const dropChunks = (path: string): void => {
    const parts = chunks.get(path);
    if (!parts) return;
    parts.forEach((cell) => { used -= RESIDENT_ROW_BYTES + payload(cell); });
    chunks.delete(path);
  };
  const dropFile = (path: string): void => {
    const row = files.get(path);
    if (row === undefined) return;
    unkey(path, row);
    files.delete(path);
    sorted = null;
    used -= RESIDENT_ROW_BYTES;
  };
  const addChunk = (path: string, part: number, cell: HeapChunk, replace: boolean): void => {
    let parts = chunks.get(path);
    if (!parts) { parts = new SafeMap(); chunks.set(path, parts); }
    const had = parts.get(part);
    if (had !== undefined) {
      if (!replace) throw new Error('UNIQUE constraint failed: chunk.path, chunk.part');
      used -= RESIDENT_ROW_BYTES + payload(had);
    }
    parts.set(part, cell);
    used += RESIDENT_ROW_BYTES + payload(cell);
  };
  const nsGetRow = (parent: string, name: string): NsRow | undefined => { const dir = ns.get(parent); return dir ? dir.get(name) : undefined; };
  const nsDrop = (parent: string, name: string): void => {
    const dir = ns.get(parent);
    const row = dir?.get(name);
    if (dir === undefined || row === undefined) return;
    dir.delete(name);
    names--;
    const bytes = namespaceRowBytes(parent, name, row.target);
    used -= bytes; namespaceBytes -= bytes;
    if (dir.size === 0) ns.delete(parent);
  };
  const nsDropParent = (parent: string): void => {
    const dir = ns.get(parent);
    if (!dir) return;
    names -= dir.size;
    dir.forEach((row, name) => {
      const bytes = namespaceRowBytes(parent, name, row.target);
      used -= bytes; namespaceBytes -= bytes;
    });
    ns.delete(parent);
  };
  const dropWhere = (keepFile: (row: HeapFile) => boolean, keepChunkPath: (path: string) => boolean): void => {
    chunks.forEach((_parts, path) => { if (!keepChunkPath(path)) dropChunks(path); });
    files.forEach((row, path) => { if (!keepFile(row)) dropFile(path); });
  };
  const sortedNames = <V>(dir: SafeMap<string, V>): SafeList<string> => {
    const out = new SafeList<string>();
    dir.forEach((_row, name) => { out[out.length] = name; });
    return arraySort(out, cmp);
  };
  return {
    bytes() { return used; },
    databaseSize() { return used; },
    metaGet(k) { return meta.get(k); },
    metaSet(k, v) { meta.set(k, stringOf(v)); },
    fileHead(path) { const row = files.get(path); return row === undefined ? undefined : { kind: row.kind, size: row.size, chunks: row.chunks }; },
    fileRev(path) { const row = files.get(path); return row === undefined ? undefined : row.rev; },
    fileRevKey(path) { const row = files.get(path); return row === undefined ? undefined : { rev: row.rev, ckey: row.ckey }; },
    fileOwnSize(path) { const row = files.get(path); return row !== undefined && row.rev === RK_OWN_WRITE ? row.size : undefined; },
    filePut(path, kind, size, chunkCount, rev, ckey) {
      if (!(rev >= -1)) throw new Error('CHECK constraint failed: rev >= -1');
      const had = files.get(path);
      if (had === undefined) { sorted = null; used += RESIDENT_ROW_BYTES; } else unkey(path, had);
      const row: HeapFile = { kind: NumberOf(kind), size: NumberOf(size), chunks: NumberOf(chunkCount), rev: NumberOf(rev), ckey: ckey == null ? null : stringOf(ckey) };
      files.set(path, row);
      if (row.ckey !== null) { let set = byKey.get(row.ckey); if (!set) { set = new SafeSet(); byKey.set(row.ckey, set); } set.add(path); }
    },
    fileSetRev(path, rev) { const row = files.get(path); if (row !== undefined) row.rev = NumberOf(rev); },
    fileStampOwn(path, rev) { const row = files.get(path); if (row !== undefined && row.rev === RK_OWN_WRITE) row.rev = NumberOf(rev); },
    fileDelete(path) { dropFile(path); },
    fileByKey(ckey, notPath) {
      const set = byKey.get(stringOf(ckey));
      if (!set) return undefined;
      let found: FileByKey | undefined;
      set.forEach((path) => {
        if (found !== undefined) return;
        const row = files.get(path);
        if (path !== notPath && row && row.rev >= 0) found = { path, kind: row.kind, size: row.size, chunks: row.chunks };
      });
      return found;
    },
    filePaths(from, to) { return arrayCopy(inRange(from, to)); },
    fileAny(from, to) { const list = paths(); const i = lowerBound(list, from); return i < list.length && (to === null || cmp(list[i], to) < 0); },
    fileRevsIn(from, to) {
      const list = inRange(from, to);
      const out = new SafeList<{ path: string; rev: number }>();
      for (let i = 0; i < list.length; i++) {
        const path = list[i];
        const row = files.get(path);
        if (row !== undefined) out[out.length] = { path, rev: row.rev };
      }
      return arrayCopy(out);
    },
    fileAllPaths() { return arrayCopy(paths()); },
    fileRows() {
      const list = paths();
      const out = new SafeList<FileRow>();
      for (let i = 0; i < list.length; i++) {
        const path = list[i];
        const row = files.get(path);
        if (row !== undefined) out[out.length] = { path, rev: row.rev, ckey: row.ckey };
      }
      return arrayCopy(out);
    },
    fileOwnPaths() {
      const list = paths();
      const out = new SafeList<string>();
      for (let i = 0; i < list.length; i++) if (files.get(list[i])?.rev === RK_OWN_WRITE) out[out.length] = list[i];
      return arrayCopy(out);
    },
    fileStats() { let b = 0; files.forEach((row) => { b += row.size; }); return { n: files.size, b }; },
    chunkFirst(path) { const parts = chunks.get(path); const cell = parts && parts.get(0); return cell === undefined ? undefined : copy(cell); },
    chunkParts(path) {
      const parts = chunks.get(path);
      if (!parts) return [];
      // In part order, through the captures (module loading reads a large file's parts here).
      const numbers = new SafeList<number>();
      parts.forEach((_cell, part) => { numbers[numbers.length] = part; });
      arraySort(numbers, (a, b) => a - b);
      const out = new SafeList<ChunkRow>();
      for (let i = 0; i < numbers.length; i++) {
        const cell = parts.get(numbers[i]);
        if (cell !== undefined) out[out.length] = copy(cell);
      }
      return arrayCopy(out);
    },
    chunkAddText(path, part, txt) { addChunk(path, NumberOf(part), { txt: stringOf(txt), bin: null }, false); },
    chunkAddBin(path, part, bin) { addChunk(path, NumberOf(part), { txt: null, bin: owned(bin) }, false); },
    chunkSetBin(path, part, bin) { addChunk(path, NumberOf(part), { txt: null, bin: owned(bin) }, true); },
    chunkCopy(to, from) {
      const parts = chunks.get(from);
      if (!parts) return;
      // One statement in SQLite: a conflicting part fails the whole copy, and nothing lands.
      const held = chunks.get(to);
      if (held) parts.forEach((_cell, part) => { if (held.has(part)) throw new Error('UNIQUE constraint failed: chunk.path, chunk.part'); });
      parts.forEach((cell, part) => { addChunk(to, part, { txt: cell.txt, bin: cell.bin }, false); });
    },
    chunkDelete(path) { dropChunks(path); },
    dropOwn() {
      const own = new SafeSet<string>();
      files.forEach((row, path) => { if (row.rev === RK_OWN_WRITE) own.add(path); });
      dropWhere((row) => row.rev !== RK_OWN_WRITE, (path) => !own.has(path));
    },
    dropDated() {
      const own = new SafeSet<string>();
      files.forEach((row, path) => { if (row.rev === RK_OWN_WRITE) own.add(path); });
      dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => own.has(path));
    },
    dropDatedFiles() {
      const dated = new SafeSet<string>();
      files.forEach((row, path) => { if (row.rev !== RK_OWN_WRITE) dated.add(path); });
      dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => !dated.has(path));
    },
    clear() {
      files.clear(); chunks.clear(); meta.clear(); ns.clear(); byKey.clear(); pages.clear();
      sorted = null; used = 0; names = 0; namespaceBytes = 0;
    },
    pageGet(path, rev, part) { return pages.get(pageKey(path, rev, part))?.bin.slice(); },
    pageUse(path, rev, part, stamp) {
      const row = pages.get(pageKey(path, rev, part));
      if (row !== undefined) row.used = stamp;
    },
    pagePut(path, rev, part, bin, stamp) {
      const key = pageKey(path, rev, part);
      const had = pages.get(key);
      const bytes = residentBytes(bin).slice();
      if (had !== undefined) used -= RESIDENT_ROW_BYTES + had.bin.byteLength;
      pages.set(key, { path, rev, part, bin: bytes, used: stamp });
      used += RESIDENT_ROW_BYTES + bytes.byteLength;
      return had === undefined ? 0 : had.bin.byteLength;
    },
    pageDelete(path, rev, part) {
      const key = pageKey(path, rev, part);
      const had = pages.get(key);
      if (had === undefined) return;
      pages.delete(key);
      used -= RESIDENT_ROW_BYTES + had.bin.byteLength;
    },
    pageOldest(limit) {
      // SQLite's ORDER BY used, path, rev, part.
      const rows = [...pages.values()].sort((a, b) => a.used - b.used || cmp(a.path, b.path) || a.rev - b.rev || a.part - b.part);
      return rows.slice(0, limit).map((row) => ({ path: row.path, rev: row.rev, part: row.part, size: row.bin.byteLength }));
    },
    pageBytes() { let n = 0; for (const row of pages.values()) n += row.bin.byteLength; return n; },
    pageMaxUsed() { let n = 0; for (const row of pages.values()) n = Math.max(n, row.used); return n; },
    nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
      let dir = ns.get(parent);
      const previous = dir?.get(name);
      const bytes = namespaceRowBytes(parent, name, target);
      const growth = bytes - (previous === undefined ? 0 : namespaceRowBytes(parent, name, previous.target));
      if (!dir) { dir = new SafeMap(); ns.set(parent, dir); }
      if (previous === undefined) names++;
      used += growth; namespaceBytes += growth;
      dir.set(name, {
        kind: NumberOf(kind), size: NumberOf(size), mode: NumberOf(mode), uid: NumberOf(uid), gid: NumberOf(gid),
        atime: NumberOf(atime), mtime: NumberOf(mtime), ctime: NumberOf(ctime), ino: NumberOf(ino), rev: NumberOf(rev),
        target: target == null ? null : stringOf(target), dev: NumberOf(dev) || 0, nlink: NumberOf(nlink) || 1,
      });
    },
    nsGet(parent, name) { const row = nsGetRow(parent, name); return row === undefined ? undefined : { ...row }; },
    nsDelete(parent, name) { nsDrop(parent, name); },
    nsDeleteChildren(parent) { nsDropParent(parent); },
    nsDeleteParents(from, to) {
      ns.forEach((_dir, parent) => { if (cmp(parent, from) >= 0 && (to === null || cmp(parent, to) < 0)) nsDropParent(parent); });
    },
    nsClear() { used -= namespaceBytes; names = 0; namespaceBytes = 0; ns.clear(); },
    nsBytes() { return namespaceBytes; },
    nsGrowth(parent, name, target) {
      const previous = nsGetRow(parent, name);
      return namespaceRowBytes(parent, name, target) - (previous === undefined ? 0 : namespaceRowBytes(parent, name, previous.target));
    },
    nsKeys() {
      const out = new SafeList<NsKey>();
      const parents = sortedNames(ns);
      for (let i = 0; i < parents.length; i++) {
        const parent = parents[i];
        const dir = ns.get(parent);
        if (dir === undefined) continue;
        const list = sortedNames(dir);
        for (let j = 0; j < list.length; j++) out[out.length] = { parent, name: list[j] };
      }
      return arrayCopy(out);
    },
    nsOfKind(kind) {
      const out = new SafeList<NsKey>();
      const parents = sortedNames(ns);
      const code = NumberOf(kind);
      for (let i = 0; i < parents.length; i++) {
        const parent = parents[i];
        const dir = ns.get(parent);
        if (dir === undefined) continue;
        const list = sortedNames(dir);
        for (let j = 0; j < list.length; j++) {
          const name = list[j];
          if (dir.get(name)?.kind === code) out[out.length] = { parent, name };
        }
      }
      return arrayCopy(out);
    },
    nsUnlisted() {
      const out = new SafeList<NsKey & { target: string }>();
      const parents = sortedNames(ns);
      for (let i = 0; i < parents.length; i++) {
        const parent = parents[i];
        const dir = ns.get(parent);
        if (dir === undefined) continue;
        const list = sortedNames(dir);
        for (let j = 0; j < list.length; j++) {
          const name = list[j];
          const row = dir.get(name);
          if (row !== undefined && row.kind === NS_DIR && row.target !== null) out[out.length] = { parent, name, target: row.target };
        }
      }
      return arrayCopy(out);
    },
    nsChildren(parent) {
      const dir = ns.get(parent);
      if (!dir) return [];
      const list = sortedNames(dir);
      const out = new SafeList<NsChild>();
      for (let i = 0; i < list.length; i++) {
        const name = list[i];
        const row = dir.get(name);
        if (row !== undefined) out[out.length] = { name, kind: row.kind, mode: row.mode };
      }
      return arrayCopy(out);
    },
    nsCount() { return names; },
  };
}
