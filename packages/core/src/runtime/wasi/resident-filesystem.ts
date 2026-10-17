/**
 * A WASI process's filesystem, answered from the process's own copy of the
 * namespace where that copy can answer, and by the authority everywhere else.
 *
 * Every filesystem syscall a guest makes is a call to the session: measured
 * on a throwaway (2026-10-05), 5.9-12.7 ms for one `os.stat` from Python, so
 * a program that stats a tree pays for each name with a round trip. The
 * process already carries a store for names and bytes
 * (worker vfs/resident, the one a node process reads its
 * synchronous calls from). This adapter puts the codec's calls in front of
 * it: a lookup, a stat, a directory listing and its descriptor, and a file's
 * bytes (which the codec holds for a read-only descriptor, its ResidentFd) are
 * answered from the store; anything that changes the filesystem, and anything
 * the store cannot vouch for, goes to the authority exactly as before. The
 * store is the process's one copy of file bytes, under its one budget: a
 * descriptor the codec answers itself pins the bytes it reads for its
 * lifetime (`pinContent`), charged to that budget, and past it the codec
 * opens the session's descriptor instead.
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

import type { Awaitable, RuntimeFileHandle, RuntimeFsBridge, RuntimeOpenedFile, RuntimeFsPath, RuntimeMutationOwner, RuntimeOpenFlags, RuntimeReopenTarget, RuntimeSynchronousFs, RuntimeVfsDirEntry, RuntimeVfsStat } from '../os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import { fsError, walkBeneath } from '../beneath-walk.js';
import { modeAllows } from '../../vfs/posix-access.js';
import { openIdentified } from './filesystem.js';
import { WASI_RESIDENT_FILE_CAP_BYTES, DIRECTORY_BATCH_LIMIT, FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES } from '../../constants.js';
import { RESIDENT_PAGE_BYTES } from '@nimbus-sh/platform/limits.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import { delegationHolder, type DelegationHolder } from './delegation-holder.js';
import { readDirectoryPool, type ReadDirectoryPool } from './read-directory-pool.js';
import type { ReadDirectorySupervisor } from '../read-directory-batch.js';
import type { VfsAcquireResult } from '../os-contracts.js';
import type { ProcessFsJournal, ProcessFsOp, ProcessFsSession, ProcessFsStats } from '../../_shared/process-fs-client.js';

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
  /**
   * The bytes of file `key` the store holds, or undefined; with `revision`,
   * only bytes dated at it or later (or the facet's own): a read of older
   * bytes that landed after a barrier admitted the change is not served.
   */
  content(key: string, revision?: number): Uint8Array | undefined;
  /** Fetch file `key`'s bytes (at `entry`'s revision) into the store; null when they could not be fetched. */
  fill(key: string, entry: ResidentEntry): Promise<Uint8Array | null>;
  /**
   * Pages `first`..`last` (RESIDENT_PAGE_BYTES each) of file `key`, `size`
   * bytes at revision `revision`: held ones from the store, the rest read
   * pinned to that revision and held, with how many were read. Null when
   * the file is no longer at `revision` or a read failed.
   */
  pages(key: string, revision: number, size: number, first: number, last: number): Promise<{ pages: Uint8Array[]; fetched: number } | null>;
  /** Fetch these files' bytes (each at its entry's revision) into the store in batched round trips. */
  fillMany(files: ReadonlyArray<readonly [string, ResidentEntry]>): Promise<void>;
  /** The ACQUIRE barrier. */
  barrier(): Promise<boolean>;
  /** The same provenance cursor and ACQUIRE admission used by the normal barrier. */
  cursor(): { epoch: string; rev: number } | null;
  admit(answer: VfsAcquireResult): Promise<boolean>;
  /** Charge `bytes` of heap held outside the store to its budget: false when they do not fit. */
  reserve(bytes: number): boolean;
  /** Return what `reserve` charged. */
  release(bytes: number): void;
}

/** A file's bytes, kept for a descriptor's lifetime: `release` when it closes. */
export interface PinnedContent {
  bytes: Uint8Array;
  release(): void;
  /** The name it was pinned at, which an open of /dev/fd/N opens it again by while that name has it (openIdentified). */
  name: string;
}

export interface ResidentFilesystem extends RuntimeFsBridge {
  /**
   * The same filesystem for a caller that cannot wait: each call answered
   * now from what this process holds and has decided, or refused before it
   * begins anything (EAGAIN: what it needs is the session's, not resident;
   * the name's own state where the view knows it). Never a promise.
   */
  readonly synchronous: RuntimeSynchronousFs;
  /**
   * The bytes of the file `path` names, which `stat` describes, kept for a
   * descriptor until it releases them: one buffer per revision however many
   * descriptors read it, charged once to the store's budget. Null when they
   * cannot be (the file changed, or the budget is spent): the caller opens
   * the session's descriptor instead.
   */
  pinContent(path: RuntimeFsPath, stat: RuntimeVfsStat): PinnedContent | null | Promise<PinnedContent | null>;
  /** Input from outside the process arrived: the barrier is owed before the next answer. */
  inbound(): void;
  /** A park's deadline elapsed; never install an abandoned directory open's late answer. */
  cancelPendingDirectories(): void;
  /** Whether writes are held that the session does not have yet. */
  holding(): boolean;
  /** What the process decided and has not logged, logged now into its own log, with no round trip (DelegationHolder.logHeld). */
  logHeld(): void;
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
  /** The directories this process opened, in order (bounded): the next run's in the same facet (ResidentDelegation.walked). */
  walked(): readonly string[];
}

/** A held file the session refused part of: what a run reports, naming the file. */
export interface UnsettledWrite {
  path: string;
  /** The file's identity: an fsync through any descriptor of it reports the refusal too. */
  dev: number;
  ino: number;
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
  /** Files fetched into the store, and their bytes; of those, fetched ahead of their reads (and with the read that asked). */
  fills: number;
  filledBytes: number;
  readAhead: number;
  /** Reads of files too big to hold whole answered through the store's pages, and the pages the session was asked for. */
  pagedReads: number;
  pagesFetched: number;
  /** ACQUIRE barriers taken. */
  barriers: number;
  /** Wall time the process spent waiting on the session for any of the above, in ms. */
  waitMs: number;
  /** Session interactions begun: calls, listings, lookups, fills, pages and barriers. */
  sessionCalls: number;
  /** Synchronous calls refused because they needed the session (not resident). */
  notResident: number;
  /** File bytes pinned for descriptors now, and how many buffers hold them. */
  pinnedBytes: number;
  pins: number;
  /** What its provisional decisions keep of the store's budget now, as they cost it (Provisional.kept): with pinnedBytes, all it has taken. */
  provisionalBytes: number;
  /** Its filesystem client's waves, grants and recalls, when it holds delegations. */
  client?: ProcessFsStats;
}

/** Listings one call may take before it gives the question to the authority. */
const MAX_LISTINGS_PER_CALL = 64;
/** Barriers one walk takes before the session answers the call: what is owed keeps growing while each lands. */
const MAX_CATCH_UPS_PER_CALL = 3;

/** Directory opens a run records for the next run in its facet (ResidentFilesystem.walked). */
const WALKED_DIRECTORIES = 1024;

/**
 * Read-ahead of a directory's files, earned by its misses. A program that
 * reads a directory's files one after another (rolldown loading modules,
 * an interpreter importing) pays a round trip for each it does not hold:
 * Vite 8 pre-bundling lucide-react read 2,145 modules in 30.5 s, and in
 * 8.3 s with the same files fetched ahead (throwaway, 2026-10-07). From a
 * directory's second miss, a fill brings with it the directory's next files
 * of the missed file's extension (in descriptor order after it, then from
 * the directory's first), a window that doubles with each further miss there. A program that reads one file
 * of a directory fetches only that file. Bounded per file, per batch (one
 * fsReadBatch) and per process.
 */
const READ_AHEAD_FIRST = 8;
const READ_AHEAD_FILE_BYTES = 256 * 1024;
const READ_AHEAD_PROCESS_BYTES = 32 * 1024 * 1024;

/** A name's extension, with its dot ('.mjs'), or '' when it has none. */
function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/** What this adapter answers itself is decided here: anything else is the authority's. */
const DELEGATE = Symbol('delegate');
type Delegate = typeof DELEGATE;

/** A walk that met a name the store does not know. */
interface Unknown { readonly missing: string }

/** Where a path leads: its key, null for ELOOP, or DELEGATE when the authority must say. */
type Resolution = string | null | Delegate;

/** A mutation's walk: the key it reached, and every name it looked up on the way, in order. */
interface Walk { readonly key: string; readonly crossed: readonly string[] }

/** Bytes pinned for descriptors: one buffer per file revision (or held version), and how many hold it. The pin is the only owner of the buffer. */
interface Pin {
  bytes: Uint8Array;
  holders: number;
}

/** A directory the session opened for this process, read-only: listed here while its name still leads to it. */
interface OpenDirectory {
  key: string;
  dev: number;
  ino: number;
}

/** The root of the namespace as the walk asks about it (the authority's rootStat, for what the walk reads). */
const ROOT_FOR_WALK = { type: 'directory', mode: 0o40755, uid: 0, gid: 0 } as const;

/**
 * The session's calls that can change a name or an access: before one, the
 * files this process holds open write through (DelegationHolder.changing),
 * so their opens are decided as they were.
 */
const NAME_OR_ACCESS_CHANGES = new Set<string>([
  'chmod', 'chown', 'fchmod', 'fchown', 'rename', 'unlink', 'rmdir', 'remove', 'copyFile', 'copyTree', 'writeBatch', 'writeStream',
]);

/** The calls that can change the namespace or bytes: after one, the barrier is owed. */
const MUTATIONS = new Set<keyof RuntimeFsBridge>([
  'writeFile', 'writeFileFrom', 'writeRange', 'truncate', 'utimes', 'chmod', 'chown', 'write', 'close', 'mkdir',
  'unlink', 'rmdir', 'rename', 'symlink', 'remove', 'copyFile', 'copyTree', 'ftruncate', 'fchmod', 'fchown',
  'futimes', 'writeBatch', 'writeStream',
]);

const DESCRIPTOR_CALLS = new Set<string>(['read', 'write', 'close', 'fstat', 'dup', 'seek', 'setStatus', 'readdirHandle', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'fsync']);

/**
 * Thrown where a call that must answer now (ResidentFilesystem.synchronous)
 * would begin waiting on the session, before anything it would have done.
 */
const NOT_NOW: unique symbol = Symbol('not now');
const notNow = (): never => { throw NOT_NOW; };

/** A bridge's calls with no synchronous form (RuntimeSynchronousFs). */
const NO_SYNCHRONOUS_FORM = new Set<string>(['synchronous', 'subscribe', 'writeStream', 'writeBatch', 'writeFileFrom', 'acquire', 'copyTree', 'gateLaunch', 'awaitRecall']);

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

/**
 * What makes the process a delegation's holder (delegation-holder.ts): the
 * session calls it takes and answers recalls with, and which keys are home
 * directories (never held themselves).
 */
export interface ResidentDelegation {
  readonly session: ProcessFsSession;
  /** Mutations in a subtree before it is taken (the client's GRANT_AFTER). */
  readonly grantAfter?: number;
  /** Inode numbers a first grant reserves (the client's GRANT_INOS). */
  readonly grantInos?: number;
  readonly isHomeRoot?: (key: string) => boolean;
  /** The process's live umask, for what a caller that cannot wait makes outside a held subtree (HolderOptions.umask). */
  readonly umask?: () => number;
  /** The process's own store's write log (HolderOptions.journal). */
  readonly journal?: ProcessFsJournal;
  readonly readDirectories?: ReadDirectorySupervisor['fsReadDirectories'];
  /**
   * The directories the last process in this facet opened, in order (its
   * walked()): a run that repeats it (git status, again) opens them again,
   * so the batch prefetches them first. A guess: each prefetched
   * description is admitted only if the namespace still vouches for it.
   */
  readonly walked?: readonly string[];
}

export function residentFilesystem(session: RuntimeFsBridge, resident: ResidentNamespace, delegation?: ResidentDelegation): ResidentFilesystem {
  let directoryPool: ReadDirectoryPool | null = null;
  const counts: ResidentFilesystemStats = { local: 0, delegated: {}, lookups: 0, listings: 0, treeListings: 0, fills: 0, filledBytes: 0, readAhead: 0, barriers: 0, waitMs: 0, sessionCalls: 0, notResident: 0, pinnedBytes: 0, pins: 0, provisionalBytes: 0, pagedReads: 0, pagesFetched: 0 };
  /** A call of `synchronous` is running: it answers now or not at all (NOT_NOW). */
  let now = false;
  // Every session interaction begins here, given as what would begin it: the
  // authority's calls and the store's listings, lookups, fills, pages and
  // barriers. One that must answer now is refused before it begins (NOT_NOW).
  // Each wait is timed: a facet's clock moves only across I/O, so this is the
  // part of a run's wall time the filesystem cost.
  const begin = <T>(io: () => T): T => {
    if (now) throw NOT_NOW;
    counts.sessionCalls++;
    const value = io();
    if (!(value instanceof Promise)) return value;
    const started = Date.now();
    return value.finally(() => { counts.waitMs += Date.now() - started; directoryPool?.io(); }) as T;
  };
  // The subtrees this process holds, when it may hold any (it waits in its
  // syscalls): what it decided there is answered here and sent later.
  let holder: DelegationHolder | null = null;
  const authority = new Proxy(session, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      // Whatever the session is asked, it has what this process decided first.
      // A refusal it met is the next sync's to report, not this call's.
      return (...args: unknown[]) => {
        if (now) throw NOT_NOW;
        if (typeof name === 'string' && DESCRIPTOR_CALLS.has(name) && typeof args[0] === 'number' && directoryPool?.closed(args[0])) {
          throw fsError('EBADF', name, String(args[0]));
        }
        for (const arg of args) {
          if (arg && typeof arg === 'object' && 'directory' in arg && 'path' in arg
            && typeof arg.directory === 'number' && typeof arg.path === 'string' && directoryPool?.closed(arg.directory)) {
            throw fsError('EBADF', String(name), String(arg.directory));
          }
        }
        if (holder !== null && typeof name === 'string' && NAME_OR_ACCESS_CHANGES.has(name)) holder.changing();
        return holder !== null && holder.pending()
          ? begin(() => holder!.send().then(() => Reflect.apply(value, target, args)))
          : begin(() => Reflect.apply(value, target, args));
      };
    },
  });
  const store: ResidentNamespace = {
    get device() { return resident.device; },
    get cred() { return resident.cred; },
    ready: () => resident.ready(),
    // What this process decided in a subtree it holds is what it sees there.
    entry: (key) => {
      const own = holder?.entry(key);
      return own !== undefined ? own : resident.entry(key);
    },
    children: (key) => (holder === null ? resident.children(key) : holder.children(key, resident.children(key))),
    list: (key) => begin(() => resident.list(key)),
    lookup: (keys, content) => begin(() => resident.lookup(keys, content)),
    listTree: (key) => begin(() => resident.listTree(key)),
    content: (key, revision) => resident.content(key, revision),
    fill: (key, entry) => begin(() => resident.fill(key, entry)),
    pages: (key, revision, size, first, last) => begin(() => resident.pages(key, revision, size, first, last)),
    fillMany: (files) => begin(() => resident.fillMany(files)),
    // A barrier that lands retires what this process changed and the session answered before it began.
    barrier: () => {
      const begun = holder?.barrierBegun();
      return begin(() => resident.barrier()).then((ok) => {
        if (ok && begun !== undefined) holder!.retire(begun);
        return ok;
      });
    },
    cursor: () => resident.cursor(),
    admit: (answer) => resident.admit(answer),
    reserve: (bytes) => resident.reserve(bytes),
    release: (bytes) => resident.release(bytes),
  };
  const delegated = (name: string): void => { counts.delegated[name] = (counts.delegated[name] ?? 0) + 1; };
  /**
   * What the barrier is owed: one more for each change, input, or send of
   * this process's (a grant given back with it); `caughtUp` is as much of it
   * as a barrier that landed covered, which is what was owed when it began.
   */
  let owed = 0;
  let caughtUp = 0;
  const owes = (): boolean => owed > caughtUp;
  /** The barrier, for what is owed now: true once it lands (a debt made while it ran is owed still). */
  const catchUp = (): Promise<boolean> => {
    const at = owed;
    counts.barriers++;
    return store.barrier().then((ok) => {
      if (!ok || !store.ready()) return false;
      caughtUp = Math.max(caughtUp, at);
      return true;
    });
  };
  if (delegation !== undefined) {
    holder = delegationHolder({
      session: delegation.session,
      // The holder reads the store itself, its own decisions aside.
      store: {
        get device() { return resident.device; },
        get cred() { return resident.cred; },
        entry: (key) => resident.entry(key),
        children: (key) => resident.children(key),
        content: (key, revision) => resident.content(key, revision),
        reserve: (bytes) => resident.reserve(bytes),
        release: (bytes) => resident.release(bytes),
      },
      isHomeRoot: delegation.isHomeRoot,
      ...(delegation.grantAfter === undefined ? {} : { grantAfter: delegation.grantAfter }),
      ...(delegation.grantInos === undefined ? {} : { grantInos: delegation.grantInos }),
      ...(delegation.journal === undefined ? {} : { journal: delegation.journal }),
      ...(delegation.umask === undefined ? {} : { umask: delegation.umask }),
      // A call of the synchronous view decides what no held subtree does, provisionally.
      cannotWait: () => now,
      // What it sent changed the session: the store catches up before it answers next.
      sent: () => { owed++; directoryPool?.invalidate(); },
    });
    if (delegation.readDirectories) directoryPool = readDirectoryPool({
      call: (request) => { delegated('readDirectories'); return begin(() => delegation.readDirectories!(request)); }, store, client: holder.client,
      before: async () => { if (holder?.pending()) await holder.send(); },
    });
  }
  /** The session's descriptors this process opened read-only: closing one changes nothing, so it owes no barrier. */
  const readers = new Set<number>();
  /** And those opened to write that nothing was written or cut through yet (git's /dev/null): no more do they. */
  const unwritten = new Set<number>();
  /** Of the read-only ones, the directories, and where their listing is. */
  const directories = new Map<number, OpenDirectory>();
  /**
   * The session's read-only descriptors of files too big to hold whole (a
   * pack, a deep history's .idx), by the name and file (dev, ino) each
   * opened: a positional read of one is answered from the store's pages of
   * that file at the revision the name says it has, read a batch at a time
   * and kept for the next reader. Once the name leads elsewhere, or a read
   * cannot be answered, the descriptor reads through the session.
   */
  const paged = new Map<number, { key: string; dev: number; ino: number }>();
  /** Bytes pinned for the codec's own descriptors (pinContent). */
  const pins = new Map<string, Pin>();

  /**
   * One walk over what the store knows: the resolved key, ELOOP (null), a
   * directory to list first, or DELEGATE when the walk reaches what this
   * adapter does not answer. The authority's refusals are thrown as its own.
   * `crossed`: every name it looked up, in order.
   */
  const walkOnce = (root: string, name: string, follow: boolean, crossed?: string[]): string | null | Unknown | Delegate => {
    const walk = walkBeneath(root, { root, path: name, beneath: true }, follow, store.cred, () => false);
    if (crossed !== undefined) crossed.length = 0;
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
      crossed?.push(key);
      if (key === '') { step = walk.next(ROOT_FOR_WALK); continue; }
      const entry = store.entry(key);
      if (entry === undefined) return { missing: key };
      if (entry !== null && entry.dev !== store.device) return DELEGATE;
      step = walk.next(entry === null ? null : { type: entry.type, mode: entry.mode, uid: entry.uid, gid: entry.gid });
    }
  };

  /** Where an open directory's listing is, while its name still leads to the directory the session opened. */
  const directoryKey = (handleId: number): string | undefined => {
    if (directoryPool?.owns(handleId)) return directoryPool.local(handleId)?.key;
    const open = directories.get(handleId);
    if (open === undefined) return undefined;
    const entry = store.entry(open.key);
    return entry && entry.type === 'directory' && entry.dev === open.dev && entry.ino === open.ino ? open.key : undefined;
  };

  /**
   * The directories a walk opens next, after `key`: preorder, names in the
   * order a descriptor lists them (byCodeUnit), on past `key`'s subtree to
   * the rest of the walk beneath `within`, as listed so far.
   */
  const walkAfter = (key: string, within: string, limit: number): string[] => {
    const out: string[] = [];
    const subdirectories = (dir: string): string[] => byCodeUnit((store.children(dir) ?? []).filter((child) => child.type === 'directory'))
      .map((child) => (dir === '' ? child.name : `${dir}/${child.name}`));
    const descend = (dir: string): void => {
      for (const child of subdirectories(dir)) {
        if (out.length >= limit) return;
        out.push(child);
        descend(child);
      }
    };
    descend(key);
    for (let at = key; at !== within && out.length < limit; at = parentKey(at)) {
      const name = at.slice(at.lastIndexOf('/') + 1);
      for (const sibling of subdirectories(parentKey(at))) {
        if (out.length >= limit) break;
        if (sibling.slice(sibling.lastIndexOf('/') + 1) <= name) continue;
        out.push(sibling);
        descend(sibling);
      }
    }
    return out;
  };
  /** Where the walk the last directory open belongs to began: `walkAfter`'s bound. */
  let walkRoot: string | null = null;
  /** The directories opened so far, in order; and the last run's, as its walk goes on. */
  const opening: string[] = [];
  const previous = delegation?.walked ?? [];
  let along = 0;
  /**
   * The directories the last run opened after `key`, from where this run has
   * got to in its walk: what it opens next, if it repeats it.
   */
  const repeated = (key: string, limit: number): string[] => {
    const at = previous.indexOf(key, along);
    if (at < 0) return [];
    along = at + 1;
    return previous.slice(at + 1, at + 1 + limit);
  };

  /**
   * Misses by directory: names the store did not know there, and bytes it
   * did not hold. From a directory's second, it is listed in one answer: its
   * subtree when names missed there were found (a walk; unless past the
   * listing's bound), else itself (a probe for names that are not there);
   * and its files are fetched ahead (READ_AHEAD_*).
   */
  const missesIn = new Map<string, number>();
  const miss = (dir: string): number => {
    const misses = (missesIn.get(dir) ?? 0) + 1;
    missesIn.set(dir, misses);
    return misses;
  };
  const unlistable = new Set<string>();
  /** Whether the name a directory's last miss looked up was there: its misses are a walk of what is there, not a probe. */
  const foundIn = new Map<string, boolean>();
  /** Files a read-ahead batch is fetching, and the batch; and the bytes read ahead so far. */
  const fetchingAhead = new Map<string, Promise<void>>();
  let readAheadBytes = 0;

  /**
   * A fill of `key` (`entry`), with the files of its directory read ahead
   * when its misses earned it: the batch, which includes `key`, or undefined
   * when `key` is filled alone.
   */
  const readAhead = (key: string, entry: ResidentEntry): Promise<void> | undefined => {
    const dir = parentKey(key);
    const misses = miss(dir);
    const ext = extensionOf(key);
    const children = store.children(dir);
    if (misses < 2 || ext === '' || children === undefined) return undefined;
    const window = READ_AHEAD_FIRST * 2 ** Math.min(misses - 2, 7);
    const name = key.slice(key.lastIndexOf('/') + 1);
    const batch: Array<[string, ResidentEntry]> = [[key, entry]];
    let bytes = entry.size;
    const ordered = byCodeUnit(children.filter((child) => child.type === 'file' && child.name !== name && extensionOf(child.name) === ext));
    const at = ordered.findIndex((child) => child.name > name);
    for (const child of at < 0 ? ordered : [...ordered.slice(at), ...ordered.slice(0, at)]) {
      if (batch.length > window || batch.length >= FS_READ_BATCH_PATH_LIMIT) break;
      const sibling = dir === '' ? child.name : `${dir}/${child.name}`;
      if (fetchingAhead.has(sibling)) continue;
      const found = entryAt(sibling);
      if (!found || found.type !== 'file' || found.size > READ_AHEAD_FILE_BYTES || store.content(sibling, found.revision) !== undefined) continue;
      // What this process decided or changes is its own to read.
      if (holder?.content(found) !== undefined || holder?.provisional.pending(found.dev, found.ino)) continue;
      if (bytes + found.size > FS_READ_BATCH_REQUEST_BYTES || readAheadBytes + bytes + found.size > READ_AHEAD_PROCESS_BYTES) break;
      batch.push([sibling, found]);
      bytes += found.size;
    }
    if (batch.length === 1) return undefined;
    readAheadBytes += bytes - entry.size;
    counts.fills += batch.length;
    counts.filledBytes += bytes;
    counts.readAhead += batch.length - 1;
    const fetched = store.fillMany(batch).catch(() => {});
    for (const [path] of batch) fetchingAhead.set(path, fetched);
    void fetched.then(() => { for (const [path] of batch) if (fetchingAhead.get(path) === fetched) fetchingAhead.delete(path); });
    return fetched;
  };

  /** Where a path leads (its key), listing what the walk needs; DELEGATE for what this adapter does not answer. `crossed`: the names the walk that placed it looked up. */
  const resolve = (path: RuntimeFsPath, follow: boolean, content = false, crossed?: string[]): Resolution | Promise<Resolution> => {
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
    // listed (which also says what is absent in it). A directory asked about
    // a second time is being walked: its subtree is listed in one answer,
    // unless it is past the listing's bound. Each step walks a store that has
    // what this process sent (the barrier first when one is owed): a grant
    // given back while the walk waited on the session drops what was decided
    // under it, and the store has it only once the barrier lands.
    const looked = new Set<string>();
    let caughtUps = 0;
    const attempt = (asked: number): Resolution | Promise<Resolution> => {
      if (!store.ready()) return DELEGATE;
      // A debt that keeps coming while it catches up: the session walks it.
      if (owes() && !now) return ++caughtUps > MAX_CATCH_UPS_PER_CALL ? DELEGATE : catchUp().then((ok) => (ok ? attempt(asked) : DELEGATE));
      const walked = walkOnce(root, name, follow, crossed);
      if (walked === null || walked === DELEGATE || typeof walked === 'string') return walked;
      // A name this view does not know is the session's to say.
      if (now) notNow();
      if (asked >= MAX_LISTINGS_PER_CALL) return DELEGATE;
      const parent = parentKey(walked.missing);
      if (miss(parent) >= 2 && parent !== '' && store.children(parent) === undefined) {
        // A walk of what is there (the name its last miss looked up was
        // found): the subtree in one answer; past its bound, the directory
        // alone. A probe for what is not (an interpreter's import path): the
        // directory alone.
        const walking = foundIn.get(parent) === true && !unlistable.has(parent);
        const whole = walking ? (counts.treeListings++, store.listTree(parent)) : Promise.resolve(false);
        return whole
          .then((listed) => {
            if (listed) return true;
            if (walking) unlistable.add(parent);
            counts.listings++;
            return store.list(parent);
          })
          .then((listed) => (listed ? attempt(asked + 1) : DELEGATE));
      }
      if (!looked.has(walked.missing)) {
        const spelled = prefixes(root, name).filter((key) => !looked.has(key) && store.entry(key) === undefined);
        const keys = spelled.includes(walked.missing) ? spelled.slice(spelled.indexOf(walked.missing)) : [walked.missing];
        for (const key of keys) looked.add(key);
        counts.lookups++;
        // The bytes of what the call names, when it is a small file: a stat is followed by an open.
        const target = spelled[spelled.length - 1];
        return store.lookup(keys, content && keys[keys.length - 1] === target)
          .then((known) => {
            if (known) foundIn.set(parent, Boolean(store.entry(walked.missing)));
            return known ? attempt(asked + 1) : DELEGATE;
          });
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
    return entry;
  };

  /**
   * A file's bytes: what this process decided for it, else the store's,
   * fetched into it. Undefined when only the authority can read them (a file
   * this process changed whose bytes are not known here: the authority has
   * its changes first).
   */
  const contentOf = (key: string, entry: ResidentEntry): Uint8Array | undefined | Promise<Uint8Array | undefined> => {
    const decided = holder?.content(entry);
    if (decided !== undefined) return decided;
    if (holder?.provisional.pending(entry.dev, entry.ino)) return undefined;
    const keep = (bytes: Uint8Array | null | undefined): Uint8Array | undefined =>
      (bytes === null || bytes === undefined || bytes.byteLength !== entry.size ? undefined : bytes);
    const held = store.content(key, entry.revision);
    if (held !== undefined && held.byteLength === entry.size) return held;
    if (now) notNow();
    const fill = (): Promise<Uint8Array | undefined> => {
      counts.fills++;
      counts.filledBytes += entry.size;
      return store.fill(key, entry).then(keep);
    };
    // A batch fetching it (read-ahead) is waited on, not repeated.
    const batch = fetchingAhead.get(key) ?? readAhead(key, entry);
    if (batch === undefined) return fill();
    return batch.then(() => {
      const fetched = store.content(key, entry.revision);
      return fetched !== undefined && fetched.byteLength === entry.size ? fetched : fill();
    });
  };

  /**
   * Answer from the store when it can, else from the authority: the barrier
   * first when one is owed, then `local`, whose DELEGATE hands the call on.
   */
  const answer = <T>(name: string, local: () => T | Delegate | Promise<T | Delegate>, remote: () => T | Promise<T>, caughtUps = 0): T | Promise<T> => {
    const settle = (value: T | Delegate): T | Promise<T> => {
      if (value !== DELEGATE) { counts.local++; return value; }
      delegated(name);
      return remote();
    };
    if (!store.ready()) { delegated(name); return remote(); }
    // The store answers only while nothing is owed (a barrier that lands
    // covers what was owed when it began); one owed until a barrier lands,
    // or owed again as each lands, leaves the call to the session. A caller
    // that cannot wait answers from the view as it stands.
    if (owes() && !now) {
      if (caughtUps >= MAX_CATCH_UPS_PER_CALL) { delegated(name); return remote(); }
      return catchUp().then((ok) => {
        if (ok) return answer(name, local, remote, caughtUps + 1);
        delegated(name);
        return remote();
      });
    }
    return after(local(), settle);
  };

  /**
   * `then`, the only answer for a descriptor of the holder's, once the store
   * has what is owed now (as answer() takes it) for a caller that may wait;
   * past the bound, or for one that cannot wait, over the view as it stands.
   */
  const caughtUpFor = <T>(then: () => T | Promise<T>, caughtUps = 0): T | Promise<T> => {
    if (now || !owes() || caughtUps >= MAX_CATCH_UPS_PER_CALL) return then();
    return new Promise<T>((resolve, reject) => {
      catchUp().then((ok) => resolve(ok ? caughtUpFor(then, caughtUps + 1) : then()), reject);
    });
  };

  /**
   * A mutation the holder may decide (a subtree it holds, or one it takes
   * for this): `local`, whose walks take the barrier when owed, its answer
   * counted as local; DELEGATE (or false/undefined from the holder) hands it on.
   */
  const decide = <T>(local: () => T | Delegate | Promise<T | Delegate>): T | Delegate | Promise<T | Delegate> => {
    if (holder === null || !store.ready()) return DELEGATE;
    return after(local(), (value) => {
      if (value !== DELEGATE) counts.local++;
      return value;
    });
  };

  /** `path`'s walk for a mutation (the key it resolves to, and every name crossed to it), or DELEGATE. */
  const walkFor = (path: RuntimeFsPath, follow: boolean): Walk | Delegate | Promise<Walk | Delegate> => {
    const crossed: string[] = [];
    return after(resolve(path, follow, false, crossed), (key) => (typeof key === 'string' && key !== '' ? { key, crossed } : DELEGATE));
  };

  /**
   * Whether the holder may be asked to decide a change at `key` on its
   * walks. Where it holds `key`'s subtree, only when every row or absence
   * they read is one a decision may use: the process's own (decided here),
   * or one this view has as the session does (ProcessFsClient.certifies:
   * nothing another changed before the grant is missing from it, and
   * nothing changes after it before the process answers). Else the session
   * resolves the call. Where it does not hold it, the holder declines it
   * anyway, counting it toward taking the subtree.
   */
  const decidable = (key: string, ...walks: Walk[]): boolean => {
    if (holder!.client.held(key) === undefined) return true;
    const cursor = store.cursor();
    return walks.every((walk) => walk.crossed.every((name) => holder!.entry(name) !== undefined
      || (cursor !== null && holder!.client.certifies(name, cursor) !== undefined)));
  };

  /** The authority, for a call that may change what the store holds: the barrier is owed once it returns. */
  const changing = <T>(name: string, call: () => T | Promise<T>): T | Promise<T> => {
    if (now) throw NOT_NOW;
    directoryPool?.invalidate();
    delegated(name);
    try {
      return after(call(), (value) => { owed++; return value; });
    } catch (error) {
      owed++;
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
    // The authority has what this process logged before it (its proxy flushes first).
    const mutates = MUTATIONS.has(name as keyof RuntimeFsBridge);
    Reflect.set(fs, name, mutates
      ? (...args: unknown[]) => changing(name, () => call(...args))
      : (...args: unknown[]) => {
        if (now) throw NOT_NOW;
        delegated(name);
        return call(...args);
      });
  }

  fs.inbound = () => { owed++; directoryPool?.invalidate(); };
  fs.cancelPendingDirectories = () => { owed++; directoryPool?.cancelPending(); };
  fs.holding = () => holder?.pending() ?? false;
  fs.logHeld = () => holder?.logHeld();
  // What leaves the process is preceded by everything it logged.
  fs.flush = async () => { await holder?.flush(); };
  fs.settle = async () => {
    const failures: UnsettledWrite[] = [];
    // The run's end, both at once: the directory descriptions it holds are
    // retired, what it logged is answered, and what it held is given back.
    await Promise.all([directoryPool?.dispose(), holder?.settle()].map((ending) => Promise.resolve(ending).catch((error: unknown) => {
      failures.push({ path: '/', dev: 0, ino: 0, error });
    })));
    return failures;
  };
  // A sync of a file through any descriptor: everything this process logged
  // is answered first, and a refusal it recorded is this sync's answer.
  fs.syncInode = () => holder?.flush();
  fs.walked = () => opening;
  fs.stats = () => ({
    ...counts,
    delegated: { ...counts.delegated },
    pins: pins.size,
    pinnedBytes: [...pins.values()].reduce((total, pin) => total + pin.bytes.byteLength, 0),
    provisionalBytes: holder?.provisional.kept() ?? 0,
    ...(holder === null ? {} : { client: holder.client.stats() }),
  });

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

  fs.pinContent = (path, stat) => answer<PinnedContent | null>('pinContent', () => after(resolve(path, true, true), (key) => {
    if (key === DELEGATE || key === '' || key === null) return null;
    const entry = entryAt(key);
    // Only the file the caller stat'd, at the revision it stat'd: anything else is the session's to open.
    if (!entry || entry.type !== 'file' || entry.dev !== stat.dev || entry.ino !== stat.ino || entry.size > WASI_RESIDENT_FILE_CAP_BYTES) return null;
    if (!modeAllows(entry, 4, store.cred)) return null;
    // A file this process changed is the session's to read where its bytes are not known here (its changes are answered there first).
    if (holder?.provisional.pending(entry.dev, entry.ino) || entry.revision !== stat.revision) return null;
    const pinKey = `${identity(entry.dev, entry.ino)}:${entry.revision}`;
    const pinned = (pin: Pin): PinnedContent => {
      pin.holders++;
      let released = false;
      return {
        bytes: pin.bytes,
        name: '/' + key,
        release: () => {
          if (released) return;
          released = true;
          if (--pin.holders > 0) return;
          pins.delete(pinKey);
          store.release(pin.bytes.byteLength);
        },
      };
    };
    const existing = pins.get(pinKey);
    if (existing !== undefined) return pinned(existing);
    return after(contentOf(key, entry), (bytes) => {
      if (bytes === undefined || !store.reserve(bytes.byteLength)) return null;
      const pin: Pin = { bytes, holders: 0 };
      pins.set(pinKey, pin);
      return pinned(pin);
    });
  }), () => null);

  fs.readFile = (path, options = {}) => answer<Uint8Array | null>('readFile', () => after(resolve(path, options.followSymlinks !== false, true), (key) => {
    if (key === DELEGATE || key === '') return DELEGATE;
    if (key === null) return null;
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    if (entry === null) return null;
    // As the authority checks: permission before what kind of name it is.
    if (!modeAllows(entry, 4, store.cred)) throw fsError('EACCES', 'open', path);
    if (entry.type === 'directory') throw fsError('EISDIR', 'open', path);
    if (entry.type !== 'file' || entry.size > WASI_RESIDENT_FILE_CAP_BYTES) return DELEGATE;
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
    if (now) notNow();
    counts.treeListings++;
    return store.listTree(key)
      .then((whole) => (whole ? true : store.list(key)))
      .then((listed) => {
        // Owed while it listed (a grant given back with what it decided here): the session lists it.
        const children = listed && !owes() ? store.children(key) : undefined;
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

  /** A descriptor of the holder's, as an open answers it: with its stat, the holder's. */
  const heldOpen = (handle: RuntimeFileHandle): RuntimeOpenedFile => ({ ...handle, stat: statOf(holder!.fstat(handle.id)) });

  fs.access = (path, mode) => answer<void>('access', () => after(resolve(path, true), (key) => {
    if (key === DELEGATE || key === '') return DELEGATE;
    if (key === null) throw fsError('ELOOP', 'access', path);
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    if (entry === null) throw fsError('ENOENT', 'access', path);
    if (!modeAllows(entry, mode, store.cred)) throw fsError('EACCES', 'access', path);
    return undefined;
  }), () => authority.access(path, mode));

  fs.open = (path, flags: RuntimeOpenFlags) => {
    const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
    if (directoryPool && !now && readOnly && flags.read === true && flags.directory === true && flags.followSymlinks !== false && flags.expectedRevision === undefined) {
      return answer<RuntimeOpenedFile>('open', () => after(resolve(path, true), async (key) => {
        if (key === DELEGATE || key === null || key === '' || entryAt(key)?.type !== 'directory') return DELEGATE;
        if (walkRoot === null || (key !== walkRoot && !key.startsWith(walkRoot + '/'))) walkRoot = key;
        const within = walkRoot;
        // A walk is earned: the run's first directory open (an interpreter
        // listing its working directory) opens that one alone, unless the
        // last run in this facet walked from it.
        const walking = opening.length > 0;
        if (opening.length < WALKED_DIRECTORIES) opening.push(key);
        const handle = await directoryPool!.open(path, key, async () => {
          const guessed = repeated(key, DIRECTORY_BATCH_LIMIT - 1);
          if (!walking && guessed.length === 0) return [];
          // The existing bounded namespace listing owns these names. Walk
          // only directories it actually reported; no invented path/prefix.
          await listingOf(key);
          // What the last run opened next comes first; then the walk on from here.
          const next = [...new Set([...guessed, ...walkAfter(key, within, DIRECTORY_BATCH_LIMIT - 1)])];
          // Carry the caller's confinement/descriptor root to the authority;
          // never replace a beneath lookup with an absolute one. A
          // descriptor-relative open names only what is beneath its directory.
          const beneath = (base: string): string[] => next.filter((candidate) => base === '' || candidate.startsWith(base + '/'));
          if (typeof path === 'string') return next.slice(0, DIRECTORY_BATCH_LIMIT - 1).map((candidate) => '/' + candidate);
          if ('directory' in path) {
            const base = path.path.replace(/\/$/, '');
            return beneath(key).slice(0, DIRECTORY_BATCH_LIMIT - 1)
              .map((candidate) => ({ ...path, path: (base === '' ? '' : base + '/') + candidate.slice(key.length + 1) }));
          }
          const root = keyOf(path.root);
          return beneath(root).slice(0, DIRECTORY_BATCH_LIMIT - 1)
            .map((candidate) => ({ ...path, path: root === '' ? candidate : candidate.slice(root.length + 1) }));
        });
        if (handle === null) return DELEGATE;
        // An open answers its stat (RuntimeOpenedFile): the one a prefetched directory's fstat answers here.
        return { ...handle, stat: await fs.fstat(handle.id) };
      }), () => openOnSession(path, flags));
    }
    if (!readOnly && holder !== null) {
      // A file made or emptied in a subtree this process holds is decided here.
      const local = decide<RuntimeOpenedFile>(() => after(walkFor(path, true), (walk) => (walk === DELEGATE || !decidable(walk.key, walk) ? DELEGATE
        : after(holder!.open(walk.key, typeof path === 'string' ? path : path.path, flags), (handle) => (handle === undefined ? DELEGATE : heldOpen(handle))))));
      return after(local, (handle) => (handle === DELEGATE ? openOnSession(path, flags) : handle));
    }
    return openOnSession(path, flags);
  };

  /**
   * What a caller that cannot wait has decided where no held subtree decides
   * it (DelegationHolder.provisional): the call `decided` makes with the
   * key `path` resolves to and the row there, refused as one that cannot
   * answer now where it declines or the view cannot place the name.
   */
  const provisionally = <T>(path: RuntimeFsPath, follow: boolean, decided: (key: string, row: ResidentEntry | null) => T | false | undefined): T => {
    if (holder === null || !store.ready()) throw NOT_NOW;
    const walk = walkFor(path, follow);
    if (walk === DELEGATE || walk instanceof Promise) throw NOT_NOW;
    const row = entryAt(walk.key);
    if (row === undefined) throw NOT_NOW;
    const done = decided(walk.key, row);
    if (done === false || done === undefined) throw NOT_NOW;
    counts.local++;
    return done;
  };

  /**
   * An open no held subtree decides, for a caller that cannot wait: its
   * file's, by its number (Provisional.open), its access judged and nothing
   * read; one it makes or empties, decided as a write's open is.
   */
  const openByNumber = (path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeOpenedFile => {
    if (flags.directory) throw NOT_NOW;
    return heldOpen(provisionally(path, flags.followSymlinks !== false, (key, row) => holder!.provisional.open(key, pathOf(path), flags, row)));
  };

  /**
   * A read by a descriptor of the holder's: its file's bytes here (a grant's
   * cell, the provisional fold over the view, the view's) while a name the
   * view has leads to the file. Where no name does, a caller that may wait
   * reads through the file's open description at the session (its anchor),
   * once what this process wrote is there: the file as every process that
   * holds it open has made it. Where the bytes are not here, a caller that
   * may wait fetches them by the name and reads again. A caller that cannot
   * wait reads what is here, or is refused (not resident, or ESTALE).
   */
  const readOwn = (handleId: number, offset: number | null, length: number): Uint8Array | Promise<Uint8Array> => {
    if (!now && holder!.provisional.sessionOf(handleId) !== undefined && holder!.provisional.unnamed(handleId)) return readByAnchor(handleId, offset, length);
    const read = (): Uint8Array | undefined => holder!.read(handleId, offset, length);
    let done: Uint8Array | undefined;
    try {
      done = read();
    } catch (error) {
      if (now || (error as { code?: string }).code !== 'ESTALE') throw error;
      return readByAnchor(handleId, offset, length);
    }
    if (done !== undefined) return done;
    if (now) throw NOT_NOW;
    const at = holder!.provisional.inodeOf(handleId);
    if (at === undefined) return readByAnchor(handleId, offset, length);
    // Fetched by the name, while its access lets the process read it; else through its anchor, whose access was its open's.
    return Promise.resolve(contentOf(at.key, at.entry)).then(() => read() ?? readByAnchor(handleId, offset, length), (error: unknown) => {
      if (holder!.provisional.sessionOf(handleId) === undefined) throw error;
      return readByAnchor(handleId, offset, length);
    });
  };

  /** `handleId`'s file as the session's open description of it has it (Provisional.sessionOf), once what this process logged is there. */
  const statByAnchor = async (handleId: number): Promise<RuntimeVfsStat> => {
    const key = holder!.keyOf(handleId);
    await holder!.send();
    const session = holder!.provisional.sessionOf(handleId);
    if (session === undefined) throw fsError('ESTALE', 'fstat', '/' + key);
    delegated('fstat');
    return authority.fstat(session);
  };

  /** A read through the session's open description of `handleId`'s file (Provisional.sessionOf), at `offset` or the descriptor's position. */
  const readByAnchor = async (handleId: number, offset: number | null, length: number): Promise<Uint8Array> => {
    const key = holder!.keyOf(handleId);
    // What this process logged reaches the session first; a refusal among it is the next sync's to report, not this read's.
    await holder!.send();
    const session = holder!.provisional.sessionOf(handleId);
    if (session === undefined) throw fsError('ESTALE', 'read', '/' + key);
    const start = offset ?? holder!.seek(handleId, 0, 'current');
    delegated('read');
    const chunk = await authority.read(session, start, length);
    if (offset === null) holder!.seek(handleId, start + chunk.byteLength, 'set');
    return chunk;
  };

  const openOnSession = (path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeOpenedFile | Promise<RuntimeOpenedFile> => {
    if (now) return openByNumber(path, flags);
    const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
    if (!readOnly) {
      // A file of the session's own filesystem no held subtree decides is
      // opened by the provisional decisions (Provisional.open), as a caller
      // that cannot wait opens it: its open logged, its writes through its
      // description; a directory, a file the store cannot place, or one on
      // a mount is the session's descriptor.
      const through = (): RuntimeOpenedFile | Delegate | Promise<RuntimeOpenedFile | Delegate> => {
        if (holder === null || !store.ready() || flags.directory) return DELEGATE;
        return after(walkFor(path, flags.followSymlinks !== false), (walk) => {
          if (walk === DELEGATE) return DELEGATE;
          const there = entryAt(walk.key);
          if (there === undefined || there?.type === 'directory') return DELEGATE;
          const opened = holder!.provisional.open(walk.key, pathOf(path), flags, there, true);
          if (opened === undefined) return DELEGATE;
          counts.local++;
          // Its access is the session's to judge at the open, as open(2) judges it: answered before it returns.
          const opening = holder!.provisional.descriptor(opened.id)?.opening;
          if (opening === undefined) return heldOpen(opened);
          return opening.then(() => heldOpen(opened), (error: unknown) => {
            holder!.provisional.abandon(opened.id);
            throw error;
          });
        });
      };
      return after(through(), (handle) => {
        if (handle !== DELEGATE) return handle;
        if (flags.create || flags.truncate) return changing('open', () => authority.open(path, flags));
        // An open that makes and empties nothing changes nothing: its writes will, each a call of its own.
        delegated('open');
        return after(authority.open(path, flags), (opened) => { unwritten.add(opened.id); return opened; });
      });
    }
    // A read-only open is the session's descriptor (it has what this process logged first).
    delegated('open');
    return after(authority.open(path, flags), (handle) => {
      readers.add(handle.id);
      // What it is, its open said: a directory is listed here, and a file too big to hold whole is paged, while its name still leads to it.
      const { type, dev, ino, size } = handle.stat;
      if (dev === store.device) {
        const key = keyOf(handle.path);
        if (type === 'directory') directories.set(handle.id, { key, dev, ino });
        else if (type === 'file' && size > WASI_RESIDENT_FILE_CAP_BYTES) paged.set(handle.id, { key, dev, ino });
      }
      return handle;
    });
  };

  fs.fstat = (handleId) => {
    if (directoryPool?.owns(handleId)) return answer<RuntimeVfsStat>('fstat', () => {
      const current = directoryPool!.local(handleId);
      return current ? statOf(current.entry) : DELEGATE;
    }, () => authority.fstat(handleId));
    if (holder?.owns(handleId)) return caughtUpFor(() => {
      // A file no name the view has leads to: as its open description at the session has it (its names, its size), as its reads are.
      if (!now && holder!.provisional.sessionOf(handleId) !== undefined && holder!.provisional.unnamed(handleId)) return statByAnchor(handleId);
      counts.local++;
      return statOf(holder!.fstat(handleId));
    });
    delegated('fstat');
    return authority.fstat(handleId);
  };

  fs.read = (handleId, offset, length) => {
    if (holder?.owns(handleId)) return caughtUpFor(() => {
      counts.local++;
      return readOwn(handleId, offset, length);
    });
    const file = paged.get(handleId);
    // Positional reads only: a read at the descriptor's offset is the descriptor's to advance.
    if (file !== undefined && offset !== null && length > 0) {
      return answer('read', () => after(resolve('/' + file.key, false), (resolved) => {
        // The file as this process has learned of it (a barrier forgets a
        // name it changed, and the walk learns it again). Once the name leads
        // to another file, the pages are not this descriptor's bytes.
        const now = resolved === DELEGATE ? undefined : entryAt(file.key);
        if (now === undefined || now === null || now.type !== 'file' || now.dev !== file.dev || now.ino !== file.ino) {
          paged.delete(handleId);
          return DELEGATE;
        }
        if (offset >= now.size) return new Uint8Array(0);
        const end = Math.min(now.size, offset + length);
        const first = Math.floor(offset / RESIDENT_PAGE_BYTES);
        const last = Math.floor((end - 1) / RESIDENT_PAGE_BYTES);
        return after(store.pages(file.key, now.revision, now.size, first, last), (found) => {
          if (found === null) { paged.delete(handleId); return DELEGATE; }
          counts.pagedReads++;
          counts.pagesFetched += found.fetched;
          const out = new Uint8Array(end - offset);
          found.pages.forEach((page, i) => {
            const start = (first + i) * RESIDENT_PAGE_BYTES;
            const from = Math.max(offset, start);
            const to = Math.min(end, start + page.byteLength);
            out.set(page.subarray(from - start, to - start), from - offset);
          });
          return out;
        });
      }), () => authority.read(handleId, offset, length));
    }
    delegated('read');
    return authority.read(handleId, offset, length);
  };

  fs.seek = (handleId, offset, whence) => {
    if (holder?.owns(handleId)) { counts.local++; return holder.seek(handleId, offset, whence); }
    delegated('seek');
    return authority.seek(handleId, offset, whence);
  };

  fs.write = (handleId, offset, bytes) => {
    if (holder?.owns(handleId)) { counts.local++; return holder.write(handleId, offset, bytes); }
    if (now) throw NOT_NOW;
    unwritten.delete(handleId);
    return changing('write', () => authority.write(handleId, offset, bytes));
  };

  fs.ftruncate = (handleId, size) => {
    if (holder?.owns(handleId)) { counts.local++; holder.ftruncate(handleId, size); return; }
    if (now) throw NOT_NOW;
    unwritten.delete(handleId);
    return changing('ftruncate', () => authority.ftruncate(handleId, size));
  };

  fs.close = (handleId) => {
    if (directoryPool?.owns(handleId)) {
      counts.local++;
      // One that cannot wait queues its retirement, waiting for nothing.
      return directoryPool.close(handleId, !now);
    }
    // A descriptor of the holder's closes here: what it wrote is in the log.
    if (holder?.owns(handleId)) {
      counts.local++;
      holder.close(handleId);
      // A refusal already recorded is the close's to report, as a write-back
      // error is; nothing is waited for, and the descriptor is closed anyway.
      return holder.reportRecorded();
    }
    if (now) throw NOT_NOW;
    if (readers.delete(handleId)) {
      directories.delete(handleId);
      paged.delete(handleId);
      delegated('close');
      return authority.close(handleId);
    }
    if (unwritten.delete(handleId)) { delegated('close'); return authority.close(handleId); }
    return changing('close', () => authority.close(handleId));
  };

  fs.readdirHandle = (handleId) => answer<RuntimeVfsDirEntry[]>('readdirHandle', () => {
    const key = directoryKey(handleId);
    if (key === undefined) return DELEGATE;
    return after(listingOf(key), (entries) => (entries === DELEGATE ? DELEGATE : byCodeUnit(entries)));
  }, () => authority.readdirHandle(handleId));

  fs.fsync = (handleId) => {
    // A call that answers now cannot wait for the session: what it refused of
    // what this process logged so far is this sync's answer. Its descriptor
    // first: one of the holder's range it does not own is closed (EBADF); a
    // session's is the session's to sync.
    if (now) {
      if (handleId !== undefined && !holder?.owns(handleId)) {
        if (handleId < 0) throw fsError('EBADF', 'fsync', String(handleId));
        throw NOT_NOW;
      }
      holder?.reportRecorded();
      return;
    }
    // Synced means in the session: everything this process logged is answered first.
    if (handleId !== undefined && holder?.owns(handleId)) return holder.flush();
    const synced = async (): Promise<void> => {
      await holder?.flush();
      delegated('fsync');
      await authority.fsync(handleId);
    };
    return synced();
  };

  // O_APPEND of one of the holder's descriptors is its writes' to keep (an append call or a write call).
  const bySessionStatus: unknown = Reflect.get(fs, 'setStatus');
  if (typeof bySessionStatus === 'function') {
    Reflect.set(fs, 'setStatus', (handleId: number, status: { append?: boolean }) => {
      if (holder?.owns(handleId)) { counts.local++; holder.setStatus(handleId, status); return; }
      return Reflect.apply(bySessionStatus, fs, [handleId, status]);
    });
  }

  // A descriptor of the holder's is reopened here where the holder decides it,
  // else once what was decided is sent: through the session's open
  // description of its file, any other by its file's name while that name has it.
  const bySessionReopen: unknown = Reflect.get(fs, 'reopen');
  if (typeof bySessionReopen === 'function') {
    Reflect.set(fs, 'reopen', (target: RuntimeReopenTarget, flags: RuntimeOpenFlags, options?: RuntimeMutationOwner) => {
      const held = holder;
      if (!held?.owns(target.handle)) return Reflect.apply(bySessionReopen, fs, [target, flags, options]);
      const local = held.reopen(target.handle, flags);
      if (local !== undefined) { counts.local++; return heldOpen(local); }
      if (now) throw NOT_NOW;
      const identity = held.fstat(target.handle);
      const name = '/' + held.keyOf(target.handle);
      return held.flush().then(() => held.provisional.sessionOf(target.handle)).then((session) => (session === undefined
        ? openIdentified(fs, name, false, flags, identity)
        : Reflect.apply(bySessionReopen, fs, [{ handle: session }, flags, options])));
    });
  }

  for (const name of ['fchmod', 'fchown', 'futimes', 'dup'] as const) {
    const passed: unknown = Reflect.get(fs, name);
    if (typeof passed !== 'function') continue;
    Reflect.set(fs, name, (handleId: number, ...rest: unknown[]) => {
      if (!holder?.owns(handleId)) return Reflect.apply(passed, fs, [handleId, ...rest]);
      if (name === 'dup') return holder.dup(handleId);
      return holderAttrs(name, handleId, rest);
    });
  }

  /** An owner as chown(2) and fchown(2) take it: -1 (or none) keeps it, null on the wire. */
  const ownerSide = (value: unknown): number | null => (typeof value === 'number' && value !== -1 ? value : null);
  /**
   * fchmod, fchown and futimes of a descriptor of the holder's, on the file
   * it opened, never on a name: decided here where a grant decides that
   * file; else by the provisional decisions, through its open description at
   * the session (DelegationHolder.fsetattr), which a caller that may wait
   * waits for: the change is every process's when the call returns, and its
   * refusal the call's.
   */
  const holderAttrs = (name: 'fchmod' | 'fchown' | 'futimes', handleId: number, rest: unknown[]): undefined | Promise<void> => {
    const change: W7Attrs = name === 'fchmod' ? { mode: Number(rest[0]) }
      : name === 'fchown' ? { uid: ownerSide(rest[0]), gid: ownerSide(rest[1]) }
      : { atime: rest[0] as FsTime, mtime: rest[1] as FsTime };
    if (holder!.fsetattr(handleId, change) || now) return undefined;
    return holder!.flush();
  };

  /**
   * A change by name no held subtree decides: an op of the process's client
   * when the store places the name (ordered with everything it logged,
   * answered before the call returns), else the session's call (its proxy
   * sends what the process logged first).
   */
  const byClient = (name: string, op: ProcessFsOp): Promise<void> => {
    if (now) throw NOT_NOW;
    delegated(name);
    // A name it changes: the files the process holds open at or under it write through first.
    if (op.type === 'rename') holder!.changing([op.from, op.to]);
    else if (op.type === 'call' && (op.call.call === 'unlink' || op.call.call === 'rmdir')) holder!.changing([op.call.path]);
    return holder!.client.submit(op).then(() => { owed++; }, (error: unknown) => { owed++; throw error; });
  };
  const pathOf = (path: RuntimeFsPath): string => (typeof path === 'string' ? path : path.path);

  // Changes by name a held subtree holds are decided here; any other is the session's, through the client.
  // A whole file written by name: made or emptied, written and closed here
  // where the holder decides that open, as the three calls are.
  const bySessionWriteFile = fs.writeFile;
  fs.writeFile = (path, bytes, options) => {
    if (holder === null || options?.createParents === true || options?.expectedRevision !== undefined) return bySessionWriteFile(path, bytes, options);
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const flags: RuntimeOpenFlags = { write: true, create: true, truncate: true, mode: 0o666, ...(options?.umask === undefined ? {} : { umask: options.umask }) };
    const local = decide<number>(() => after(walkFor(path, true), (walk) => {
      if (walk === DELEGATE || !decidable(walk.key, walk)) return DELEGATE;
      return holder!.writeFile(walk.key, pathOf(path), data, flags) ?? DELEGATE;
    }));
    return after(local, (done) => (done !== DELEGATE ? done
      : now ? provisionally(path, true, (key, row) => holder!.provisional.writeFile(key, pathOf(path), data, row, options?.umask) && (holder!.entry(key)?.revision ?? 0))
      : bySessionWriteFile(path, bytes, options)));
  };
  const bySessionMkdir = fs.mkdir;
  fs.mkdir = (path, options) => {
    if (holder === null) return bySessionMkdir(path, options);
    // A caller that cannot wait makes each missing directory on the way, as
    // mkdir -p does; any other asks the session to.
    if (options?.recursive) return now && typeof path === 'string' ? mkdirParents(path, options) : bySessionMkdir(path, options);
    const mode = options?.mode ?? 0o777;
    let named: string | undefined;
    const local = decide<void>(() => after(walkFor(path, false), (walk) => {
      if (walk === DELEGATE) return DELEGATE;
      named = walk.key;
      if (!decidable(walk.key, walk)) return DELEGATE;
      return after(holder!.mkdir(walk.key, pathOf(path), mode, options?.umask), (done) => (done ? undefined : DELEGATE));
    }));
    return after(local, (done) => (done !== DELEGATE ? undefined
      : now ? void provisionally(path, false, (key, row) => holder!.provisional.mkdir(key, pathOf(path), mode, row, options?.umask))
      : named !== undefined ? byClient('mkdir', { type: 'call', call: { call: 'mkdir', path: named, mode, ...(options?.umask === undefined ? {} : { umask: options.umask }) } }) : bySessionMkdir(path, options)));
  };
  /**
   * mkdir -p for a caller that cannot wait: planned whole against the view
   * first (`..` after a directory it is to make is that directory's parent,
   * as the session's walk takes it), so a call that cannot answer now (a
   * name the view cannot place, another filesystem's directory) refuses
   * before it makes anything; then each directory planned made in order.
   */
  const mkdirParents = (path: string, options: { mode?: number; umask?: number }): undefined => {
    const parts = path.split('/').filter((part) => part !== '' && part !== '.');
    const planned: string[] = [];
    const making = new Set<string>();
    let current = '';
    for (let at = 0; at < parts.length; at++) {
      const part = parts[at]!;
      const last = at === parts.length - 1;
      if (part === '..') {
        current = parentKey(current);
        continue;
      }
      const next = current === '' ? part : `${current}/${part}`;
      // Beneath a directory it is to make: nothing is there yet.
      if (making.has(current)) {
        planned.push(next);
        making.add(next);
        current = next;
        continue;
      }
      const walked = walkOnce('', next, true);
      if (walked === null) throw fsError('ELOOP', 'mkdir', path);
      const entry = typeof walked === 'string' ? entryAt(walked) : undefined;
      if (entry === undefined) throw NOT_NOW;
      if (entry === null) {
        const parent = entryAt(parentKey(walked as string));
        // Made where the view cannot say it may be made (another filesystem, a mode it would have to judge): the session's.
        if (!parent || parent.type !== 'directory' || parent.dev !== store.device) throw NOT_NOW;
        if (!modeAllows(parent, 3, store.cred)) throw fsError('EACCES', 'mkdir', path);
        if (((options.mode ?? 0o777) & 0o7000) !== 0) throw NOT_NOW;
        planned.push(walked as string);
        making.add(walked as string);
        current = walked as string;
        continue;
      }
      if (entry.type !== 'directory') throw fsError(last ? 'EEXIST' : 'ENOTDIR', 'mkdir', path);
      current = walked as string;
    }
    for (const key of planned) fs.mkdir('/' + key, { ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.umask === undefined ? {} : { umask: options.umask }) });
    return undefined;
  };
  const bySessionUnlink = fs.unlink;
  fs.unlink = (path) => {
    if (holder === null) return bySessionUnlink(path);
    let named: string | undefined;
    const local = decide<void>(() => after(walkFor(path, false), (walk) => {
      if (walk === DELEGATE) return DELEGATE;
      named = walk.key;
      if (!decidable(walk.key, walk)) return DELEGATE;
      return after(holder!.unlink(walk.key, pathOf(path)), (done) => (done ? undefined : DELEGATE));
    }));
    return after(local, (done) => (done !== DELEGATE ? undefined
      : now ? void provisionally(path, false, (key, row) => holder!.provisional.unlink(key, pathOf(path), row))
      : named !== undefined ? byClient('unlink', { type: 'call', call: { call: 'unlink', path: named } }) : bySessionUnlink(path)));
  };
  /**
   * The store's bytes of the file `walk` reaches (a decidable walk), where
   * this view is the session's for them (ProcessFsClient.vouch at the view's
   * cursor: the file held, and nothing of the process's own missing from
   * the view). Undefined where the view cannot vouch for them.
   */
  const vouchedContent = ({ key }: Walk): Uint8Array | undefined => {
    const cursor = store.cursor();
    if (cursor === null || holder!.client.vouch(key, cursor) !== 'held') return undefined;
    const entry = entryAt(key);
    return entry ? store.content(key, entry.revision) : undefined;
  };
  /** The bytes this view holds of file `key` (at `entry`), as it stands. */
  const residentContent = (key: string, entry: ResidentEntry): Uint8Array | undefined => {
    const bytes = store.content(key, entry.revision);
    return bytes !== undefined && bytes.byteLength === entry.size ? bytes : undefined;
  };
  // A copy both of whose names a held subtree holds, its source's bytes the
  // holder's or ones the view vouches for: decided here; any other, the
  // session's.
  const bySessionCopy = fs.copyFile;
  fs.copyFile = (from, to, options) => {
    if (holder === null) return bySessionCopy(from, to, options);
    const local = decide<void>(() => after(walkFor(from, true), (source) => (source === DELEGATE ? DELEGATE
      : after(walkFor(to, true), (target) => {
        if (target === DELEGATE || !decidable(target.key, source, target)) return DELEGATE;
        return holder!.copyFile(source.key, target.key, pathOf(to), vouchedContent(source), options?.keepMode === true) ? undefined : DELEGATE;
      }))));
    // A caller that cannot wait copies what this view holds of the source, as it reads it.
    return after(local, (done) => (done !== DELEGATE ? undefined
      : now ? void provisionally(from, true, (source, row) => {
        if (row === null) throw fsError('ENOENT', 'copyfile', pathOf(from));
        return provisionally(to, true, (target, there) => holder!.provisional.copyFile(target, pathOf(to), row, residentContent(source, row), there, options?.keepMode === true));
      })
      : bySessionCopy(from, to, options)));
  };
  const bySessionRename = fs.rename;
  fs.rename = (from, to) => {
    if (holder === null) return bySessionRename(from, to);
    let names: [string, string] | undefined;
    const local = decide<void>(() => after(walkFor(from, false), (source) => (source === DELEGATE ? DELEGATE
      : after(walkFor(to, false), (target) => {
        if (target === DELEGATE) return DELEGATE;
        names = [source.key, target.key];
        if (!decidable(source.key, source, target)) return DELEGATE;
        return after(holder!.rename(source.key, target.key, pathOf(from)), (done) => (done ? undefined : DELEGATE));
      }))));
    return after(local, (done) => (done !== DELEGATE ? undefined
      : now ? void provisionally(from, false, (source, row) => provisionally(to, false, (target, there) => holder!.provisional.rename(source, target, pathOf(from), row, there)))
      : names !== undefined ? byClient('rename', { type: 'rename', from: names[0], to: names[1] }) : bySessionRename(from, to)));
  };
  // An attribute change by name: decided here where a held subtree holds the
  // name (counted toward taking it either way), else the session's, after
  // what the holder has; one it holds but did not decide (another's file, a
  // grant the session judges) is the session's in its view after. Not a
  // link's own (lchown, lutimes), nor times now: the session's alone.
  for (const name of ['chmod', 'chown', 'utimes'] as const) {
    const passed = Reflect.get(fs, name) as (...args: unknown[]) => unknown;
    Reflect.set(fs, name, (path: RuntimeFsPath, ...rest: unknown[]) => {
      const options = rest[2] as { followSymlinks?: boolean } | undefined;
      const attrs: W7Attrs | null = name === 'chmod' ? { mode: Number(rest[0]) }
        : options?.followSymlinks === false ? null
        : name === 'chown' ? { uid: ownerSide(rest[0]), gid: ownerSide(rest[1]) }
        : { atime: rest[0] as FsTime, mtime: rest[1] as FsTime };
      if (holder === null || attrs === null) return passed.call(fs, path, ...rest);
      let named: string | undefined;
      const local = decide<void>(() => after(walkFor(path, true), (walk) => {
        if (walk === DELEGATE) return DELEGATE;
        named = walk.key;
        if (!decidable(walk.key, walk)) return DELEGATE;
        return holder!.setattr(walk.key, attrs) ? undefined : DELEGATE;
      }));
      return after(local, (done) => {
        if (done !== DELEGATE) return undefined;
        if (now) return void provisionally(path, true, (key, row) => holder!.provisional.setattr(key, pathOf(path), attrs, row));
        const key = named;
        if (key === undefined || !holder!.holds(key)) return passed.call(fs, path, ...rest);
        return after(passed.call(fs, path, ...rest), (receipt) => { holder!.undecided(key); return receipt; });
      });
    });
  }
  // Nothing of these is decided here: by the client when the store places
  // the name; for a caller that cannot wait, by its provisional decisions.
  const byName = <A extends unknown[]>(name: 'rmdir' | 'symlink', passed: (...args: A) => Awaitable<void>, pathAt: number, op: (key: string, args: A) => ProcessFsOp, decided: (key: string, row: ResidentEntry | null, args: A) => boolean) =>
    (...args: A): Awaitable<void> => {
      if (holder === null) return passed(...args);
      if (now) return void provisionally(args[pathAt] as RuntimeFsPath, false, (key, row) => decided(key, row, args));
      const placed = walkFor(args[pathAt] as RuntimeFsPath, false);
      return after(placed, (walk) => (walk === DELEGATE ? passed(...args) : byClient(name, op(walk.key, args))));
    };
  const bySessionRmdir = fs.rmdir;
  fs.rmdir = byName('rmdir', (path: RuntimeFsPath) => bySessionRmdir(path), 0, (key) => ({ type: 'call', call: { call: 'rmdir', path: key } }),
    (key, row, [path]) => holder!.provisional.rmdir(key, pathOf(path), row));
  const bySessionSymlink = fs.symlink;
  fs.symlink = byName('symlink', (target: string, path: RuntimeFsPath) => bySessionSymlink(target, path), 1, (key, [target]) => ({ type: 'call', call: { call: 'symlink', path: key, target } }),
    (key, row, [target, path]) => holder!.provisional.symlink(key, pathOf(path), target, row));

  /**
   * What a call that needed the session is told when it must answer now:
   * the name's own state where this view knows it, as the session would say
   * it (a directory, a name the process may not read); else EAGAIN, naming
   * what is not resident here.
   */
  const notResident = (syscall: string, target: unknown): Error => {
    counts.notResident++;
    const path = typeof target === 'number'
      ? (holder?.owns(target) ? '/' + holder.keyOf(target) : String(target))
      : typeof target === 'string' || (typeof target === 'object' && target !== null && 'path' in target) ? pathOf(target as RuntimeFsPath) : '';
    if (typeof target === 'string' && !target.split('/').includes('..')) {
      const walked = walkOnce('', keyOf(target), true);
      const entry = typeof walked === 'string' ? entryAt(walked) : undefined;
      if (entry?.type === 'directory') return fsError('EISDIR', syscall, target);
      if (entry && !modeAllows(entry, 4, store.cred)) return fsError('EACCES', syscall, target);
    }
    return fsError('EAGAIN', syscall, path, undefined, {
      detail: `resource temporarily unavailable, ${syscall} '${path}' — '${path}' exists but its content is not resident in this process, and a synchronous call cannot wait to fetch it`,
    });
  };

  const synchronous = Object.create(null) as RuntimeSynchronousFs;
  for (const name of names) {
    if (NO_SYNCHRONOUS_FORM.has(name) || typeof Reflect.get(fs, name) !== 'function') continue;
    Reflect.set(synchronous, name, (...args: unknown[]) => {
      const was = now;
      now = true;
      try {
        const value: unknown = Reflect.apply(Reflect.get(fs, name) as (...args: unknown[]) => unknown, fs, args);
        if (value instanceof Promise) {
          value.catch(() => {});
          throw new Error(`${name}: the synchronous filesystem began a wait`);
        }
        return value;
      } catch (error) {
        if (error === NOT_NOW) throw notResident(name, args[0]);
        throw error;
      } finally {
        now = was;
      }
    });
  }
  Reflect.set(fs, 'synchronous', synchronous);

  return fs;
}
