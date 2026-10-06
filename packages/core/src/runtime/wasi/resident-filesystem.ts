/**
 * A WASI process's filesystem, answered from the process's own copy of the
 * namespace where that copy can answer, and by the authority everywhere else.
 *
 * Every filesystem syscall a guest makes is a call to the session: measured
 * on a throwaway (2026-10-05), 5.9-12.7 ms for one `os.stat` from Python, so
 * a program that stats a tree pays for each name with a round trip. The
 * process already carries a store for names and bytes
 * (worker vfs/facet-resident-store.ts, the one a node process reads its
 * synchronous calls from). This adapter puts the codec's calls in front of
 * it: a lookup, a stat, a directory listing and its descriptor, and a file's
 * bytes (which the codec holds for a read-only descriptor, its ResidentFd) are
 * answered from the store; anything that changes the filesystem, and anything
 * the store cannot vouch for, goes to the authority exactly as before. The
 * store is the process's one copy of file bytes: the codec keeps none of its
 * own beside it (`holdsContent`).
 *
 * What makes an answer from the store the authority's answer:
 *   - The walk is the authority's own (beneath-walk.ts walkBeneath), its
 *     lookups answered from the store's entries, so `..`, links, search
 *     permission and every refusal come out as the authority's would.
 *   - Only the session's SQLite filesystem is answered here, recognised by
 *     its device: an entry on another device (a mount: /proc, /dev, an
 *     embedder's) changes without the change log, so it is the authority's.
 *   - The store is coherent with the authority at its cursor, and the cursor
 *     moves by the ACQUIRE barrier. The barrier is owed after any call this
 *     adapter sent to the authority that may have changed something, and
 *     after input entered the process from outside (`inbound`): before its
 *     next answer the adapter takes it, so what the guest learned elsewhere,
 *     or did itself, is in what it reads next. That is the causal rule a node
 *     process keeps (core README, process model).
 *   - A name the store does not know (its directory not listed yet) is not
 *     absent: the adapter lists the directory and walks again.
 */

import type {
  RuntimeFileHandle,
  RuntimeFsBridge,
  RuntimeFsPath,
  RuntimeOpenFlags,
  RuntimeVfsDirEntry,
  RuntimeVfsStat,
} from '../os-contracts.js';
import { fsError, modeAllows, walkBeneath } from '../beneath-walk.js';
import { FACET_OWN_WRITE_MEMORY_BYTES } from '@nimbus-sh/platform/limits.js';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../constants.js';

/** A name as the store holds it: its lstat, and a symlink's text. */
export interface ResidentEntry {
  type: 'file' | 'directory' | 'symlink';
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
  mode: number;
  uid: number;
  gid: number;
  revision: number;
  target: string | null;
}

/** What the adapter asks of the process's store. Keys have no leading `/`. */
export interface ResidentNamespace {
  /** The device the session's SQLite filesystem reports: the only one answered here. */
  readonly device: number;
  /** The credential the process walks and reads as. */
  readonly cred: { uid: number; gid: number; groups: readonly number[] };
  /** False while the store cannot answer (it lost its cursor): every call then goes to the authority. */
  ready(): boolean;
  /** The entry at `key`, no link followed: null when the store knows nothing is there, undefined when it does not know. */
  entry(key: string): ResidentEntry | null | undefined;
  /** The names in directory `key`, or undefined when it is not listed. */
  children(key: string): RuntimeVfsDirEntry[] | undefined;
  /** List directory `key`'s entries. False when it cannot be. */
  list(key: string): Promise<boolean>;
  /**
   * Learn the entries at `keys`, shallowest first, in one round trip; a
   * missing one is not recorded. With `content`, a small file at the last key
   * comes with its bytes.
   */
  lookup(keys: string[], content: boolean): Promise<boolean>;
  /** List everything under `key` in a few pages. False when that did not finish. */
  listTree(key: string): Promise<boolean>;
  /** The bytes of file `key` the store holds, or undefined. */
  content(key: string): Uint8Array | undefined;
  /** Fetch file `key`'s bytes (at `entry`'s revision) into the store; null when they could not be fetched. */
  fill(key: string, entry: ResidentEntry): Promise<Uint8Array | null>;
  /** The ACQUIRE barrier. */
  barrier(): Promise<boolean>;
}

export interface ResidentFilesystem extends RuntimeFsBridge {
  /** File bytes are held here, by revision: a codec over this filesystem keeps no copies of its own. */
  readonly holdsContent: true;
  /** Input from outside the process arrived: the barrier is owed before the next answer. */
  inbound(): void;
  /** Whether writes are held that the session does not have yet. */
  holding(): boolean;
  /**
   * Send every held write to the session, before something leaves the
   * process (a socket send): what it wrote is there before anyone hears from
   * it. A refusal stays recorded for the writer's close, fsync or settle.
   */
  flush(): Promise<void>;
  /**
   * fsync(2) through a descriptor this process holds no writes for (the
   * codec's own copy of a file): the file's held writes go to the session
   * first, and what they met is this call's answer.
   */
  syncInode(dev: number, ino: number): void | Promise<void>;
  /**
   * The end of a run: every held write goes to the session, and every refusal
   * not yet reported (by its descriptor's close or fsync) is returned, naming
   * the file, and forgotten.
   */
  settle(): Promise<UnsettledWrite[]>;
  /** What the process has asked so far, and who answered: a run's filesystem cost, in calls. */
  stats(): ResidentFilesystemStats;
}

/** A held file the session refused part of: what a run reports, naming the file. */
export interface UnsettledWrite {
  path: string;
  error: unknown;
}

/** Counts since the process started. Every `delegated` call is a round trip to the session. */
export interface ResidentFilesystemStats {
  /** Calls answered from the store. */
  local: number;
  /** Calls the session answered, by name. */
  delegated: Record<string, number>;
  /** Path lookups (one round trip each), directory listings (two each) and tree listings. */
  lookups: number;
  listings: number;
  treeListings: number;
  /** Files fetched into the store, and their bytes. */
  fills: number;
  filledBytes: number;
  /** ACQUIRE barriers taken. */
  barriers: number;
  /** Wall time the process spent waiting on the session for any of the above, in ms. */
  waitMs: number;
}

/** A held write goes to the session in pieces of this size: each fits one call. */
const WRITE_PIECE_BYTES = 1024 * 1024;

/** Listings one call may take before it gives the question to the authority. */
const MAX_LISTINGS_PER_CALL = 64;

/** What this adapter answers itself is decided here: anything else is the authority's. */
const DELEGATE = Symbol('delegate');
type Delegate = typeof DELEGATE;

/** A walk that met a name the store does not know. */
interface Unknown { readonly missing: string }

/** Where a path leads: its key, null for ELOOP, or DELEGATE when the authority must say. */
type Resolution = string | null | Delegate;

/**
 * A file this process created or truncated on the session's filesystem,
 * whose bytes it holds until the descriptor is closed (or synced), then
 * writes in one call: clang writes an object file in 181 writes and 31 seeks,
 * each of which was a round trip. The authority opened the file (so it exists,
 * with its identity, from the open on) and still owns the descriptor; the
 * file is known by that identity (dev, ino), never by a name a peer can reuse.
 */
interface HeldWrite {
  id: number;
  /** The descriptor's path, as the session names it in an error. */
  path: string;
  /** The session's stat of the file at open, its size aside. */
  stat: RuntimeVfsStat;
  /** Opened for reading too (O_RDWR): a read of a write-only descriptor is EBADF, as the session says. */
  readable: boolean;
  bytes: Uint8Array;
  length: number;
  position: number;
}

/** A directory the session opened for this process, read-only: listed here while its name still leads to it. */
interface OpenDirectory {
  key: string;
  dev: number;
  ino: number;
}

/** A file revision's bytes, shared by every descriptor opened on it. */
interface Revision {
  revision: number;
  bytes: Uint8Array;
}

/** The root of the namespace as the walk asks about it (the authority's rootStat, for what the walk reads). */
const ROOT_FOR_WALK = { type: 'directory', mode: 0o40755, uid: 0, gid: 0 } as const;

/** The calls that can change the namespace or bytes: after one, the barrier is owed. */
const MUTATIONS = new Set<keyof RuntimeFsBridge>([
  'writeFile', 'writeFileFrom', 'writeRange', 'truncate', 'utimes', 'chmod', 'chown', 'write', 'close', 'mkdir',
  'unlink', 'rmdir', 'rename', 'symlink', 'remove', 'copyFile', 'copyTree', 'ftruncate', 'fchmod', 'fchown',
  'futimes', 'appendOnce', 'acknowledgeAppend', 'writeBatch', 'writeStream',
]);

/** Those that name their file by descriptor; every other one names a path, and may name a held file. */
const DESCRIPTOR_MUTATIONS = new Set<keyof RuntimeFsBridge>(['write', 'close', 'ftruncate', 'fchmod', 'fchown', 'futimes']);

function after<T, R>(value: T | Promise<T>, next: (value: T) => R | Promise<R>): R | Promise<R> {
  return value instanceof Promise ? value.then(next) : next(value);
}

function keyOf(path: string): string {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
}

/** Every name on the way to `name` beneath `root`, as spelled: the root's own ancestors first, up to the first `..`. */
function prefixes(root: string, name: string): string[] {
  const parts: string[] = [];
  const keys: string[] = [];
  for (const segment of [...root.split('/'), ...name.split('/')]) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') break;
    parts.push(segment);
    keys.push(parts.join('/'));
  }
  return keys;
}

function parentKey(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

function statOf(entry: ResidentEntry): RuntimeVfsStat {
  return {
    dev: entry.dev, ino: entry.ino, nlink: entry.nlink, type: entry.type, size: entry.size,
    ctime: entry.ctime, atime: entry.atime, mtime: entry.mtime, mode: entry.mode, uid: entry.uid, gid: entry.gid,
    revision: entry.revision,
  };
}

const identity = (dev: number, ino: number): string => `${dev}:${ino}`;

export function residentFilesystem(session: RuntimeFsBridge, resident: ResidentNamespace): ResidentFilesystem {
  const counts: ResidentFilesystemStats = { local: 0, delegated: {}, lookups: 0, listings: 0, treeListings: 0, fills: 0, filledBytes: 0, barriers: 0, waitMs: 0 };
  // Every wait on the session is timed where it leaves: the authority's calls
  // and the store's listings, fills and barriers. A facet's clock moves only
  // across I/O, so this is the part of a run's wall time the filesystem cost.
  const timed = <T>(value: T): T => {
    if (!(value instanceof Promise)) return value;
    const started = Date.now();
    return value.finally(() => { counts.waitMs += Date.now() - started; }) as T;
  };
  const authority = new Proxy(session, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => timed(Reflect.apply(value, target, args));
    },
  });
  const store: ResidentNamespace = {
    get device() { return resident.device; },
    get cred() { return resident.cred; },
    ready: () => resident.ready(),
    entry: (key) => resident.entry(key),
    children: (key) => resident.children(key),
    list: (key) => timed(resident.list(key)),
    lookup: (keys, content) => timed(resident.lookup(keys, content)),
    listTree: (key) => timed(resident.listTree(key)),
    content: (key) => resident.content(key),
    fill: (key, entry) => timed(resident.fill(key, entry)),
    barrier: () => timed(resident.barrier()),
  };
  const delegated = (name: string): void => { counts.delegated[name] = (counts.delegated[name] ?? 0) + 1; };
  /** The barrier is owed: set by a change or by input, cleared only by a barrier that lands. */
  let owed = false;
  /** Writes held for the session's descriptors, by descriptor; and their total, against FACET_OWN_WRITE_MEMORY_BYTES. */
  const writes = new Map<number, HeldWrite>();
  let heldBytes = 0;
  /** Held writes the session refused, by descriptor, until reported (by that descriptor's close or fsync, or by settle). */
  const unsettled = new Map<number, UnsettledWrite>();
  /** The session's descriptors this process opened read-only: closing one changes nothing, so it owes no barrier. */
  const readers = new Set<number>();
  /** Of those, the directories, and where their listing is, once their fstat named them. */
  const pendingDirectories = new Map<number, string>();
  const directories = new Map<number, OpenDirectory>();
  /** File revisions handed out, by identity, so every descriptor on one shares one buffer; at most WASI_RESIDENT_FILE_CAP_BYTES in all. */
  const revisions = new Map<string, Revision>();
  let revisionBytes = 0;

  /** The held write of the file (dev, ino), if this process is writing it. */
  const heldFor = (dev: number, ino: number): HeldWrite | undefined => {
    let found: HeldWrite | undefined;
    for (const held of writes.values()) if (held.stat.ino === ino && held.stat.dev === dev) found = held;
    return found;
  };

  /**
   * Room for `held` to reach `length` bytes, or false when that would pass
   * what one held file or all of them may take: the file then goes to the
   * session and is written there.
   */
  const room = (held: HeldWrite, length: number): boolean => {
    if (length <= held.bytes.byteLength) return true;
    const size = Math.max(length, Math.min(held.bytes.byteLength * 2, WASI_RESIDENT_FILE_CAP_BYTES), 4096);
    if (length > WASI_RESIDENT_FILE_CAP_BYTES || heldBytes + size - held.bytes.byteLength > FACET_OWN_WRITE_MEMORY_BYTES) return false;
    const next = new Uint8Array(size);
    next.set(held.bytes.subarray(0, held.length));
    heldBytes += next.byteLength - held.bytes.byteLength;
    held.bytes = next;
    return true;
  };

  /**
   * Send what `held` holds through its descriptor, a piece at a time, and stop
   * holding it: the descriptor is the session's again, at the position the
   * program left it at. A refusal is kept for this descriptor until reported.
   */
  const release = async (held: HeldWrite, closing = false): Promise<void> => {
    writes.delete(held.id);
    heldBytes -= held.bytes.byteLength;
    try {
      for (let at = 0; at < held.length; at += WRITE_PIECE_BYTES) {
        await authority.write(held.id, at, held.bytes.slice(at, Math.min(held.length, at + WRITE_PIECE_BYTES)));
      }
      // A descriptor about to close has no position to keep: one trip fewer per file.
      if (!closing && held.position !== 0) await authority.seek(held.id, held.position, 'set');
    } catch (error) {
      unsettled.set(held.id, { path: held.path, error });
    } finally {
      owed = true;
    }
  };

  /** Send every held write (those matching `which`) to the session. Refusals stay recorded until reported. */
  const flush = async (which: (held: HeldWrite) => boolean = () => true): Promise<void> => {
    for (const held of [...writes.values()]) if (which(held)) await release(held);
  };

  /** Report, once, a refusal an earlier release left on `handleId`. */
  const reportUnsettled = (handleId: number): void => {
    const failure = unsettled.get(handleId);
    if (failure === undefined) return;
    unsettled.delete(handleId);
    throw failure.error;
  };

  /**
   * One walk over what the store knows: the resolved key, ELOOP (null), a
   * directory to list first, or DELEGATE when the walk reaches what this
   * adapter does not answer. The authority's refusals are thrown as its own.
   */
  const walkOnce = (root: string, name: string, follow: boolean): string | null | Unknown | Delegate => {
    const walk = walkBeneath(root, { root, path: name, beneath: true }, follow, store.cred, () => false);
    for (let step = walk.next(); ;) {
      if (step.done) return step.value;
      const lookup = step.value;
      if ('readlink' in lookup) {
        const entry = store.entry(keyOf(lookup.readlink));
        if (!entry || entry.type !== 'symlink' || entry.target === null) return DELEGATE;
        step = walk.next(entry.target);
        continue;
      }
      const key = keyOf(lookup.stat);
      if (key === '') { step = walk.next(ROOT_FOR_WALK); continue; }
      const entry = store.entry(key);
      if (entry === undefined) return { missing: key };
      if (entry !== null && entry.dev !== store.device) return DELEGATE;
      step = walk.next(entry === null ? null : { type: entry.type, mode: entry.mode, uid: entry.uid, gid: entry.gid });
    }
  };

  /** Where an open directory's listing is, while its name still leads to the directory the session opened. */
  const directoryKey = (handleId: number): string | undefined => {
    const open = directories.get(handleId);
    if (open === undefined) return undefined;
    const entry = store.entry(open.key);
    return entry && entry.type === 'directory' && entry.dev === open.dev && entry.ino === open.ino ? open.key : undefined;
  };

  /** Where a path leads (its key), listing what the walk needs; DELEGATE for what this adapter does not answer. */
  const resolve = (path: RuntimeFsPath, follow: boolean, content = false): Resolution | Promise<Resolution> => {
    let root: string;
    let name: string;
    if (typeof path === 'string') {
      if (path.split('/').includes('..')) return DELEGATE;
      root = '';
      name = keyOf(path);
    } else if ('root' in path) {
      root = keyOf(path.root);
      name = path.path;
    } else {
      const key = directoryKey(path.directory);
      if (key === undefined) return DELEGATE;
      root = key;
      name = path.path;
    }
    // A name the store does not know is looked up first, with every name on
    // the way to it as spelled (one round trip however deep); a name that is
    // still not known is not there or past a link, and its directory is
    // listed (which also says what is absent in it).
    const looked = new Set<string>();
    const attempt = (asked: number): Resolution | Promise<Resolution> => {
      const walked = walkOnce(root, name, follow);
      if (walked === null || walked === DELEGATE || typeof walked === 'string') return walked;
      if (asked >= MAX_LISTINGS_PER_CALL) return DELEGATE;
      if (!looked.has(walked.missing)) {
        const spelled = prefixes(root, name).filter((key) => !looked.has(key) && store.entry(key) === undefined);
        const keys = spelled.includes(walked.missing) ? spelled.slice(spelled.indexOf(walked.missing)) : [walked.missing];
        for (const key of keys) looked.add(key);
        counts.lookups++;
        // The bytes of what the call names, when it is a small file: a stat is followed by an open.
        const target = spelled[spelled.length - 1];
        return store.lookup(keys, content && keys[keys.length - 1] === target)
          .then((known) => (known ? attempt(asked + 1) : DELEGATE));
      }
      counts.listings++;
      return store.list(parentKey(walked.missing)).then((listed) => (listed ? attempt(asked + 1) : DELEGATE));
    };
    return attempt(0);
  };

  /** The entry a resolved key names, or undefined when the store cannot say (the authority answers). */
  const entryAt = (key: string): ResidentEntry | null | undefined => {
    const entry = store.entry(key);
    if (entry === undefined) return undefined;
    if (entry !== null && entry.dev !== store.device) return undefined;
    // What this process has written to this file and not yet sent is what it reads back.
    if (entry === null || entry.type !== 'file') return entry;
    const held = heldFor(entry.dev, entry.ino);
    return held === undefined ? entry : { ...entry, size: held.length };
  };

  /**
   * A file's bytes: what this process is writing to it, else the revision's
   * shared buffer, else the store's (fetched into it). Undefined when only
   * the authority can read them.
   */
  const contentOf = (key: string, entry: ResidentEntry): Uint8Array | undefined | Promise<Uint8Array | undefined> => {
    const writing = heldFor(entry.dev, entry.ino);
    if (writing !== undefined) return writing.bytes.slice(0, writing.length);
    const id = identity(entry.dev, entry.ino);
    const shared = revisions.get(id);
    if (shared !== undefined && shared.revision === entry.revision) {
      revisions.delete(id);
      revisions.set(id, shared);
      return shared.bytes;
    }
    const keep = (bytes: Uint8Array | null | undefined): Uint8Array | undefined => {
      if (bytes === null || bytes === undefined || bytes.byteLength !== entry.size) return undefined;
      if (shared !== undefined) { revisions.delete(id); revisionBytes -= shared.bytes.byteLength; }
      for (const [oldest, revision] of revisions) {
        if (revisionBytes + bytes.byteLength <= WASI_RESIDENT_FILE_CAP_BYTES) break;
        revisions.delete(oldest);
        revisionBytes -= revision.bytes.byteLength;
      }
      if (revisionBytes + bytes.byteLength <= WASI_RESIDENT_FILE_CAP_BYTES) {
        revisions.set(id, { revision: entry.revision, bytes });
        revisionBytes += bytes.byteLength;
      }
      return bytes;
    };
    const held = store.content(key);
    if (held !== undefined && held.byteLength === entry.size) return keep(held);
    counts.fills++;
    counts.filledBytes += entry.size;
    return store.fill(key, entry).then(keep);
  };

  /**
   * Answer from the store when it can, else from the authority: the barrier
   * first when one is owed, then `local`, whose DELEGATE hands the call on.
   */
  const answer = <T>(name: string, local: () => T | Delegate | Promise<T | Delegate>, remote: () => T | Promise<T>): T | Promise<T> => {
    const settle = (value: T | Delegate): T | Promise<T> => {
      if (value !== DELEGATE) { counts.local++; return value; }
      delegated(name);
      return remote();
    };
    if (!store.ready()) { delegated(name); return remote(); }
    if (owed) {
      counts.barriers++;
      return store.barrier().then((ok) => {
        // Still owed until a barrier lands: this call is the session's, and so is the next one's question.
        if (!ok || !store.ready()) { delegated(name); return remote(); }
        owed = false;
        return after(local(), settle);
      });
    }
    return after(local(), settle);
  };

  /** The authority, for a call that may change what the store holds: the barrier is owed once it returns. */
  const changing = <T>(name: string, call: () => T | Promise<T>): T | Promise<T> => {
    delegated(name);
    try {
      return after(call(), (value) => { owed = true; return value; });
    } catch (error) {
      owed = true;
      throw error;
    }
  };

  const fs: ResidentFilesystem = Object.create(null);
  // Every call this adapter does not answer goes to the authority as it came,
  // whether the bridge carries its calls itself or on its class.
  const names = new Set<string>();
  for (let at: object | null = session; at !== null && at !== Object.prototype; at = Reflect.getPrototypeOf(at)) {
    for (const name of Reflect.ownKeys(at)) if (typeof name === 'string' && name !== 'constructor') names.add(name);
  }
  for (const name of names) {
    const value: unknown = Reflect.get(authority, name);
    if (typeof value !== 'function') continue;
    const call = (...args: unknown[]): unknown => Reflect.apply(value, authority, args);
    const mutates = MUTATIONS.has(name as keyof RuntimeFsBridge);
    // A change by path (a rename of the file being written, a copy of it)
    // acts on what the session has: what is held goes first.
    const byPath = mutates && !DESCRIPTOR_MUTATIONS.has(name as keyof RuntimeFsBridge);
    Reflect.set(fs, name, mutates
      ? (...args: unknown[]) => (byPath && writes.size > 0
        ? flush().then(() => changing(name, () => call(...args)))
        : changing(name, () => call(...args)))
      : (...args: unknown[]) => { delegated(name); return call(...args); });
  }
  Reflect.set(fs, 'synchronous', authority.synchronous);

  Reflect.set(fs, 'holdsContent', true);
  fs.inbound = () => { owed = true; };
  fs.holding = () => writes.size > 0;
  fs.flush = () => flush();
  fs.settle = async () => {
    await flush();
    const failures = [...unsettled.values()];
    unsettled.clear();
    return failures;
  };
  fs.syncInode = (dev, ino) => {
    const ids = [...writes.values()].filter((held) => held.stat.dev === dev && held.stat.ino === ino).map((held) => held.id);
    const refusal = () => {
      // fsync(2) on any descriptor of a file reports what its writes met; the writer's own close still reports it too.
      for (const id of ids) {
        const failure = unsettled.get(id);
        if (failure !== undefined) throw failure.error;
      }
    };
    if (ids.length === 0) return;
    return flush((held) => ids.includes(held.id)).then(refusal);
  };
  fs.stats = () => ({ ...counts, delegated: { ...counts.delegated } });

  fs.stat = (path, options = {}) => answer<RuntimeVfsStat | null>('stat', () => {
    const follow = options.followSymlinks !== false;
    const finish = (key: Resolution): RuntimeVfsStat | null | Delegate => {
      if (key === DELEGATE || key === '') return DELEGATE;
      if (key === null) throw fsError('ELOOP', follow ? 'stat' : 'lstat', path);
      const entry = entryAt(key);
      if (entry === undefined) return DELEGATE;
      return entry === null ? null : statOf(entry);
    };
    // A component missing on the way is "not there", as the authority's stat says.
    const absent = (error: unknown): null => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    };
    try {
      const resolved = resolve(path, follow, true);
      return resolved instanceof Promise ? resolved.then(finish, absent) : finish(resolved);
    } catch (error) {
      return absent(error);
    }
  }, () => authority.stat(path, options));

  /** The session is to answer for this file: when this process holds writes to it, they go first. */
  const toSession = (entry: ResidentEntry): Delegate | Promise<Delegate> => {
    if (heldFor(entry.dev, entry.ino) === undefined) return DELEGATE;
    return flush((held) => held.stat.dev === entry.dev && held.stat.ino === entry.ino).then(() => DELEGATE);
  };

  fs.readFile = (path, options = {}) => answer<Uint8Array | null>('readFile', () => after(resolve(path, options.followSymlinks !== false, true), (key) => {
    if (key === DELEGATE || key === '') return DELEGATE;
    if (key === null) return null;
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    if (entry === null) return null;
    // As the authority checks: permission before what kind of name it is.
    if (!modeAllows(entry, 4, store.cred)) throw fsError('EACCES', 'open', path);
    if (entry.type === 'directory') throw fsError('EISDIR', 'open', path);
    if (entry.type !== 'file' || entry.size > WASI_RESIDENT_FILE_CAP_BYTES) return toSession(entry);
    return after(contentOf(key, entry), (bytes) => (bytes === undefined ? DELEGATE : bytes));
  }), () => authority.readFile(path, options));

  fs.readdir = (path, options = {}) => answer<RuntimeVfsDirEntry[]>('readdir', () => after(resolve(path, options.followSymlinks !== false), (key) => {
    if (key === DELEGATE || key === '' || key === null) return DELEGATE;
    const entry = entryAt(key);
    if (entry === undefined || entry === null) return DELEGATE;
    if (entry.type !== 'directory') return DELEGATE;
    if (!modeAllows(entry, 4, store.cred)) return DELEGATE;
    return after(listingOf(key), (entries) => (entries === DELEGATE ? DELEGATE : byLocale(entries)));
  }), () => authority.readdir(path, options));

  /** The names in directory `key`; a tree walker gets the whole tree listed at once. */
  const listingOf = (key: string): RuntimeVfsDirEntry[] | Delegate | Promise<RuntimeVfsDirEntry[] | Delegate> => {
    const known = store.children(key);
    if (known !== undefined) return known;
    counts.treeListings++;
    return store.listTree(key)
      .then((whole) => (whole ? true : store.list(key)))
      .then((listed) => {
        const children = listed ? store.children(key) : undefined;
        return children === undefined ? DELEGATE : children;
      });
  };

  // The session lists a directory by name in locale order, and through a
  // descriptor in the filesystem's own (code unit) order: each is kept.
  const byLocale = (entries: RuntimeVfsDirEntry[]): RuntimeVfsDirEntry[] => [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const byCodeUnit = (entries: RuntimeVfsDirEntry[]): RuntimeVfsDirEntry[] => [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  fs.readlink = (path) => answer<string | null>('readlink', () => after(resolve(path, false), (key) => {
    if (key === DELEGATE || key === '') return DELEGATE;
    if (key === null) return null;
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    return entry !== null && entry.type === 'symlink' && entry.target !== null ? entry.target : null;
  }), () => authority.readlink(path));

  fs.realpath = (path) => answer<string>('realpath', () => after(resolve(path, true), (key) => {
    if (key === DELEGATE || key === '') return DELEGATE;
    if (key === null) throw fsError('ELOOP', 'realpath', path);
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    if (entry === null) throw fsError('ENOENT', 'realpath', path);
    return '/' + key;
  }), () => authority.realpath(path));

  fs.open = (path, flags: RuntimeOpenFlags) => {
    const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
    if (!readOnly) {
      // Whatever this process holds is the file's content before a writer
      // opens it: a second r+ reads it, and a second O_TRUNC empties it.
      const opening = (): RuntimeFileHandle | Promise<RuntimeFileHandle> => changing('open', () => authority.open(path, flags));
      const opened = writes.size > 0 ? flush().then(opening) : opening();
      // A new or emptied file on the session's own filesystem: its writes are held (HeldWrite).
      const whole = !!flags.write && !flags.append && (!!flags.truncate || (!!flags.create && !!flags.exclusive));
      if (!whole || !store.ready()) return opened;
      return after(opened, (handle) => after(authority.fstat(handle.id), (stat) => {
        delegated('fstat');
        if (stat.type === 'file' && stat.dev === store.device) {
          writes.set(handle.id, { id: handle.id, path: handle.path, stat, readable: !!flags.read, bytes: new Uint8Array(0), length: 0, position: 0 });
        }
        return handle;
      }));
    }
    // A read-only open is the session's descriptor; a file this process is
    // writing goes to the session first, so the descriptor reads all of it.
    const opening = (): RuntimeFileHandle | Promise<RuntimeFileHandle> => after(authority.open(path, flags), (handle) => {
      readers.add(handle.id);
      pendingDirectories.set(handle.id, keyOf(handle.path));
      return handle;
    });
    delegated('open');
    return writes.size > 0 ? flush().then(opening) : opening();
  };

  fs.fstat = (handleId) => {
    const held = writes.get(handleId);
    if (held !== undefined) {
      counts.local++;
      return { ...held.stat, size: held.length };
    }
    delegated('fstat');
    return after(authority.fstat(handleId), (stat) => {
      // A directory opened read-only is listed here while its name still leads to it.
      const key = pendingDirectories.get(handleId);
      if (key !== undefined) {
        pendingDirectories.delete(handleId);
        if (stat.type === 'directory' && stat.dev === store.device) directories.set(handleId, { key, dev: stat.dev, ino: stat.ino });
      }
      return stat;
    });
  };

  fs.read = (handleId, offset, length) => {
    const held = writes.get(handleId);
    if (held === undefined) { delegated('read'); return authority.read(handleId, offset, length); }
    if (!held.readable) throw fsError('EBADF', 'read', held.path);
    counts.local++;
    const start = Math.min(offset ?? held.position, held.length);
    const chunk = held.bytes.slice(start, Math.min(held.length, start + length));
    if (offset === null) held.position = start + chunk.byteLength;
    return chunk;
  };

  fs.seek = (handleId, offset, whence) => {
    const held = writes.get(handleId);
    if (held === undefined) { delegated('seek'); return authority.seek(handleId, offset, whence); }
    counts.local++;
    const position = (whence === 'set' ? 0 : whence === 'current' ? held.position : held.length) + offset;
    if (position < 0) throw fsError('EINVAL', 'lseek', held.path);
    held.position = position;
    return position;
  };

  fs.write = (handleId, offset, bytes) => {
    const held = writes.get(handleId);
    if (held === undefined) return changing('write', () => authority.write(handleId, offset, bytes));
    const start = offset ?? held.position;
    const end = start + bytes.byteLength;
    if (!room(held, end)) {
      // Past what may be held: what is held goes now, and this write after it.
      return release(held).then(() => {
        reportUnsettled(handleId);
        return changing('write', () => authority.write(handleId, offset, bytes));
      });
    }
    counts.local++;
    // A write past the end leaves zeros between, as the file would.
    if (start > held.length) held.bytes.fill(0, held.length, start);
    held.bytes.set(bytes, start);
    held.length = Math.max(held.length, end);
    if (offset === null) held.position = end;
    return bytes.byteLength;
  };

  fs.ftruncate = (handleId, size) => {
    const held = writes.get(handleId);
    if (held === undefined) return changing('ftruncate', () => authority.ftruncate(handleId, size));
    if (!room(held, size)) {
      return release(held).then(() => {
        reportUnsettled(handleId);
        return changing('ftruncate', () => authority.ftruncate(handleId, size));
      });
    }
    counts.local++;
    if (size > held.length) held.bytes.fill(0, held.length, size);
    held.length = size;
  };

  fs.close = (handleId) => {
    const held = writes.get(handleId);
    // The descriptor closes either way; a write the session refused is the close's error, as on a network filesystem.
    const closing = () => after(changing('close', () => authority.close(handleId)), () => reportUnsettled(handleId));
    if (held !== undefined) return release(held, true).then(closing);
    if (unsettled.has(handleId)) return closing();
    if (readers.delete(handleId)) {
      pendingDirectories.delete(handleId);
      directories.delete(handleId);
      delegated('close');
      return authority.close(handleId);
    }
    return closing();
  };

  fs.readdirHandle = (handleId) => answer<RuntimeVfsDirEntry[]>('readdirHandle', () => {
    const key = directoryKey(handleId);
    if (key === undefined) return DELEGATE;
    return after(listingOf(key), (entries) => (entries === DELEGATE ? DELEGATE : byCodeUnit(entries)));
  }, () => authority.readdirHandle(handleId));

  fs.fsync = (handleId) => {
    if (handleId === undefined) return flush().then(() => authority.fsync());
    // Synced means in the session: what is held goes now, and the descriptor writes through after.
    const held = writes.get(handleId);
    const synced = () => { reportUnsettled(handleId); delegated('fsync'); return authority.fsync(handleId); };
    return held === undefined ? synced() : release(held).then(synced);
  };

  for (const name of ['fchmod', 'fchown', 'futimes', 'dup'] as const) {
    const passed: unknown = Reflect.get(fs, name);
    if (typeof passed !== 'function') continue;
    Reflect.set(fs, name, (handleId: number, ...rest: unknown[]) => {
      // Anything but a write or a truncate of a held file sends what is held first.
      const held = writes.get(handleId);
      if (held !== undefined) return release(held).then(() => { reportUnsettled(handleId); return Reflect.apply(passed, fs, [handleId, ...rest]); });
      return Reflect.apply(passed, fs, [handleId, ...rest]);
    });
  }

  return fs;
}
