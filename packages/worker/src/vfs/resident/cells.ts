/**
 * The store's cells: what a synchronous read is answered from, each dated by
 * the authority revision its bytes were read at, or as this facet's own
 * unacknowledged write (RK_OWN_WRITE), and moved forward by each ACQUIRE
 * delta (admit).
 *
 * 'file' carries one row per path, so existence, size and kind are one query
 * that never touches content. 'chunk' carries the bytes. Splitting them is
 * what makes _statLadder and __fileExists cheap: the common case reads a
 * short row and never pages a megabyte of blob in to answer "is it there".
 * 'rev' is never undated, and that IS the coherence guarantee rather than a
 * note about it. An undated row can never be invalidated, so it would be
 * served stale forever. Both backings take a revision with every head row
 * (filePut), so such a row cannot be written; this is the r2-cache posture (an unverifiable key
 * cannot be constructed) moved to the only storage layer this store has.
 *
 * RK_OWN_WRITE is the one negative value: this facet's own bytes that the
 * authority has not acknowledged, which are strictly newer than anything it
 * can report and are always readable. It is a real provenance, not an absence
 * of one.
 */

import { FACET_OWN_WRITE_MEMORY_BYTES } from '@nimbus-sh/platform/limits.js';
import type { Admission } from './admission.js';
import { RESIDENT_ROW_BYTES, residentBytes, residentCellCost, residentChunkCost, textChunkEnds, type ResidentCell } from './cell-cost.js';
import type { Coherence, Cursor } from './coherence.js';
import { nsDescribes, prefixEnd, type Namespace } from './namespace.js';
import { nsKey } from './namespace-lookup.js';
import {
  arrayCopy, arrayIsArray, Error, mathCeil, mathMax, mathMin, newTextEncoder, NumberOf, objectCreate, objectHasOwn, ownField,
  Proxy, reflectSetPrototypeOf, SafeList, SafeMap, SafeSet, stringOf, stringSlice, stringStartsWith, typedArrayBuffer, typedArrayByteLength,
  textEncoderEncode, typedArrayByteOffset, typedArraySet, Uint8ArrayConstructor,
} from '@nimbus-sh/core/_shared/primordials.js';
import { RESIDENT_CHUNK_BYTES } from '../facet-resident-limits.js';
import type { VfsAcquireResult } from '@nimbus-sh/core/runtime/os-contracts.js';
import { floorFor, isFeedPosition, notAfter, samePosition } from '@nimbus-sh/core/runtime/feed-position.js';
import { RK_BINARY, RK_DENIED, RK_OWN_WRITE, RK_TEXT, type ChunkRow, type FileHead, type ResidentTables } from './tables.js';

/** An own write held in memory: the store had no room for it in its tables. */
interface HeldCell { cell: ResidentCell; rev: number }

/** A record's own data field, retaining the type its contract gives it. */
function ownValue<T extends object, K extends keyof T>(record: T, key: K): T[K] | undefined {
  return objectHasOwn(record, key) ? record[key] : undefined;
}

/** What one admitted delta did. */
export interface Admitted {
  /** Paths that WERE held and are now gone: what the caller re-reads live. */
  dropped: string[];
  /** Rows kept because their revision already covers the report (this facet's own writes coming back). */
  kept: number;
  pushed: number;
  /** Directories an enumerated namespace must relist: no delta will itemise what is under them. */
  relist: string[];
  cursor: Cursor;
  /** An answer older than the store's cursor: nothing was applied. */
  stale?: boolean;
}

/** One fill's token (cells.beginFill): its own, compared by identity. */
export interface ResidentFill {
  readonly fill: number;
}

export interface Cells {
  /**
   * The resident set, as the shims have always seen it: `k in b`, `b[k]`,
   * `Object.keys(b)`, `delete b[k]` across a dozen call sites in
   * runtime/node-shims.ts, the shape the ledger uses for `__vfsWrites`. Every
   * trap is synchronous, because every reader of __vfsBundle is.
   */
  readonly bundle: Record<string, unknown>;
  /** Apply one authority delta and unseal (see admit below). */
  admit(result: VfsAcquireResult | null | undefined): Admitted;
  dropDated(): void;
  /** One row of 'file', or undefined. The existence/shape query. */
  head(path: string): FileHead | undefined;
  /** Whether `path` is held, in the tables or in memory. */
  has(path: string): boolean;
  /** Whether the cell held for `path` is a denial (what get answers { error } for), its bytes not read. */
  denied(path: string): boolean;
  get(path: string): ResidentCell | undefined;
  /** Write one cell as `rev`, or as an own write when `rev` is not a number (see put below). */
  put(t: ResidentTables, path: string, cell: ResidentCell | ArrayBuffer, rev?: number, ckey?: unknown): boolean;
  /**
   * The process's own bytes of `path`, which the session holds at `rev`:
   * stored as a fill of them would be, else held in the heap within the
   * process's own-write bound (FACET_OWN_WRITE_MEMORY_BYTES), dated at `rev`.
   */
  keep(t: ResidentTables, path: string, bytes: Uint8Array, rev: number): void;
  /**
   * A fill about to ask for `paths`: each one's chunk rows are its own, over
   * the head as it stands, until another fill begins for it or anything
   * changes its rows (rowsChanged).
   */
  beginFill(paths: ArrayLike<string>): ResidentFill;
  /** One chunk of `fill`: written only while the path's chunk rows are its own (false otherwise). */
  putChunk(t: ResidentTables, path: string, part: number, bytes: Uint8Array, fill: ResidentFill): boolean;
  /** The fill's file, once all its chunks are in: held as `rev`, if its chunk rows are still its (false otherwise). */
  publishFill(t: ResidentTables, path: string, kind: number, size: number, chunks: number, rev: number, ckey: unknown, fill: ResidentFill): boolean;
  /** A fill that did not finish `path`: the chunk rows it wrote, and the head they were written over, go, if they are still its. */
  abandonFill(t: ResidentTables, path: string, fill: ResidentFill): void;
  /**
   * The rows of `path` (every path: undefined) are about to change (tables.ts,
   * whoever changes them): the fill writing there is disowned, and what it
   * wrote with no head over it goes with it, bytes and accounting.
   */
  rowsChanged(path?: string): void;
  copyByKey(t: ResidentTables, path: string, ckey: unknown, rev: number): boolean;
  delete(t: ResidentTables, path: string): boolean;
  provenance(path: string): number | undefined;
  stamp(path: string, rev: number): void;
  lease(path: string): number | undefined;
  fill(path: string, cell: ResidentCell | ArrayBuffer, rev: number): boolean;
  keys(): string[];
  ownPaths(): string[];
  keysUnder(prefix: string): string[];
  hasUnder(prefix: string): boolean;
  /** Whether a miss on `path` is the storage's: its own write was held nowhere. */
  storageMiss(path: string): boolean;
  /** Every held cell that is not an own write still in flight, forgotten (or every one, with `all`). */
  dropHeld(all: boolean): void;
  /** Each own write held in memory, with what it is dated at (RK_OWN_WRITE until its write-back is acknowledged). */
  heldRevisions(): [string, number][];
  /** Forget the cell held in memory for `path`. */
  forget(path: string): void;
  clear(): void;
  stats(): { files: number; bytes: number; names: number; namespace: boolean; databaseSize: number; sealed: boolean; undatedSnapshot: boolean; cursor: Cursor | null };
}

export function createCells(
  coherence: Coherence,
  admission: Admission,
  namespace: Namespace,
  observeRead: ((path: string) => void) | null,
): Cells {
  // An own write the store could not hold (no room in the session's storage)
  // is kept here, so the program still reads what it wrote: a bounded LRU
  // (Map order is recency) of { cell, rev }, dated like a file row (own until
  // its write-back is acknowledged, then the write's revision) and judged by
  // every report like one. A path it could not keep either is remembered by
  // name only, so a miss on it says why.
  const held = new SafeMap<string, HeldCell>();
  const unheld = new SafeSet<string>();

  const cellSize = (cell: ResidentCell): number => (typeof cell === 'string' ? cell.length * 3 : typedArrayByteLength(residentBytes(cell)));

  // Bound at the store's creation, before the program runs: never a method it replaced.
  const encoder = newTextEncoder();
  const encodeText = (text: string): Uint8Array => textEncoderEncode(encoder, text);

  // A bounded part of `b`, without a subarray's live constructor or species.
  const sameBytes = (a: Uint8Array, b: Uint8Array, from = 0, to?: number): boolean => {
    const size = typedArrayByteLength(b);
    const start = mathMin(from, size);
    const length = mathMax(0, (to === undefined ? size : mathMin(to, size)) - start);
    if (typedArrayByteLength(a) !== length) return false;
    for (let i = 0; i < length; i++) if (a[i] !== b[start + i]) return false;
    return true;
  };

  /**
   * Whether the store holds `incoming` for `path` already: the same bytes,
   * held as text or as bytes (a sync fill holds text, an async read returns
   * bytes), compared a stored chunk at a time. A denial is never a file's bytes.
   */
  const holds = (t: ResidentTables, path: string, incoming: ResidentCell | ArrayBuffer): boolean => {
    if (typeof incoming === 'object' && objectHasOwn(incoming, 'error')) return false;
    const found = t.fileHead(path);
    if (found === undefined) {
      const cell = held.get(path)?.cell;
      if (cell === undefined || typeof cell === 'object' && objectHasOwn(cell, 'error')) return false;
      if (typeof cell === 'string' && typeof incoming === 'string') return cell === incoming;
      return sameBytes(typeof cell === 'string' ? encodeText(cell) : residentBytes(cell), typeof incoming === 'string' ? encodeText(incoming) : residentBytes(incoming));
    }
    if (found.kind === RK_DENIED) return false;
    // One chunk is read as `get` reads it; a file of several, in part order.
    const rows = (): (ChunkRow | undefined)[] => {
      if (found.chunks !== 1) return t.chunkParts(path);
      const out = new SafeList<ChunkRow | undefined>();
      out[out.length] = t.chunkFirst(path);
      return out;
    };
    if (found.kind === RK_TEXT && typeof incoming === 'string') {
      if (found.size !== incoming.length) return false;
      if (found.chunks === 1) return t.chunkFirst(path)?.txt === incoming;
      let at = 0;
      const parts = rows();
      for (let i = 0; i < parts.length; i++) {
        const row = parts[i];
        if (row === undefined) return false;
        const text = row.txt ?? '';
        if (stringSlice(incoming, at, at + text.length) !== text) return false;
        at += text.length;
      }
      return at === incoming.length;
    }
    const bytes = typeof incoming === 'string' ? encodeText(incoming) : residentBytes(incoming);
    const size = typedArrayByteLength(bytes);
    // A text row's size is its UTF-16 length: each unit is 1 to 3 bytes of UTF-8.
    if (found.kind === RK_BINARY ? found.size !== size : size < found.size || size > 3 * found.size) return false;
    // A text chunk never ends inside a surrogate pair (textChunkEnds): each encodes whole.
    let at = 0;
    const parts = rows();
    for (let i = 0; i < parts.length; i++) {
      const row = parts[i];
      if (row === undefined) return false;
      const part = found.kind === RK_TEXT ? encodeText(row.txt ?? '') : residentBytes(row.bin);
      const length = typedArrayByteLength(part);
      if (!sameBytes(part, bytes, at, at + length)) return false;
      at += length;
    }
    return at === size;
  };

  const forgetHeld = (path: string): void => {
    const cell = held.get(path);
    if (cell !== undefined) {
      held.delete(path);
      admission.addHeld(-cellSize(cell.cell));
    }
    unheld.delete(path);
  };

  const hold = (path: string, cell: ResidentCell, rev = RK_OWN_WRITE): void => {
    forgetHeld(path);
    const size = cellSize(cell);
    const limit = admission.heldLimit(FACET_OWN_WRITE_MEMORY_BYTES);
    if (size > limit) { unheld.add(path); return; }
    if (admission.heldBytes + size > limit) {
      held.forEach((old, oldest) => {
        if (admission.heldBytes + size <= limit) return;
        held.delete(oldest);
        admission.addHeld(-cellSize(old.cell));
        unheld.add(oldest);
      });
    }
    held.set(path, { cell, rev });
    admission.addHeld(size);
  };

  const head = (path: string): FileHead | undefined => coherence.require().fileHead(path);

  const dropDated = (): void => {
    coherence.tables('dropDated').dropDated();
    held.forEach((cell, path) => { if (cell.rev !== RK_OWN_WRITE) forgetHeld(path); });
  };

  /**
   * Write one cell, chunking past the single-value ceiling.
   *
   * `rev` is the authority revision these bytes were read at, and it is what
   * makes the row datable. Omitting it means the cell is this facet's own
   * unflushed write, stored as RK_OWN_WRITE — always readable
   * (read-your-writes) and never mistaken for something the authority vouched
   * for. There is no third case: the column refuses one.
   */
  const put = (t: ResidentTables, path: string, cell: ResidentCell | ArrayBuffer, rev?: number, ckey?: unknown): boolean => {
    // Whatever this puts supersedes a held cell, held or not, and (its head write) a fill's chunk rows.
    forgetHeld(path);
    // The room reserved for its fill is what it spends.
    admission.release(path);
    t.chunkDelete(path);
    const stamp = typeof rev === 'number' ? rev : RK_OWN_WRITE;
    if (cell && typeof cell === 'object' && ownField(cell, 'error')) {
      t.filePut(path, RK_DENIED, 0, 0, stamp, null);
      return true;
    }
    const isText = typeof cell === 'string';
    const kind = isText ? RK_TEXT : RK_BINARY;
    const body = isText ? cell : residentBytes(cell);
    const size = typeof body === 'string' ? body.length : typedArrayByteLength(body);
    // Text is chunked on its encoded length, since the ceiling is on bytes and
    // a multi-byte string would otherwise cross it while measuring short.
    const ends = typeof body === 'string' ? textChunkEnds(body) : null;
    const chunks = ends !== null ? ends.length : mathMax(1, mathCeil(size / RESIDENT_CHUNK_BYTES));
    // Not admitted: nothing is held for the path (its old bytes are gone above).
    if (!admission.fits(residentCellCost(cell), stamp !== RK_OWN_WRITE)) {
      t.fileDelete(path);
      if (stamp === RK_OWN_WRITE) hold(path, body);
      return false;
    }
    for (let part = 0, from = 0; part < chunks; part++) {
      if (typeof body === 'string' && ends !== null) {
        const end = ends[part];
        t.chunkAddText(path, part, stringSlice(body, from, end));
        from = end;
      } else if (typeof body !== 'string') {
        // Bytes are viewed, not copied: the table keeps what it is given as its own (tables.ts).
        const start = part * RESIDENT_CHUNK_BYTES;
        const slice = new Uint8ArrayConstructor(typedArrayBuffer(body), typedArrayByteOffset(body) + start, mathMin(RESIDENT_CHUNK_BYTES, size - start));
        t.chunkAddBin(path, part, slice);
      }
    }
    t.filePut(path, kind, size, chunks, stamp, stamp === RK_OWN_WRITE || ckey == null ? null : stringOf(ckey));
    return true;
  };

  /** One chunk row, written as it arrives. The streaming filler's primitive. */
  /**
   * Whose chunk rows each path's are while a fill writes them: the fill that
   * began last, while nothing changed the head it writes over since it was
   * asked (tables.ts tells rowsChanged of every head write and chunk removal,
   * single or bulk). Disowning a fill removes the rows it wrote with no head
   * over them, and removing them disowns it: one operation, so no rows are
   * left unowned and no fill writes on after its rows went.
   */
  const filling = new SafeMap<string, ResidentFill>();
  let fills = 0;

  const putChunk = (t: ResidentTables, path: string, part: number, bytes: Uint8Array, fill: ResidentFill): boolean => {
    if (filling.get(path) !== fill) return false;
    if (part === 0) admission.release(path);
    if (!admission.fits(residentChunkCost(typedArrayByteLength(bytes)))) return false;
    t.chunkSetBin(path, part, bytes);
    return true;
  };

  const admit = (result: VfsAcquireResult | null | undefined): Admitted => {
    const t = coherence.tables('admit');
    const dropped = new SafeList<string>();
    const relist = new SafeList<string>();
    let kept = 0, pushed = 0;
    const position = result ? ownValue(result, 'position') : undefined;
    if (!isFeedPosition(position)) {
      throw new Error(
        'Nimbus: fsAcquire returned no cursor; the resident store stays sealed '
        + 'rather than serving rows it cannot date',
      );
    }
    // Answers can be admitted out of the order they were served in (two
    // barriers in flight). One at or before the store's cursor describes a
    // state the store has already reached: admitting it would move the cursor
    // back and install its bytes over newer ones. Within a table and its
    // feeds' epochs the cursor only moves forward, and only each feed's
    // entries above its cursor are applied (floorFor).
    const at = coherence.cursor();
    const floorAt = at !== null && coherence.sealed() === null && !(result && result.poison) ? at : null;
    if (at !== null && floorAt !== null && notAfter(position, floorAt)) {
      return { dropped: arrayCopy(dropped), kept, pushed: 0, relist: arrayCopy(relist), cursor: at, stale: !samePosition(position, floorAt) };
    }
    // The namespace moves with the cursor or not at all: a delta without stats,
    // or a poison, leaves it describing a revision the cursor has left, so it
    // stops answering until a listing restores it.
    // An answer naming no path changes no name, with or without stats. One
    // that arrives while the namespace is not answering keeps why it is not.
    const nsOk = namespace.ok;
    const paths = result && arrayIsArray(result.paths) ? result.paths : null;
    let followable = !!result && !result.poison
      && (ownValue(result, 'namespace') === true || (paths !== null && paths.length === 0));
    if (followable && paths !== null) {
      for (let i = 0; i < paths.length; i++) {
        const stat = ownValue(paths[i], 'stat');
        if (stat !== null && !nsDescribes(stat)) { followable = false; break; }
      }
    }
    const namespaced = nsOk && followable;
    if (nsOk && !followable) {
      namespace.markReady(t, false, !result || result.poison ? "the session's change log was truncated past this process's cursor"
        : 'a change reported without the stat every name needs');
    }
    if (!result || result.poison) {
      // A delta admission has no absolute listing to vouch for a row, so a
      // poison here means nothing the authority dated can be kept.
      //
      // This is the LAST resort, not the poison policy.
      // sync.synchronize repairs the same poison against absolute per-path
      // revisions and keeps every row it can prove current; dropping the
      // store is what made a poison cost a whole filesystem.
      dropDated();
    } else if (paths !== null) {
      for (let i = 0; i < paths.length; i++) {
        const entry = paths[i];
        const entryRev = NumberOf(entry.rev);
        if (floorAt !== null && entryRev <= floorFor(position, floorAt, entry.path)) continue;
        const path = entry.path;
        if (namespaced && namespace.ready()) {
          const again = namespace.applyEntry(t, entry);
          if (again !== null) {
            relist[relist.length] = again;
            namespace.fence(again);
          }
        }
        // A row at or above the reported revision already holds that mutation —
        // this facet's own write coming back, or bytes fetched after it; anything
        // else is someone else's and is dropped. A row of own bytes
        // (RK_OWN_WRITE) is newer than any authority revision by construction
        // and is kept — read-your-writes survives a peer's mutation of the same
        // path, and the report is adjudicated when the write's own revision
        // arrives (the shims note it for the ledger before admitting).
        // A subtree-scoped or structural entry covers every row at or under its
        // path, each judged the same way: something beneath it this facet may
        // not see changed, or the directory went, or who may enter it did. A
        // row there may be stale, or no longer this facet's to be served.
        const subtree = ownValue(entry, 'subtree');
        const stat = ownValue(entry, 'stat');
        if (subtree || ownValue(entry, 'structural')) {
          const end = prefixEnd(path + '/');
          const rows = t.fileRevsIn(path + '/', end);
          for (let j = 0; j < rows.length; j++) {
            const row = rows[j];
            const stamped = row.rev;
            if (stamped === RK_OWN_WRITE || stamped >= entryRev) continue;
            t.chunkDelete(row.path);
            t.fileDelete(row.path);
            dropped[dropped.length] = row.path;
          }
          held.forEach((heldCell, heldPath) => {
            if (!stringStartsWith(heldPath, path + '/') || heldCell.rev === RK_OWN_WRITE || heldCell.rev >= entryRev) return;
            forgetHeld(heldPath);
          });
          // Names under it may have become hidden or visible without being
          // named: an enumerated namespace relists that subtree.
          if (namespaced && !namespace.lazy && subtree && stat && stat.type === 'directory') {
            relist[relist.length] = path;
            namespace.fence(path);
          }
        }
        let isHeld = false, stamped = 0, heldKey: string | null = null;
        const row = t.fileRevKey(path);
        if (row !== undefined) {
          isHeld = true; stamped = row.rev; heldKey = row.ckey;
        }
        if (isHeld && (stamped === RK_OWN_WRITE || stamped >= entryRev)) { kept++; continue; }
        // A cell held in memory (an own write the store had no room for) is
        // judged the same way; superseded, it goes, and the report's bytes, if
        // any, are held as the store can.
        const heldCell = held.get(path);
        if (heldCell !== undefined) {
          if (heldCell.rev === RK_OWN_WRITE || heldCell.rev >= entryRev) { kept++; continue; }
          forgetHeld(path);
        }
        // The same bytes under a newer revision (a chmod, a touch, a rewrite
        // with identical content): kept, and dated at the report, while the
        // report says this credential may still read them. A chmod or chown
        // that revoked the read drops them, and the session answers the read.
        const contentKey = ownValue(entry, 'contentKey');
        if (isHeld && heldKey !== null && contentKey != null && heldKey === stringOf(contentKey) && namespace.readable(stat)) {
          t.fileSetRev(path, entryRev);
          kept++;
          continue;
        }
        // Pushed content: the file's bytes at the answer's revision, so dating
        // them at the path's own revision cannot be newer than they are.
        const bytes = ownValue(entry, 'bytes');
        if (bytes != null && stat && stat.type === 'file') {
          // Bytes it holds already (no content key to say so): dated, never rewritten and lost at the cap.
          const incoming = residentBytes(bytes);
          if (isHeld && holds(t, path, incoming)) { t.fileSetRev(path, entryRev); kept++; continue; }
          if (put(t, path, incoming, entryRev, contentKey)) pushed++;
          else if (isHeld) dropped[dropped.length] = path;
          continue;
        }
        if (!isHeld) continue;
        t.chunkDelete(path);
        t.fileDelete(path);
        dropped[dropped.length] = path;
      }
    }
    coherence.writeCursor(t, position);
    coherence.unseal();
    return { dropped: arrayCopy(dropped), kept, pushed, relist: arrayCopy(relist), cursor: position };
  };

  /**
   * The synchronous read. THE point of this store: a plain, non-async function
   * that returns content, so a fs.readFileSync call stack never has to yield.
   *
   * Returns exactly what __vfsBundle has always returned — a string, a
   * Uint8Array, or an { error: "EACCES" } denial — or undefined for a cell that
   * is not held.
   */
  // A read of a module's file, as of any other: through the launch's
  // captures only (SafeMap, its own loops), never a built-in the program
  // may have replaced.
  const get = (path: string): ResidentCell | undefined => {
    if (observeRead !== null) observeRead(nsKey(path));
    const found = head(path);
    if (found === undefined) {
      const cell = held.get(path);
      if (cell === undefined) return undefined;
      held.delete(path);
      held.set(path, cell);
      return cell.cell;
    }
    const kind = found.kind;
    if (kind === RK_DENIED) return { error: 'EACCES' };
    const t = coherence.require();
    if (found.chunks === 1) {
      const row = t.chunkFirst(path);
      if (row === undefined) return undefined;
      return kind === RK_TEXT ? row.txt ?? undefined : residentBytes(row.bin);
    }
    // Chunked: a file past the single-value ceiling. Reassembled here so callers
    // never learn the file was split.
    const rows = t.chunkParts(path);
    if (rows.length === 0) return undefined;
    if (kind === RK_TEXT) {
      let text = '';
      for (let i = 0; i < rows.length; i++) text += rows[i].txt ?? '';
      return text;
    }
    let total = 0;
    for (let i = 0; i < rows.length; i++) total += typedArrayByteLength(residentBytes(rows[i].bin));
    const out = new Uint8ArrayConstructor(total);
    let offset = 0;
    for (let i = 0; i < rows.length; i++) {
      const bytes = residentBytes(rows[i].bin);
      typedArraySet(out, bytes, offset);
      offset += typedArrayByteLength(bytes);
    }
    return out;
  };

  const deleteCell = (t: ResidentTables, path: string): boolean => {
    const had = head(path) !== undefined || held.has(path);
    forgetHeld(path);
    t.chunkDelete(path);
    t.fileDelete(path);
    return had;
  };

  const keys = (): string[] => coherence.require().fileAllPaths();

  const target: Cells['bundle'] = objectCreate(null);
  const handler: ProxyHandler<Cells['bundle']> = {
    get(_t, path) {
      if (typeof path !== 'string') return undefined;
      return get(path);
    },
    has(_t, path) {
      if (typeof path !== 'string') return false;
      return head(path) !== undefined || held.has(path);
    },
    set(_t, path, cell) {
      // The program's own write, stamped RK_OWN_WRITE: not the authority's
      // yet, newer than anything it could report, and replaced with a real
      // revision by the ledger when the write-back lands.
      if (typeof path !== 'string') return true;
      put(coherence.require(), path, cell, undefined);
      return true;
    },
    deleteProperty(_t, path) {
      if (typeof path === 'string') deleteCell(coherence.require(), path);
      return true;
    },
    ownKeys() { return keys(); },
    getOwnPropertyDescriptor(_t, path) {
      if (typeof path !== 'string') return undefined;
      if (head(path) === undefined) return undefined;
      // Configurable so 'delete' is legal and enumerable so for-in and
      // Object.keys see it — the two things every scan site depends on.
      //
      // An ACCESSOR, not a data descriptor, and that is the whole point: a
      // for-in or Object.keys over a Proxy asks this trap about every key, so a
      // data descriptor had to produce `value` — reading every file's bytes out
      // of storage to answer a question about NAMES. Measured at pi scale, one
      // such scan read 87 MiB and threw all of it away. A getter answers the
      // name question for free and still returns the bytes to anything that
      // genuinely reads the property.
      const descriptor: PropertyDescriptor = objectCreate(null);
      descriptor.configurable = true;
      descriptor.enumerable = true;
      descriptor.get = () => get(path);
      return descriptor;
    },
  };
  reflectSetPrototypeOf(handler, null);
  const bundle = new Proxy(target, handler);

  return {
    bundle,
    /**
     * Apply one authority delta and unseal.
     *
     * `result` is exactly what `supervisor.fsAcquire(epoch, cursor)` returns
     * (`VfsAcquireResult` — runtime/os-contracts.ts), so this store slots into the
     * ACQUIRE/RELEASE protocol the shims already run rather than beside it. One
     * cache, one invariant.
     *
     * Returns the paths that WERE held and are now gone, which is what
     * `_acquireAndRefetch` re-reads live — the same contract `_acquireBarrier`
     * already has — and how many named rows were kept because their revision
     * already covers the report (this facet's own writes coming back).
     */
    admit,
    /**
     * Drop every row the authority dated, and nothing else: what a poison does to
     * the rows when nothing can vouch for them. The cursor is left alone, because
     * a store that holds no dated row cannot hold a stale one whatever its cursor
     * says.
     *
     * This facet's own bytes are not the authority's to vouch for, and stay:
     * dropping a row a write or mutation still in flight owns would hand the next
     * fill the pre-write bytes. Its acknowledgement dates it, or evicts it, when
     * it lands.
     *
     * Two statements rather than a delete per path: at pi scale that is 7,141
     * rows, and this is on the hot path (measured 45 ms whole-store, vs a per-row
     * walk).
     */
    dropDated,
    head,
    has: (path) => head(path) !== undefined || held.has(path),
    denied: (path) => {
      const found = head(path);
      if (found !== undefined) return found.kind === RK_DENIED;
      const cell = held.get(path)?.cell;
      return typeof cell === 'object' && cell !== null && !(cell instanceof Uint8ArrayConstructor) && typeof ownField(cell, 'error') === 'string';
    },
    get,
    put,
    keep(t, path, bytes, rev) {
      if (!put(t, path, bytes, rev)) hold(path, bytes, rev);
    },
    putChunk,
    publishFill(t, path, kind, size, chunks, rev, ckey, fill) {
      if (filling.get(path) !== fill) return false;
      // Its rows are a file now: no longer a fill's to drop.
      filling.delete(path);
      t.filePut(path, kind, size, chunks, rev, ckey != null ? stringOf(ckey) : null);
      return true;
    },
    abandonFill(t, path, fill) {
      if (filling.get(path) !== fill) return;
      t.chunkDelete(path);
      t.fileDelete(path);
    },
    beginFill(paths) {
      const fill: ResidentFill = { fill: ++fills };
      for (let i = 0; i < paths.length; i++) filling.set(paths[i]!, fill);
      return fill;
    },
    rowsChanged(path) {
      if (filling.size === 0) return;
      // Maintenance, not a read: it runs while a kept store is sealed for its reconcile too.
      const t = coherence.tables('rowsChanged');
      const disown = (at: string): void => { if (filling.delete(at) && t.fileHead(at) === undefined) t.chunkDelete(at); };
      if (path !== undefined) { disown(path); return; }
      const owned = new SafeList<string>();
      filling.forEach((_fill, at) => { owned[owned.length] = at; });
      for (let i = 0; i < owned.length; i++) disown(owned[i]!);
    },
    /**
     * The head row, written LAST by the streaming filler.
     *
     * Order is the durability rule here: without a head row `head` returns
     * undefined and the path simply misses, falling through to the supervisor
     * exactly as it would have. So a fill interrupted part way through a large
     * file leaves chunks nothing can read, never a short file something can.
     * Writing the head first would invert that into a truncated read.
     */
    /**
     * Hold `path` with the bytes of a dated row whose content identity is
     * `ckey`, by copying rows inside this store: equal keys are equal bytes, so
     * no fetch is needed. Returns whether a source existed.
     */
    copyByKey(t, path, ckey, rev) {
      const source = t.fileByKey(stringOf(ckey), path);
      if (source === undefined) return false;
      if (!admission.fits(source.size + (source.chunks + 1) * RESIDENT_ROW_BYTES)) return false;
      t.chunkDelete(path);
      t.chunkCopy(path, source.path);
      t.filePut(path, source.kind, source.size, source.chunks, rev, stringOf(ckey));
      return true;
    },
    delete: deleteCell,
    /**
     * What a row is dated at: its revision, RK_OWN_WRITE for this facet's own
     * unacknowledged bytes, or undefined when the path is not held.
     */
    provenance: (path) => coherence.require().fileRev(path) ?? held.get(path)?.rev,
    /**
     * Date this facet's own bytes with the revision the authority acknowledged
     * them at: the revision a flushed write produced, or the one an own mutation's
     * receipt settles on. The store's half of the stamp `__vfsBundleRevisions`
     * carries in heap (_shared/vfs-write-ledger.ts), kept in the row it describes
     * so the two cannot drift.
     *
     * Only a row still holding own bytes is dated. One that was dropped or
     * replaced meanwhile holds something this acknowledgement says nothing about.
     *
     * Without it nothing dates an own row, and RK_OWN_WRITE is the revision a
     * delta never evicts: a file this process wrote would serve its own bytes over
     * every later write to it by anyone.
     */
    stamp(path, rev) {
      const heldCell = held.get(path);
      if (heldCell !== undefined && heldCell.rev === RK_OWN_WRITE) heldCell.rev = rev;
      const t = coherence.require();
      const size = t.fileOwnSize(path);
      if (size === undefined) return;
      t.fileStampOwn(path, rev);
      namespace.noteOwnFile(path, size, rev);
    },
    /**
     * Hold a dated row as this facet's own for the window of one of its own
     * mutations (a ranged write, a truncate, a chmod), and return the revision it
     * was dated at: the mutation's receipt is judged against it when the window
     * closes (`__nimbusEndOwnMutation`). Undefined when there is no dated row —
     * an own row is held already, and an absent one has nothing to protect.
     *
     * The hold is what keeps a barrier that reports the mutation before its own
     * response arrives from evicting the cell the mutation is about to overlay.
     * The supervisor answers fsAcquire at once, while a write's response waits on
     * the Durable Object's output gate, so that ordering is ordinary.
     */
    lease(path) {
      const t = coherence.require();
      const rev = t.fileRev(path);
      if (rev === undefined || rev === RK_OWN_WRITE) return undefined;
      t.fileSetRev(path, RK_OWN_WRITE);
      return rev;
    },
    /**
     * Install bytes a live read returned, dated `rev`: the cursor the read was
     * issued under, so the bytes hold every mutation at or below it. An async read
     * must write through, or the next synchronous read goes back in time relative
     * to what the program was just handed (protocol §5.9).
     *
     * Refused over a row of own bytes, which are newer than anything a read can
     * return, and over a row dated after `rev`, which is newer than this read can
     * vouch for. Returns whether the bytes were installed.
     */
    fill(path, cell, rev) {
      if (typeof rev !== 'number' || rev < 0) {
        throw new Error(
          "Nimbus: refusing to fill '" + path + "' with no authority revision. "
          + 'An undated row cannot be invalidated, so it would be served stale forever.',
        );
      }
      const t = coherence.require();
      const dated = t.fileRev(path);
      if (dated !== undefined && (dated === RK_OWN_WRITE || dated > rev)) return false;
      const heldCell = held.get(path);
      if (heldCell !== undefined && (heldCell.rev === RK_OWN_WRITE || heldCell.rev > rev)) return false;
      // Bytes the store holds already are its own: the read dates them, and
      // rewriting them could only lose them, refused at the store's cap (a dev
      // server rereads its sources asynchronously, every one it serves).
      if (holds(t, path, cell)) {
        if (dated !== undefined) t.fileSetRev(path, rev);
        else if (heldCell !== undefined) heldCell.rev = rev;
        return true;
      }
      return put(t, path, cell, rev);
    },
    /** Every held path. Backs the Object.keys / for-in scans in the shims. */
    keys,
    /**
     * Every path held as this facet's own unacknowledged bytes: the rows a
     * poison's repair keeps without a revision to vouch for them, whose reports
     * the shims deliver to their owners (`_settleSkippedReports`).
     */
    ownPaths: () => coherence.require().fileOwnPaths(),
    /**
     * Paths under a directory prefix, as a bounded index range scan.
     *
     * The shims ask this constantly — readdirSync's union with the manifest,
     * existsSync of a directory, node's own module resolution, rm -rf, watch
     * globbing. In heap it was a for-in over every key; here it must be a range
     * scan on both ends, because that is the only version that is actually cheaper:
     * an open-ended `path >= prefix` with a LIKE filter still visits every row
     * after the prefix, and going back through the object protocol visits every row
     * AND reads every file's bytes.
     *
     * Two bounds also mean no LIKE, so a real path containing '%' or '_' needs no
     * escaping — those are only wildcards to an operator this no longer uses.
     */
    keysUnder(prefix) {
      const from = stringOf(prefix);
      return coherence.require().filePaths(from, prefixEnd(from));
    },
    /**
     * Whether ANY path is held under a prefix — the same range, stopped at the
     * first row. The hot half: it is what answers "is this a directory" on node's
     * module-resolution path, where materialising the subtree would be the cost all
     * over again.
     */
    hasUnder(prefix) {
      const from = stringOf(prefix);
      return coherence.require().fileAny(from, prefixEnd(from));
    },
    storageMiss: (path) => unheld.has(path),
    dropHeld(all) {
      held.forEach((cell, path) => { if (all || cell.rev !== RK_OWN_WRITE) forgetHeld(path); });
    },
    heldRevisions() {
      const out = new SafeList<[string, number]>();
      held.forEach((cell, path) => { out[out.length] = [path, cell.rev]; });
      return arrayCopy(out);
    },
    forget: forgetHeld,
    /**
     * Drop every cell AND the cursor, and re-seal.
     *
     * This is slot handover, not invalidation: a returned slot must not hand the
     * next tenant a filesystem, and dropping the rows while leaving a cursor behind
     * would leave the store claiming to be current at a revision it holds nothing
     * from. Clearing the cursor forces the next incarnation through `admit` from
     * scratch. sync.boot clears the same way when a kept store cannot be
     * reconciled.
     */
    clear() {
      coherence.tables('clear').clear();
      // Held cells go with the rows, but for own writes still in flight.
      held.forEach((cell, path) => { if (cell.rev !== RK_OWN_WRITE) forgetHeld(path); });
      namespace.clear();
      coherence.seal('the store was cleared');
    },
    stats() {
      const t = coherence.tables('stats');
      const counted = t.fileStats();
      return {
        files: counted === undefined ? 0 : counted.n,
        bytes: counted === undefined ? 0 : counted.b,
        names: t.nsCount(),
        namespace: namespace.ready(),
        databaseSize: t.databaseSize(),
        sealed: coherence.sealed() !== null,
        undatedSnapshot: coherence.undated,
        cursor: coherence.cursor(),
      };
    },
  };
}
