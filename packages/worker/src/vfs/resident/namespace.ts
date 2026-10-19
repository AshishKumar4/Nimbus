/**
 * The namespace: every name the credential can see, exact at the store's
 * cursor: filled from a complete listing, then moved forward by each ACQUIRE
 * delta, whose entries carry the path's stat at the answer's revision (null
 * when it is gone). A change of presence or stat is always a logged mutation
 * of that path, except what vanishes beneath a removed or replaced directory,
 * which the delta application drops by subtree. So a synchronous stat, exists
 * or readdir is answered exactly, and an absent name is known to be absent.
 *
 * This table holds the AUTHORITY's view only. The process's own pending
 * structural effects are an overlay kept by the shims, retired once a barrier
 * begun after they settled has applied.
 *
 * A node process lists every name before its program runs, because a
 * synchronous stat cannot wait for a listing. A process whose calls CAN wait
 * (a WASI guest, parked under JSPI) does not have to pay for names it never
 * looks at, and the bill is real: with a vscode clone in the session (24,683
 * names) the whole enumeration took `node -e 'console.log(1)'` from 0.40 s to
 * 2.0 s (throwaway, 2026-10-05). So such a process starts with no names and a
 * cursor, and lists a directory the first time a lookup needs one of its
 * entries (LAZY). A directory whose entries are all rows is LISTED; below one
 * that is not, a missing row means "not known", never "absent".
 *
 * Rows are what a listing or a delta put there, dated by their own revision,
 * exactly as for an enumerated namespace: deltas from the store's cursor
 * (taken before any listing) name everything that moved since, so a row is
 * never older than the cursor it is judged against.
 */

import type { Admission } from './admission.js';
import { namespaceRowBytes } from './cell-cost.js';
import type { Coherence } from './coherence.js';
import { namespaceAllows, type ModeMeta, type ResidentCred } from './permissions.js';
import type { RuntimeVfsStat, VfsInvalidatedPath, VfsListEntry } from '@nimbus-sh/core/runtime/os-contracts.js';
import { NS_DIR, NS_FILE, NS_LINK, type NsRow, type ResidentTables } from './tables.js';
import {
  arrayCopy, dateNow, Error, NumberOf, numberIsInteger, objectAssign, objectHasOwn, ownField, SafeList, SafeMap, SafeSet,
  StringFromCharCode, stringCharCodeAt, stringLastIndexOf, stringOf, stringSlice, stringStartsWith,
} from '@nimbus-sh/core/_shared/primordials.js';
import { nsKey, nsName, nsParent, nsRowAt, walkNamespace, type Lookup, type OwnView } from './namespace-lookup.js';

export { nsKey, nsRowAt, nsSplit, type Lookup, type OwnView, type OwnWord } from './namespace-lookup.js';

/** What a row is made from: a stat the session reported, or one the process's own write stands in with until it does. */
export type NsStat = Pick<RuntimeVfsStat, 'type' | 'size' | 'mode' | 'uid' | 'gid' | 'atime' | 'mtime' | 'ctime' | 'ino'>
  & Partial<Pick<RuntimeVfsStat, 'dev' | 'nlink' | 'revision'>>;

export type Resolved = { path: string; row: NsRow } | 'ELOOP';

export interface Namespace {
  bind(t: ResidentTables): void;
  setCred(cred: ResidentCred | null | undefined): void;
  readonly cred: ResidentCred | null;
  /** Whether the table describes the store's cursor. */
  ready(): boolean;
  /** The persisted 'ns' flag: the table described the cursor when it was last moved, sealed or not. */
  readonly ok: boolean;
  markReady(t: ResidentTables, ready: boolean, cause?: string): void;
  /** Stop answering for `cause` (a budget refused), and throw it as ENOSPC. */
  refuse(t: ResidentTables, cause: string): never;
  /**
   * The bytes the shims' overlay of the process's own structural effects
   * takes, charged to a one-shot's budget: growth that does not fit stops the
   * namespace, and throws ENOSPC.
   */
  overlayDelta(bytes: number): void;
  /** The row at exactly `k` (no symlink resolution), or undefined; refused while sealed. */
  rowAt(k: string): NsRow | undefined;
  /** Why the namespace is not answering (meaningful only while ready() is false). */
  notReadyCause(): string;
  put(t: ResidentTables, k: string, stat: NsStat, rev: unknown, target?: string | null, unlisted?: string | null): void;
  tryPut(t: ResidentTables, k: string, stat: NsStat, rev: unknown, target?: string | null, unlisted?: string | null): boolean;
  deleteTree(t: ResidentTables, k: string, self: boolean): void;
  /** Drop one row and what the table keeps of it in heap. */
  forget(t: ResidentTables, k: string): void;
  /**
   * `own`: the process's own effects, applied at each name the walk reaches
   * (OwnView). `visit`: told each name the walk looks up, in order (its
   * directory is the one searched), before it is looked up; false stops the
   * walk there, EACCES.
   */
  lookup(k: string, followLeaf: boolean, own?: OwnView): Lookup | 'ELOOP';
  lookup(k: string, followLeaf: boolean, own: OwnView | undefined, visit: (name: string) => boolean): Lookup | 'ELOOP' | 'EACCES';
  resolve(k: string, followLeaf: boolean, own?: OwnView): Resolved | null;
  unknown(k: string, followLeaf: boolean, listing: boolean, own?: OwnView): string | null;
  children(k: string): { name: string; kind: number; mode: number }[];
  /** Whether the credential may read the file `stat` describes (see readable). */
  readable(stat: ModeMeta | null | undefined): boolean;
  applyEntry(t: ResidentTables, entry: VfsInvalidatedPath): string | null;
  replace(t: ResidentTables, entries: readonly VfsListEntry[]): void;
  noteOwnFile(k: string, size: number, rev: number): void;
  noteLiveStat(k: string, stat: (NsStat & { linkTarget?: string | null; target?: string | null }) | null, written: number | undefined): void;
  /** Every name forgotten, and the namespace stops answering (store.clear). */
  clear(): void;
  /** Whether this store lists on demand rather than enumerating. */
  readonly lazy: boolean;
  /** Start listing on demand, with no names (store.beginLazy). */
  beginLazy(): void;
  /** Whether a missing row at `k` means nothing is there (its directory is listed). */
  listedAt(k: string): boolean;
  isListed(dir: string): boolean;
  markListed(dir: string): void;
  forgetListed(dir: string): void;
}

export function nsKindCode(type: unknown): number {
  return type === 'directory' ? NS_DIR : type === 'symlink' ? NS_LINK : NS_FILE;
}

/** A record's own data field, retaining the type its contract gives it. */
function ownValue<T extends object, K extends keyof T>(record: T, key: K): T[K] | undefined {
  return objectHasOwn(record, key) ? record[key] : undefined;
}

/**
 * Whether a stat from the authority describes its name: a type, and the
 * mode, owner and group every permission check reads. One without them is
 * no record. Stored, its missing fields would become zeros, a root-owned
 * mode-0 file the authority never reported. The namespace then stops
 * answering (as for a delta without stats) until a listing that does
 * describe every name restores it.
 */
export function nsDescribes(stat: unknown): stat is Pick<RuntimeVfsStat, 'type' | 'mode' | 'uid' | 'gid'> {
  if (stat === null || (typeof stat !== 'object' && typeof stat !== 'function') || typeof ownField(stat, 'type') !== 'string') return false;
  const mode = ownField(stat, 'mode');
  const uid = ownField(stat, 'uid');
  const gid = ownField(stat, 'gid');
  return mode !== null && mode !== undefined && numberIsInteger(NumberOf(mode))
    && uid !== null && uid !== undefined && numberIsInteger(NumberOf(uid))
    && gid !== null && gid !== undefined && numberIsInteger(NumberOf(gid));
}

/**
 * The exclusive upper bound of a prefix under the BINARY collation SQLite gives
 * a TEXT PRIMARY KEY — the successor of the last code unit it can increment.
 * Null when there is none (an empty prefix, or one ending in U+FFFF), and the
 * caller then scans open-ended, which is correct and merely slower.
 *
 * Every caller passes a directory prefix ending in '/', so the increment is
 * '/' → '0' and UTF-16 and UTF-8 orderings agree exactly. They diverge only
 * around the surrogate range, which no path segment separator lives in.
 */
export function prefixEnd(prefix: string): string | null {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const code = stringCharCodeAt(prefix, i);
    if (code < 0xffff) return stringSlice(prefix, 0, i) + StringFromCharCode(code + 1);
  }
  return null;
}

export function createNamespace(coherence: Coherence, admission: Admission): Namespace {
  // The clock, taken as the store is made, before a run that can stop tapes
  // Date (stop-replay.ts): an own file's time is stamped when its write is
  // answered, which a run and its run again do at other moments.
  const realNow = dateNow;
  /** Paths of every symlink in the table: resolution walks only past these. */
  let links = new SafeSet<string>();
  /**
   * Directories on a mount whose entries the listing did not name (the launch
   * did not name them, or they were past its bound), each to the mount point
   * it is on. A name at or under one is not known absent, only not listed.
   * Held in the row's `target`, which a directory has no other use for.
   */
  let unlisted = new SafeMap<string, string>();
  /** The credential names are judged traversable for. */
  let cred: ResidentCred | null = null;
  /** The persisted 'ns' flag, mirrored in heap because every stat asks it. */
  let ok = false;
  /** Why the namespace stopped answering, while it does not: what a refused sync call names. */
  let cause = 'the process has not listed it yet';
  /** Whether this store lists on demand (beginLazy) rather than enumerating. */
  let lazy = false;
  /** Directories (keys) every entry of which is a row: below them a missing row is an absent name. */
  const listed = new SafeSet<string>();

  const ready = (): boolean => ok && coherence.serving();

  const markReady = (t: ResidentTables, isReady: boolean, why?: string): void => {
    t.metaSet('ns', isReady ? '1' : '0');
    ok = !!isReady;
    if (!isReady) cause = stringOf(why || 'a change it could not follow');
  };

  const refuse = (t: ResidentTables, why: string): never => {
    markReady(t, false, why);
    throw objectAssign(new Error(why), { code: 'ENOSPC' });
  };

  /**
   * The mount a lookup of `k` lands on unlisted: the mount point of the
   * nearest directory the namespace holds at `k` (when `self`) or above
   * it, when that directory is unlisted, or null. A listed directory is known
   * whatever is above it: a device mount that resolves its own paths can show
   * a directory whose parents it will not list.
   */
  const unlistedOver = (k: string, self: boolean): string | null => {
    if (unlisted.size === 0) return null;
    const t = coherence.require();
    for (let at = self ? k : nsParent(k); at !== ''; at = nsParent(at)) {
      const mount = unlisted.get(at);
      if (mount !== undefined) return mount;
      const row = nsRowAt(t, at);
      if (row && row.kind === NS_DIR) return null;
    }
    return null;
  };

  /**
   * `unlisted` is what a listing says of a directory: the mount point it is
   * on when it did not name its entries, null when it did. Undefined (a delta,
   * a note) keeps what the row says.
   */
  const put = (t: ResidentTables, k: string, stat: NsStat, rev: unknown, target?: string | null, unlistedAt?: string | null): void => {
    const parent = nsParent(k);
    const name = nsName(k);
    const kind = nsKindCode(stat.type);
    const mount = kind !== NS_DIR ? null : unlistedAt === undefined ? (unlisted.get(k) ?? null) : unlistedAt;
    const stored = kind === NS_LINK ? stringOf(target ?? '') : mount;
    // A one-shot's heap holds the namespace within its one budget: a row that would not fit is not written.
    const heap = coherence.heap;
    if (heap !== null && admission.inHeap) {
      const refused = admission.rowRefusal(heap.nsGrowth(parent, name, stored));
      if (refused !== null) refuse(t, refused);
    }
    t.nsPut(
      parent, name, kind, NumberOf(stat.size) || 0, NumberOf(stat.mode) || 0, NumberOf(stat.uid) || 0,
      NumberOf(stat.gid) || 0, NumberOf(stat.atime) || 0, NumberOf(stat.mtime) || 0, NumberOf(stat.ctime) || 0,
      NumberOf(stat.ino) || 0, NumberOf(rev) || 0, stored,
      NumberOf(ownValue(stat, 'dev')) || 0, NumberOf(ownValue(stat, 'nlink')) || 1,
    );
    if (kind === NS_LINK) links.add(k); else links.delete(k);
    if (mount !== null) unlisted.set(k, mount); else unlisted.delete(k);
  };

  // The authority operation may succeed while metadata cannot be cached.
  // A heap put refused for room has sealed the sync view; keep the async result.
  const tryPut = (t: ResidentTables, k: string, stat: NsStat, rev: unknown, target?: string | null, unlistedAt?: string | null): boolean => {
    try { put(t, k, stat, rev, target, unlistedAt); return true; }
    catch (error) {
      if (admission.inHeap && error !== null && (typeof error === 'object' || typeof error === 'function') && ownField(error, 'code') === 'ENOSPC') return false;
      throw error;
    }
  };

  const forgetListed = (dir: string): void => {
    const prefix = dir === '' ? '' : dir + '/';
    listed.forEach((done) => { if (done === dir || stringStartsWith(done, prefix)) listed.delete(done); });
  };

  /** Delete everything beneath `k`, and `k` itself when `self`. */
  const deleteTree = (t: ResidentTables, k: string, self: boolean): void => {
    // What a lazily listed namespace held there is no longer all of it.
    if (lazy) forgetListed(k);
    if (k === '') {
      t.nsClear();
      links = new SafeSet();
      unlisted = new SafeMap();
      return;
    }
    const prefix = k + '/';
    const end = prefixEnd(prefix);
    t.nsDeleteChildren(k);
    t.nsDeleteParents(prefix, end);
    if (self) {
      const parent = nsParent(k);
      const name = nsName(k);
      t.nsDelete(parent, name);
      links.delete(k);
      unlisted.delete(k);
    }
    links.forEach((link) => { if (stringStartsWith(link, prefix)) links.delete(link); });
    unlisted.forEach((_mount, dir) => { if (stringStartsWith(dir, prefix)) unlisted.delete(dir); });
  };

  const forget = (t: ResidentTables, k: string): void => {
    const parent = nsParent(k);
    const name = nsName(k);
    t.nsDelete(parent, name);
    links.delete(k);
    unlisted.delete(k);
  };

  /**
   * Walk `k` through the symlinks the namespace holds, with the process's own
   * effects (`own`) applied at each name it reaches, ahead of the table: a
   * name it removed ends the walk, its links and renames redirect it, and
   * beneath a directory it made only its own names are there. The leaf is
   * followed only when `followLeaf`. Without links or own effects it is one
   * lookup. A link's target is joined to the name it was reached by.
   */
  function lookup(k: string, followLeaf: boolean, own?: OwnView): Lookup | 'ELOOP';
  function lookup(k: string, followLeaf: boolean, own: OwnView | undefined, visit: (name: string) => boolean): Lookup | 'ELOOP' | 'EACCES';
  function lookup(k: string, followLeaf: boolean, own?: OwnView, visit?: (name: string) => boolean): Lookup | 'ELOOP' | 'EACCES' {
    return walkNamespace(coherence.require(), links, k, followLeaf, own, visit);
  }

  /** Whether the credential may search directory `row` (POSIX x). */
  const traversable = (row: NsRow | undefined): boolean => {
    if (!row || row.kind !== NS_DIR) return false;
    return namespaceAllows(cred, row, 'directory', 1);
  };

  const children = (k: string): { name: string; kind: number; mode: number }[] => {
    const rows = coherence.require().nsChildren(k);
    const out = new SafeList<{ name: string; kind: number; mode: number }>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      out[out.length] = { name: stringOf(row.name), kind: NumberOf(row.kind), mode: NumberOf(row.mode) };
    }
    // Public readers outside the loading path still use array methods and iteration.
    return arrayCopy(out);
  };

  return {
    bind(t) {
      links = new SafeSet();
      const linkRows = t.nsOfKind(NS_LINK);
      for (let i = 0; i < linkRows.length; i++) {
        const row = linkRows[i];
        const parent = stringOf(row.parent);
        links.add(parent ? parent + '/' + stringOf(row.name) : stringOf(row.name));
      }
      unlisted = new SafeMap();
      const unlistedRows = t.nsUnlisted();
      for (let i = 0; i < unlistedRows.length; i++) {
        const row = unlistedRows[i];
        const parent = stringOf(row.parent);
        unlisted.set(parent ? parent + '/' + stringOf(row.name) : stringOf(row.name), stringOf(row.target));
      }
      ok = t.metaGet('ns') === '1';
    },
    setCred(given) { cred = given || null; },
    get cred() { return cred; },
    ready,
    get ok() { return ok; },
    markReady,
    refuse,
    overlayDelta(bytes) {
      if (!admission.inHeap) return;
      const refused = bytes > 0 ? admission.namespaceRefusal(bytes) : null;
      if (refused !== null) refuse(coherence.tables('a namespace overlay'), refused);
      admission.addOverlay(bytes);
    },
    rowAt: (k) => nsRowAt(coherence.require(), k),
    notReadyCause() {
      if (!coherence.bound()) return "the process's store is not bound";
      const sealed = coherence.sealed();
      if (sealed !== null) return sealed || 'the store has not reconciled with the session';
      return cause;
    },
    put,
    tryPut,
    deleteTree,
    forget,
    lookup,
    /** `lookup`, with null when nothing is there. */
    resolve(k, followLeaf, own) {
      const found = lookup(k, followLeaf, own);
      if (found === 'ELOOP') return found;
      return found.row !== undefined && found.table !== null ? { path: found.table, row: found.row } : null;
    },
    /**
     * The mount point when the namespace cannot say what `k` is: its lookup
     * misses at or under a directory the listing did not name (or, with
     * `listing`, lands on or under one). Null when it knows.
     */
    unknown(k, followLeaf, listing, own) {
      if (unlisted.size === 0) return null;
      const found = lookup(k, followLeaf, own);
      if (found === 'ELOOP' || ownValue(found, 'own') !== undefined || found.table === null) return null;
      if (found.row === undefined) return unlistedOver(found.table, false);
      return listing ? unlistedOver(found.table, true) : null;
    },
    /** The entries directly under directory `k` (already resolved); the mode says what a file kind is. */
    children,
    /**
     * Whether the credential may read the file `stat` describes: what decides
     * whether bytes the store already has are kept for it under a new revision,
     * or a copy is held for it, rather than asked of the session. Equal content
     * keys prove the bytes are the file's, not that this credential may read
     * them, and a chmod or a chown changes no byte. A stat that does not state
     * the mode and owner is no grant: the session is asked instead, and answers.
     */
    readable(stat) {
      if (!stat || !numberIsInteger(NumberOf(ownValue(stat, 'mode'))) || !numberIsInteger(NumberOf(ownValue(stat, 'uid'))) || !numberIsInteger(NumberOf(ownValue(stat, 'gid')))) return false;
      return namespaceAllows(cred, stat, 'file', 4);
    },
    /**
     * Apply one delta entry that carries a stat. Returns a directory whose
     * subtree must be relisted — one that just became searchable, whose
     * descendants no delta names — or null.
     */
    applyEntry(t, entry) {
      const k = nsKey(entry.path);
      if (k === '') return null;
      const stat = ownValue(entry, 'stat');
      if (stat === null) { deleteTree(t, k, true); return null; }
      const before = nsRowAt(t, k);
      if (stat === undefined || !tryPut(t, k, stat, entry.rev, ownValue(entry, 'linkTarget'))) return null;
      const after = nsRowAt(t, k);
      if (after === undefined || after.kind !== NS_DIR) { deleteTree(t, k, false); return null; }
      const was = before !== undefined && traversable(before);
      const now = traversable(after);
      if (was && !now) deleteTree(t, k, false);
      if (!was && now && before !== undefined) return k;
      return null;
    },
    /**
     * Bring the table to a complete listing: upsert what differs, delete what the
     * listing no longer names. Called once per enumeration, after its last page.
     */
    replace(t, entries) {
      const names = new SafeSet<string>();
      for (let i = 0; i < entries.length; i++) names.add(nsKey(entries[i].path));
      // Remove stale rows before admitting replacements; do not transiently
      // charge both versions of a complete namespace against the fixed cap.
      const rows = t.nsKeys();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const parent = stringOf(row.parent);
        const k = parent ? parent + '/' + stringOf(row.name) : stringOf(row.name);
        if (!names.has(k)) forget(t, k);
      }
      // Free shrinking text before growing another surviving row; final-state
      // admission must not depend on alphabetical replacement order.
      if (admission.inHeap) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const k = nsKey(entry.path);
          if (!k) continue;
          const parent = nsParent(k);
          const name = nsName(k);
          const held = t.nsGet(parent, name);
          const linkTarget = ownValue(entry, 'linkTarget');
          const unlistedAt = ownValue(entry, 'unlisted');
          if (held && namespaceRowBytes(parent, name, held.target) > namespaceRowBytes(parent, name, linkTarget ?? unlistedAt)) {
            put(t, k, entry.stat, entry.rev, linkTarget, unlistedAt ?? null);
          }
        }
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const k = nsKey(entry.path);
        if (k === '') continue;
        names.add(k);
        const held = nsRowAt(t, k);
        const s = entry.stat;
        const linkTarget = ownValue(entry, 'linkTarget');
        const unlistedAt = ownValue(entry, 'unlisted');
        if (held !== undefined
          && held.kind === nsKindCode(s.type) && held.size === NumberOf(s.size)
          && held.mode === NumberOf(s.mode) && held.uid === NumberOf(s.uid)
          && held.gid === NumberOf(s.gid) && held.mtime === NumberOf(s.mtime)
          && held.ctime === NumberOf(s.ctime) && held.ino === NumberOf(s.ino)
          && held.dev === (NumberOf(s.dev) || 0) && held.rev === NumberOf(entry.rev)
          && (held.target ?? null) === (linkTarget ?? unlistedAt ?? null)) continue;
        put(t, k, s, entry.rev, linkTarget, unlistedAt ?? null);
      }
    },
    /**
     * Record this facet's own acknowledged write in the namespace before the
     * delta that reports it: a file it created is then listed at once. Only
     * when the table has nothing as new, so an authority stat already applied at
     * or past `rev` is never overwritten by this approximation; the delta that
     * reports the write replaces it with the authority's stat.
     */
    noteOwnFile(k, size, rev) {
      if (!ready()) return;
      const t = coherence.require();
      const held = nsRowAt(t, k);
      if (held !== undefined && held.rev >= rev) return;
      const now = realNow();
      // A file the process created: its umask's mode, on the device of the
      // directory it is in, with one link, until the delta reports the
      // authority's own stat for it. A file it rewrote keeps its identity.
      const slash = stringLastIndexOf(k, '/');
      const parent = held === undefined ? nsRowAt(t, slash < 0 ? '' : stringSlice(k, 0, slash)) : undefined;
      tryPut(t, k, {
        type: 'file', size, mode: held ? held.mode : 0o100666 & ~NumberOf((cred === null ? undefined : ownValue(cred, 'umask')) ?? 0o022),
        uid: held ? held.uid : NumberOf(cred === null ? 0 : cred.uid),
        gid: held ? held.gid : NumberOf(cred === null ? 0 : cred.gid),
        atime: now, mtime: now, ctime: now, ino: held ? held.ino : 0,
        dev: held ? held.dev : parent?.dev, nlink: held ? held.nlink : 1,
      }, rev, null);
    },
    /**
     * Record what the authority just said of a name this process asked about (an
     * async stat, read or accepted write): the sync view answers it at once,
     * as it would after the delta that reports it. Dated at the store's cursor,
     * so any row as new is kept, and the next delta naming the path replaces it
     * with the authority's own dating. `stat` null: the authority said it is not
     * there, and a row older than the cursor goes. The caller has checked that no
     * barrier reported the path while the stat was out (node-shims
     * _noteLearnedStat).
     *
     * `written`: the revision of this process's own accepted write the stat was
     * taken after, and the row's date. The row noteOwnFile approximated for
     * that write is dated there too, so the authority's stat replaces it (the
     * owner of a file the process overwrote without having listed it is the
     * authority's, not the process's), and only a row newer than the write is
     * kept.
     *
     * A symlink's stat does not say where the link points, so it is not kept:
     * a row without its target would resolve the link to its own directory.
     */
    noteLiveStat(k, stat, written) {
      if (!ready()) return;
      const cursor = coherence.cursor();
      if (cursor === null) return;
      const t = coherence.require();
      const held = nsRowAt(t, k);
      if (held !== undefined && (written === undefined ? held.rev >= cursor.rev : held.rev > written)) return;
      if (stat === null) {
        if (held !== undefined) forget(t, k);
        return;
      }
      if (!nsDescribes(stat)) return;
      const target = ownValue(stat, 'linkTarget') ?? ownValue(stat, 'target') ?? null;
      if (stat.type === 'symlink' && target === null) return;
      tryPut(t, k, stat, written ?? cursor.rev, target);
    },
    clear() {
      links = new SafeSet();
      unlisted = new SafeMap();
      ok = false;
    },
    get lazy() { return lazy; },
    beginLazy() {
      lazy = true;
      listed.clear();
      links = new SafeSet();
      unlisted = new SafeMap();
    },
    listedAt(k) { return listed.has(nsParent(k)); },
    isListed(dir) { return listed.has(dir); },
    markListed(dir) { listed.add(dir); },
    /** Forget that `dir` and every directory beneath it are listed: a change no delta itemises may have moved their names. */
    forgetListed,
  };
}
