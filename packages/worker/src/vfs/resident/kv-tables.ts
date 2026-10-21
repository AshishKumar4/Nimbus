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

import { RK_OWN_WRITE, NS_DIR, RESIDENT_SCHEMA, type ChunkRow, type FileByKey, type FileHead, type FileRow, type NsChild, type NsKey, type NsRow, type PageRow, type ResidentTables, type RowsChanged } from './tables.js';
import { residentBytes } from './cell-cost.js';
import { Error, NumberOf, SafeList, SafeSet, StringFromCharCode, arrayCopy, stringOf } from '@nimbus-sh/core/_shared/primordials.js';

/** What the store uses of a SQLite-backed Durable Object's storage (ctx.storage). */
export interface ResidentKv {
  readonly kv: {
    get(key: string): unknown;
    list(options?: { start?: string; end?: string; prefix?: string; reverse?: boolean; limit?: number }): Iterable<[string, unknown]>;
  };
  put(key: string, value: unknown, options: { allowUnconfirmed: boolean }): unknown;
  delete(keys: string | string[], options: { allowUnconfirmed: boolean }): unknown;
  /** The facet's SQL, the same database: its size is the store's (bytes()); an earlier Nimbus's store tables are dropped from it (store.bind). */
  readonly sql?: { readonly databaseSize?: number; exec?(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> };
}

const UNCONFIRMED = { allowUnconfirmed: true };
/** The most keys one delete takes (the storage API's bound). */
const DELETE_BATCH = 128;
/**
 * A key's text parts (a path, a name, a content key) are encoded so that no
 * part holds SEP and every encoded part sorts above it: NUL and U+0001 become
 * U+0001 followed by U+0002 and U+0003, every other character stands for
 * itself. The encoding keeps order (each character's encoding sorts as the
 * character does, and none is a prefix of another), so a composite key sorts
 * as its parts do, (parent, name), and a range of raw parts is the range of
 * their encodings. Every key and every range bound goes through encodePart,
 * and every part read back from a key through decodePart.
 */
const SEP = '\u0001\u0001';
const RESERVED = /[\u0000\u0001]/;
const encodePart = (text: string): string => (RESERVED.test(text) ? text.replace(/[\u0000\u0001]/g, (c) => (c === '\u0000' ? '\u0001\u0002' : '\u0001\u0003')) : text);
const decodePart = (text: string): string => (text.indexOf('\u0001') < 0 ? text : text.replace(/\u0001[\u0002\u0003]/g, (c) => (c === '\u0001\u0002' ? '\u0000' : '\u0001')));
/** Decimal, padded past Number.MAX_SAFE_INTEGER's 16 digits: key order is numeric order. */
const pad = (n: number): string => stringOf(NumberOf(n)).padStart(17, '0');

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
const END = { [FILE]: StringFromCharCode(0x47), [NS]: StringFromCharCode(0x4f) } as const;

/**
 * A file's head row: [kind, size, chunks, rev, ckey, seq]. `seq` orders the
 * rows of one content key by when their head was made (a new head is the
 * latest; a revision change keeps its place), as the heap's set does, so
 * fileByKey picks the same file in both.
 */
type FileValue = [number, number, number, number, string | null, number];
/** A page's row, kept apart from its bytes: [used, size]. */
type PageValue = [number, number];

export function kvTables(storage: ResidentKv, rowsChanged: RowsChanged = () => {}): ResidentTables {
  const writeRows = (path: string | undefined, write: () => void): void => {
    rowsChanged(path);
    write();
  };
  const kv = storage.kv;
  const put = (key: string, value: unknown): void => { storage.put(key, value, UNCONFIRMED); };
  const drop = (keys: SafeList<string>): void => {
    let batch = new SafeList<string>();
    for (let i = 0; i < keys.length; i++) {
      batch[batch.length] = keys[i];
      if (batch.length === DELETE_BATCH) { storage.delete(arrayCopy(batch), UNCONFIRMED); batch = new SafeList<string>(); }
    }
    if (batch.length > 0) storage.delete(arrayCopy(batch), UNCONFIRMED);
  };
  const dropOne = (key: string): void => { storage.delete(key, UNCONFIRMED); };
  const keysOf = (options: { start?: string; end?: string; prefix?: string; reverse?: boolean; limit?: number }): SafeList<string> => {
    const out = new SafeList<string>();
    for (const [key] of kv.list(options)) out[out.length] = key;
    return out;
  };
  const rangeOf = (tag: typeof FILE | typeof NS, from: string, to: string | null): { start: string; end: string } => ({
    start: tag + encodePart(from), end: to === null ? END[tag] : tag + encodePart(to),
  });

  const fileKey = (path: string): string => FILE + encodePart(path);
  const fileOf = (path: string): FileValue | undefined => kv.get(fileKey(path)) as FileValue | undefined;
  const chunkKey = (path: string, n: number): string => CHUNK + encodePart(path) + SEP + pad(n);
  const chunkIndex = (path: string, n: number): string => CHUNK_KEYS + encodePart(path) + SEP + pad(n);
  const byKeyPrefix = (ckey: string): string => BY_CKEY + encodePart(ckey) + SEP;
  const byKey = (row: FileValue, path: string): string => byKeyPrefix(row[4] as string) + pad(row[5]) + SEP + encodePart(path);
  const nsKey = (parent: string, name: string): string => NS + encodePart(parent) + SEP + encodePart(name);
  const nsChildren = (parent: string): string => NS + encodePart(parent) + SEP;
  const pageTail = (path: string, rev: number, n: number): string => encodePart(path) + SEP + pad(rev) + SEP + pad(n);
  /** Each number in a page's key: SEP, then 17 digits. */
  const NUMBER = SEP.length + 17;
  const unpage = (tail: string): { path: string; rev: number; part: number } => {
    const at = tail.length - 2 * NUMBER;
    return { path: decodePart(tail.slice(0, at)), rev: NumberOf(tail.slice(at + SEP.length, at + NUMBER)), part: NumberOf(tail.slice(at + NUMBER + SEP.length)) };
  };
  const chunkRow = (value: unknown): ChunkRow => (typeof value === 'string' ? { txt: value, bin: null } : { txt: null, bin: value as Uint8Array });

  /** A new head row for `path`, its rowid the highest (INSERT OR REPLACE). */
  const setFile = (path: string, kind: number, size: number, chunks: number, rev: number, ckey: string | null): void => {
    const had = fileOf(path);
    if (had !== undefined && had[4] !== null) dropOne(byKey(had, path));
    const seq = NumberOf(kv.get(SEQ) ?? 0) + 1;
    put(SEQ, seq);
    const row: FileValue = [kind, size, chunks, rev, ckey, seq];
    put(fileKey(path), row);
    if (ckey !== null) put(byKey(row, path), 1);
  };
  /** `path`'s head row with `rev`, its rowid kept (UPDATE). */
  const setRev = (path: string, row: FileValue, rev: number): void => { put(fileKey(path), [row[0], row[1], row[2], NumberOf(rev), row[4], row[5]]); };
  const deleteFile = (path: string): void => {
    const had = fileOf(path);
    if (had === undefined) return;
    if (had[4] !== null) dropOne(byKey(had, path));
    dropOne(fileKey(path));
  };
  const deleteChunks = (path: string): void => {
    const parts = keysOf({ prefix: CHUNK_KEYS + encodePart(path) + SEP });
    const keys = new SafeList<string>();
    for (let i = 0; i < parts.length; i++) {
      keys[keys.length] = parts[i];
      keys[keys.length] = CHUNK + parts[i].slice(1);
    }
    drop(keys);
  };
  const addChunk = (path: string, part: number, value: unknown, replace: boolean): void => {
    const index = chunkIndex(path, part);
    if (!replace && kv.get(index) !== undefined) throw new Error('UNIQUE constraint failed: chunk.path, chunk.part');
    put(chunkKey(path, part), value);
    put(index, 1);
  };
  /** Every file row, in key order: [path, row]. */
  const files = (): SafeList<[string, FileValue]> => {
    const out = new SafeList<[string, FileValue]>();
    for (const [key, value] of kv.list({ prefix: FILE })) out[out.length] = [decodePart(key.slice(1)), value as FileValue];
    return out;
  };
  /** Every path that has chunk rows, in key order. */
  const chunkPaths = (): SafeList<string> => {
    const out = new SafeList<string>();
    let last: string | null = null;
    for (const [key] of kv.list({ prefix: CHUNK_KEYS })) {
      const path = decodePart(key.slice(1, key.lastIndexOf(SEP)));
      if (path !== last) { out[out.length] = path; last = path; }
    }
    return out;
  };
  const dropWhere = (keepFile: (row: FileValue) => boolean, keepChunkPath: (path: string) => boolean): void => writeRows(undefined, () => {
    const paths = chunkPaths();
    for (let i = 0; i < paths.length; i++) if (!keepChunkPath(paths[i])) deleteChunks(paths[i]);
    const rows = files();
    for (let i = 0; i < rows.length; i++) if (!keepFile(rows[i][1])) deleteFile(rows[i][0]);
  });
  const ownPaths = (): SafeSet<string> => {
    const own = new SafeSet<string>();
    const rows = files();
    for (let i = 0; i < rows.length; i++) if (rows[i][1][3] === RK_OWN_WRITE) own.add(rows[i][0]);
    return own;
  };
  const nsRows = (options: { prefix?: string; start?: string; end?: string }): SafeList<[NsKey, NsRow]> => {
    const out = new SafeList<[NsKey, NsRow]>();
    for (const [key, value] of kv.list(options)) {
      const at = key.indexOf(SEP);
      out[out.length] = [{ parent: decodePart(key.slice(1, at)), name: decodePart(key.slice(at + SEP.length)) }, value as NsRow];
    }
    return out;
  };
  const deleteKeys = (options: { prefix?: string; start?: string; end?: string }): void => drop(keysOf(options));

  if (kv.get(META + 'schema') !== RESIDENT_SCHEMA) {
    for (const tag of [FILE, CHUNK, CHUNK_KEYS, BY_CKEY, NS, PAGE, PAGE_ROWS, PAGE_USED, META]) deleteKeys({ prefix: tag });
    put(META + 'schema', RESIDENT_SCHEMA);
  }

  return {
    bytes() { return NumberOf(storage.sql?.databaseSize ?? 0); },
    databaseSize() { return NumberOf(storage.sql?.databaseSize ?? 0); },
    metaGet(k) { const v = kv.get(META + k); return v === undefined ? undefined : stringOf(v); },
    metaSet(k, v) { put(META + k, stringOf(v)); },
    fileHead(path) { const row = fileOf(path); return row === undefined ? undefined : { kind: row[0], size: row[1], chunks: row[2] } satisfies FileHead; },
    fileRev(path) { return fileOf(path)?.[3]; },
    fileRevKey(path) { const row = fileOf(path); return row === undefined ? undefined : { rev: row[3], ckey: row[4] }; },
    fileOwnSize(path) { const row = fileOf(path); return row !== undefined && row[3] === RK_OWN_WRITE ? row[1] : undefined; },
    filePut(path, kind, size, chunks, rev, ckey) {
      if (!(rev >= -1)) throw new Error('CHECK constraint failed: rev >= -1');
      writeRows(path, () => { setFile(path, NumberOf(kind), NumberOf(size), NumberOf(chunks), NumberOf(rev), ckey == null ? null : stringOf(ckey)); });
    },
    fileSetRev(path, rev) {
      writeRows(path, () => { const row = fileOf(path); if (row !== undefined) setRev(path, row, rev); });
    },
    fileStampOwn(path, rev) {
      writeRows(path, () => {
        const row = fileOf(path);
        if (row !== undefined && row[3] === RK_OWN_WRITE) setRev(path, row, rev);
      });
    },
    fileDelete(path) { writeRows(path, () => { deleteFile(path); }); },
    fileByKey(ckey, notPath) {
      // The first that can be copied, in the ckey index's order (seq).
      const prefix = byKeyPrefix(stringOf(ckey));
      for (const [key] of kv.list({ prefix })) {
        const path = decodePart(key.slice(prefix.length + NUMBER));
        if (path === notPath) continue;
        const row = fileOf(path);
        if (row !== undefined && row[3] >= 0) return { path, kind: row[0], size: row[1], chunks: row[2] } satisfies FileByKey;
      }
      return undefined;
    },
    filePaths(from, to) {
      const out = new SafeList<string>();
      for (const [key] of kv.list(rangeOf(FILE, from, to))) out[out.length] = decodePart(key.slice(1));
      return arrayCopy(out);
    },
    fileAny(from, to) { for (const _entry of kv.list({ ...rangeOf(FILE, from, to), limit: 1 })) return true; return false; },
    fileRevsIn(from, to) {
      const out = new SafeList<{ path: string; rev: number }>();
      for (const [key, value] of kv.list(rangeOf(FILE, from, to))) out[out.length] = { path: decodePart(key.slice(1)), rev: (value as FileValue)[3] };
      return arrayCopy(out);
    },
    fileAllPaths() { const rows = files(); const out = new SafeList<string>(); for (let i = 0; i < rows.length; i++) out[out.length] = rows[i][0]; return arrayCopy(out); },
    fileRows() {
      const rows = files();
      const out = new SafeList<FileRow>();
      for (let i = 0; i < rows.length; i++) out[out.length] = { path: rows[i][0], rev: rows[i][1][3], ckey: rows[i][1][4] };
      return arrayCopy(out);
    },
    fileOwnPaths() {
      const rows = files();
      const out = new SafeList<string>();
      for (let i = 0; i < rows.length; i++) if (rows[i][1][3] === RK_OWN_WRITE) out[out.length] = rows[i][0];
      return arrayCopy(out);
    },
    fileStats() {
      const rows = files();
      let b = 0;
      for (let i = 0; i < rows.length; i++) b += rows[i][1][1];
      return { n: rows.length, b };
    },
    chunkFirst(path) { const value = kv.get(chunkKey(path, 0)); return value === undefined ? undefined : chunkRow(value); },
    chunkParts(path) {
      const out = new SafeList<ChunkRow>();
      for (const [, value] of kv.list({ prefix: CHUNK + encodePart(path) + SEP })) out[out.length] = chunkRow(value);
      return arrayCopy(out);
    },
    chunkAddText(path, part, txt) { addChunk(path, NumberOf(part), stringOf(txt), false); },
    chunkAddBin(path, part, bin) { addChunk(path, NumberOf(part), residentBytes(bin).slice(), false); },
    chunkSetBin(path, part, bin) { addChunk(path, NumberOf(part), residentBytes(bin).slice(), true); },
    chunkCopy(to, from) {
      const parts = new SafeList<[string, unknown]>();
      for (const [key, value] of kv.list({ prefix: CHUNK + encodePart(from) + SEP })) parts[parts.length] = [key.slice(key.lastIndexOf(SEP) + SEP.length), value];
      // One step: a conflicting part fails the whole copy, and nothing lands.
      for (let i = 0; i < parts.length; i++) {
        if (kv.get(CHUNK_KEYS + encodePart(to) + SEP + parts[i][0]) !== undefined) throw new Error('UNIQUE constraint failed: chunk.path, chunk.part');
      }
      for (let i = 0; i < parts.length; i++) {
        put(CHUNK + encodePart(to) + SEP + parts[i][0], parts[i][1]);
        put(CHUNK_KEYS + encodePart(to) + SEP + parts[i][0], 1);
      }
    },
    chunkDelete(path) { writeRows(path, () => { deleteChunks(path); }); },
    dropOwn() { const own = ownPaths(); dropWhere((row) => row[3] !== RK_OWN_WRITE, (path) => !own.has(path)); },
    dropDated() { const own = ownPaths(); dropWhere((row) => row[3] === RK_OWN_WRITE, (path) => own.has(path)); },
    dropDatedFiles() {
      const dated = new SafeSet<string>();
      const rows = files();
      for (let i = 0; i < rows.length; i++) if (rows[i][1][3] !== RK_OWN_WRITE) dated.add(rows[i][0]);
      dropWhere((row) => row[3] === RK_OWN_WRITE, (path) => !dated.has(path));
    },
    clear() {
      writeRows(undefined, () => { for (const tag of [CHUNK, CHUNK_KEYS, FILE, BY_CKEY]) deleteKeys({ prefix: tag }); });
      for (const tag of [NS, PAGE, PAGE_ROWS, PAGE_USED]) deleteKeys({ prefix: tag });
      // The schema stamp is the tables', not their rows'.
      const meta = keysOf({ prefix: META });
      const keep = new SafeList<string>();
      for (let i = 0; i < meta.length; i++) if (meta[i] !== META + 'schema') keep[keep.length] = meta[i];
      drop(keep);
    },
    pageGet(path, rev, part) { const value = kv.get(PAGE + pageTail(path, rev, part)); return value === undefined ? undefined : (value as Uint8Array); },
    pageUse(path, rev, part, used) {
      const tail = pageTail(path, rev, part);
      const row = kv.get(PAGE_ROWS + tail) as PageValue | undefined;
      if (row === undefined) return;
      dropOne(PAGE_USED + pad(row[0]) + SEP + tail);
      put(PAGE_USED + pad(used) + SEP + tail, row[1]);
      put(PAGE_ROWS + tail, [NumberOf(used), row[1]]);
    },
    pagePut(path, rev, part, bin, used) {
      const tail = pageTail(path, rev, part);
      const had = kv.get(PAGE_ROWS + tail) as PageValue | undefined;
      const bytes = residentBytes(bin).slice();
      if (had !== undefined) dropOne(PAGE_USED + pad(had[0]) + SEP + tail);
      put(PAGE + tail, bytes);
      put(PAGE_ROWS + tail, [NumberOf(used), bytes.byteLength]);
      put(PAGE_USED + pad(used) + SEP + tail, bytes.byteLength);
      return had === undefined ? 0 : had[1];
    },
    pageDelete(path, rev, part) {
      const tail = pageTail(path, rev, part);
      const had = kv.get(PAGE_ROWS + tail) as PageValue | undefined;
      if (had === undefined) return;
      const keys = new SafeList<string>();
      keys[0] = PAGE + tail; keys[1] = PAGE_ROWS + tail; keys[2] = PAGE_USED + pad(had[0]) + SEP + tail;
      drop(keys);
    },
    pageOldest(limit) {
      // Least recently used first; ties by path, rev, part: the index's key order.
      const out = new SafeList<PageRow>();
      for (const [key, value] of kv.list({ prefix: PAGE_USED, limit })) {
        const { path, rev, part: n } = unpage(key.slice(1 + NUMBER));
        out[out.length] = { path, rev, part: n, size: value as number };
      }
      return arrayCopy(out);
    },
    pageBytes() { let n = 0; for (const [, value] of kv.list({ prefix: PAGE_ROWS })) n += (value as PageValue)[1]; return n; },
    pageMaxUsed() { for (const [key] of kv.list({ prefix: PAGE_USED, reverse: true, limit: 1 })) return NumberOf(key.slice(1, 18)); return 0; },
    nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
      put(nsKey(parent, name), {
        kind: NumberOf(kind), size: NumberOf(size), mode: NumberOf(mode), uid: NumberOf(uid), gid: NumberOf(gid),
        atime: NumberOf(atime), mtime: NumberOf(mtime), ctime: NumberOf(ctime), ino: NumberOf(ino), rev: NumberOf(rev),
        target: target == null ? null : stringOf(target), dev: NumberOf(dev) || 0, nlink: NumberOf(nlink) || 1,
      } satisfies NsRow);
    },
    nsGet(parent, name) { return kv.get(nsKey(parent, name)) as NsRow | undefined; },
    nsDelete(parent, name) { dropOne(nsKey(parent, name)); },
    nsDeleteChildren(parent) { deleteKeys({ prefix: nsChildren(parent) }); },
    nsDeleteParents(from, to) { deleteKeys(rangeOf(NS, from, to)); },
    nsClear() { deleteKeys({ prefix: NS }); },
    nsKeys() { const rows = nsRows({ prefix: NS }); const out = new SafeList<NsKey>(); for (let i = 0; i < rows.length; i++) out[out.length] = rows[i][0]; return arrayCopy(out); },
    nsOfKind(kind) {
      const rows = nsRows({ prefix: NS });
      const out = new SafeList<NsKey>();
      for (let i = 0; i < rows.length; i++) if (rows[i][1].kind === NumberOf(kind)) out[out.length] = rows[i][0];
      return arrayCopy(out);
    },
    nsUnlisted() {
      const rows = nsRows({ prefix: NS });
      const out = new SafeList<NsKey & { target: string }>();
      for (let i = 0; i < rows.length; i++) {
        const [key, row] = rows[i];
        if (row.kind === NS_DIR && row.target !== null) out[out.length] = { parent: key.parent, name: key.name, target: row.target };
      }
      return arrayCopy(out);
    },
    nsChildren(parent) {
      const out = new SafeList<NsChild>();
      const prefix = nsChildren(parent);
      for (const [key, value] of kv.list({ prefix })) {
        const row = value as NsRow;
        out[out.length] = { name: decodePart(key.slice(prefix.length)), kind: row.kind, mode: row.mode };
      }
      return arrayCopy(out);
    },
    nsCount() { let n = 0; for (const _entry of kv.list({ prefix: NS })) n++; return n; },
  };
}
