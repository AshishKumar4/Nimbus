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
import { flagsRefusal, openFollows, refusesDirectory } from '../../vfs/open-rules.js';
import { openFlags } from '../descriptors.js';
import { errnoCodeOf } from '../../vfs/vfs-error.js';
import { openIdentified } from './filesystem.js';
import { WASI_RESIDENT_FILE_CAP_BYTES, DIRECTORY_BATCH_LIMIT, FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES } from '../../constants.js';
import { RESIDENT_PAGE_BYTES } from '@nimbus-sh/platform/limits.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import { delegationHolder, type DelegationHolder, type HolderOptions } from './delegation-holder.js';
import { readDirectoryPool, type ReadDirectoryPool } from './read-directory-pool.js';
import type { ReadDirectorySupervisor } from '../read-directory-batch.js';
import type { VfsAcquireResult } from '../os-contracts.js';
import type { ProcessFsClient, ProcessFsJournal, ProcessFsOp, ProcessFsSession, ProcessFsStats } from '../../_shared/process-fs-client.js';
import type { WaveTimers } from '@nimbus-sh/platform/wave-writer.js';
import { abovePoint, feedOf, feedPointOf, ROOT_FEED, rootOf, type FeedPosition } from '../feed-position.js';
import { PROC_MOUNT_POINT, procFileGenerator } from '../../vfs/proc-files.js';
import { isCharacterDevice } from '../../vfs/vfs.js';

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
  /** The ACQUIRE barrier: landed when the store answers at the session's state as of it. */
  barrier(options?: ResidentBarrierOptions): Promise<ResidentBarrier>;
  /** What a barrier asks the session with (its cursor and options), for a delivery to answer from; null with no cursor. */
  acquireArgs(): ResidentAcquireArgs | null;
  /** Whether the store holds rows a repair could not vouch for: every barrier repairs until one does. */
  repairOwed?(): boolean;
  /** The store's provenance cursor: the namespace's position its rows are known-good at. */
  cursor(): FeedPosition | null;
  /** Charge `bytes` of heap held outside the store to its budget: false when they do not fit. */
  reserve(bytes: number): boolean;
  /** Return what `reserve` charged. */
  release(bytes: number): void;
  /**
   * Keep `bytes` as `key`'s content at `revision`, where its row is still at
   * it and there is room, as a fill of it would: the bytes this process made
   * of the file, which the session answered it holds at that revision.
   */
  keep?(key: string, revision: number, bytes: Uint8Array): void;
  /**
   * `listener` is told of each row the view takes in (a barrier's or an
   * answer's delta, a listing, a lookup), by its key and its file's number
   * (`dev`, `ino`, as `entry` has them), synchronously within the admission:
   * in the same turn the view holds the row, before any caller can read it,
   * so whoever holds a file by its number has its row and name as the view
   * does, never one behind. It reads the row (`entry`) only for a number it
   * holds.
   */
  onAdmitted?(listener: (key: string, dev: number, ino: number) => void): void;
}

/**
 * What a barrier asks the session with: the store's cursor, and its ACQUIRE
 * options. A process's own also carry `begin`, the watermark of its own
 * changes when they were built, and `own`, its own debt then (acquireArgs).
 */
export interface ResidentAcquireArgs {
  readonly position: FeedPosition;
  readonly options?: object;
  readonly begin?: number;
  readonly own?: number;
}

/** A read lease's terms, as an ACQUIRE answer carries them. */
export type ResidentReadLease = NonNullable<VfsAcquireResult['readLease']>;

export interface ResidentBarrierOptions {
  /** An answer the caller took itself (a directory batch's), applied as the barrier applies one. */
  readonly answer?: VfsAcquireResult;
  /**
   * An answer a delivery carried, with the arguments it was asked with: it
   * stands in for asking when it answers from a position the store has
   * reached.
   */
  readonly delivered?: { readonly args: ResidentAcquireArgs; readonly answer: VfsAcquireResult } | null;
  /** A read lease asked with the barrier: `answered` once the session grants it, whatever the barrier does next. */
  readonly lease?: { answered(terms: ResidentReadLease): void } | undefined;
}

export interface ResidentBarrier {
  /** The store answers at the session's state as of this barrier. */
  readonly landed: boolean;
  /** The answer (asked, delivered or given) was applied as it was: not started again from, nor repaired past. */
  readonly applied?: boolean;
  /** The lease the answer granted, applied with it (vouched from now). */
  readonly readLease?: ResidentReadLease;
  /** The answer a delivery carried stood in for asking. */
  readonly fromDelivery?: boolean;
  /** Its ACQUIRE got no answer (whatever a repair after it landed): a barrier failure, counted. */
  readonly dropped?: boolean;
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
  /**
   * Input arrived and the program is about to run on it (a timer, a
   * response, a relayed frame, a delivered answer): the barrier taken now,
   * so a synchronous call in what runs next reads the session's state as of
   * the input. `viaIo`: taken where I/O just arrived, which a trusted read
   * lease answers without asking (nothing the process holds has changed: a
   * change waits for the lease's recall). `delivered`: an answer the
   * delivery carried, which stands in for asking when it can. Resolves once
   * the barrier landed or failed (a failure is owed still).
   */
  catchUp(options?: { viaIo?: boolean; delivered?: ResidentBarrierOptions['delivered'] }): Promise<void>;
  /** What a barrier asks the session with, for a delivery to answer from (ResidentNamespace.acquireArgs), with the process's watermark and own debt then. */
  acquireArgs(): (ResidentAcquireArgs & { readonly begin: number; readonly own: number }) | null;
  /** A park's deadline elapsed; never install an abandoned directory open's late answer. */
  cancelPendingDirectories(): void;
  /** Whether writes are held that the session does not have yet. */
  holding(): boolean;
  /**
   * The process's filesystem client, its holder's and the only one it has:
   * its effect is the output gate (what the holder decided logged and sent
   * first, the client left live), its published and rawSocket the escapes.
   * Null where the process holds nothing (no delegation).
   */
  readonly client: ProcessFsClient | null;
  /** What the process decided and has not logged, logged now into its own log, with no round trip, and the client sealed: the run's end (DelegationHolder.logHeld). */
  logHeld(): void;
  /**
   * Send every held write to the session, before something leaves the
   * process (a socket send): what it wrote is there before anyone hears from
   * it. A refusal the session answered by then is this call's to report
   * (thrown, and reported no more).
   */
  flush(): Promise<void>;
  /** As flush, but a refusal stays recorded for the writer's close, fsync or settle (node's release barrier: an egress reports nothing). */
  send(): Promise<void>;
  /**
   * fsync(2) through a descriptor this process holds no writes for (the
   * codec's own copy of a file): the file's held writes go to the session
   * first, and what they met is this call's answer.
   */
  syncInode(dev: number, ino: number): void | Promise<void>;
  /**
   * The end of a run: every held write goes to the session, every fault-in
   * out ends, and every refusal not yet reported (by its descriptor's close
   * or fsync) is returned, naming the file, and forgotten.
   */
  settle(): Promise<UnsettledWrite[]>;
  /**
   * The reads the program was refused (`synchronous`, not resident) that
   * nothing has answered since, by key, in the order first refused, once
   * every fault-in out has ended: less those the view now knows are absent
   * (ResidentDelegation.residency; none without it). Not the run's end: a
   * live process asks as often as it reports.
   */
  misses(): Promise<string[]>;
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
  /** Of those, fetched for a refused synchronous read (ResidentDelegation.residency). */
  faultIns: number;
  /** Reads of files too big to hold whole answered through the store's pages, and the pages the session was asked for. */
  pagedReads: number;
  pagesFetched: number;
  /** ACQUIRE barriers taken, and of those, ones that did not land (owed still). */
  barriers: number;
  barrierFailures: number;
  /** Barriers owed by input a trusted read lease answered without asking. */
  leasedBarriers: number;
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
/** A directory the listing could not name, as node's walk passes it (ResidentDelegation.walkedMounts): searchable by anyone. */
const PASSED_THROUGH = { type: 'directory', mode: 0o40555, uid: 0, gid: 0 } as const;

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

/** The calls the session refuses on a directory (EISDIR): those for a file's bytes, that write one, or remove one as a file. */
const REFUSED_ON_A_DIRECTORY: ReadonlySet<string> = new Set(['readFile', 'readRange', 'writeFile', 'writeRange', 'truncate', 'unlink', 'copyFile', 'contentKey']);

/** The device of a directory the namespace makes that no backend holds (CompositeVFS: no backend's, the root mount's none). */
const NAMESPACE_DEV = 0;

/** Whether the session refuses `syscall` with `args` on a directory: an open as the session's open judges one (refusesDirectory). */
function refusesADirectory(syscall: string, args: readonly unknown[]): boolean {
  if (syscall !== 'open') return REFUSED_ON_A_DIRECTORY.has(syscall);
  const flags = args[1] as RuntimeOpenFlags | undefined;
  return flags !== undefined && refusesDirectory(flags);
}
const notNow = (): never => { throw NOT_NOW; };

/**
 * The reads a program's miss is (ProgramResidency): a file's bytes. What a
 * name is (a stat, a listing) is answered or refused as it stands, and is
 * no miss. An awaited one answers a refused one of its name.
 */
const CONTENT_READS: ReadonlySet<string> = new Set(['readFile', 'read', 'readRange']);

/** What an awaited read may be refused with that answers it all the same: the name's own state. */
const ANSWERED_REFUSALS: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR', 'ELOOP', 'EPERM']);

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
  /** The timers and clock the process's filesystem runs on (HolderOptions.timers, now): the runtime's own, not a program's. */
  readonly timers?: WaveTimers;
  readonly now?: () => number;
  /**
   * Whether this run asks a read lease with each barrier (ProcessFsClient.
   * readLeaseAsk). A run that can stop and run again takes none: when it
   * asks, and what it is answered, are the run before's.
   */
  readonly readLeases?: () => boolean;
  /** The process's own store's write log (HolderOptions.journal). */
  readonly journal?: ProcessFsJournal;
  /** Told of each change the process's client logs (HolderOptions.logged). */
  readonly logged?: HolderOptions['logged'];
  /**
   * A mount's rows are answered as the store's walk of it left it (its launch
   * named it, and a fed mount's deltas since), a feedless mount's whatever
   * its feed would say, and what this process changes on a mount (but the
   * kernel's /dev and /proc) is decided here, staying its own where the view
   * never hears of it: node's, as its fs always answered. Without it a
   * feedless mount, or a moving feed's rows under a trusted read lease, are
   * the session's to answer, and every mount's changes the session's to
   * decide.
   */
  readonly walkedMounts?: boolean;
  /**
   * A descriptor's write or truncate outside a held subtree, by a caller
   * that may wait, is answered once the session has it, its refusal the
   * call's: node's fs, as it always answered an awaited write. Without it
   * such a write is answered once logged (a WASI guest's write(2)), the
   * session's refusal its next close's, sync's or settle's.
   */
  readonly answeredWrites?: boolean;
  readonly readDirectories?: ReadDirectorySupervisor['fsReadDirectories'];
  /**
   * The directories the last process in this facet opened, in order (its
   * walked()): a run that repeats it (git status, again) opens them again,
   * so the batch prefetches them first. A guess: each prefetched
   * description is admitted only if the namespace still vouches for it.
   */
  readonly walked?: readonly string[];
  /**
   * The process's program reads synchronously (node's): a read it is
   * refused is recorded (ResidentFilesystem.misses), and a refused file's
   * bytes are fetched for its next read. Without it a refusal leaves
   * nothing (a WASI program's).
   */
  readonly residency?: ProgramResidency;
}

/**
 * What a program that reads synchronously is refused. A refused read is a
 * code no program branches on (EAGAIN cannot come of reading a regular
 * file), so whatever catches it carries on as if the file were missing:
 * the run's end reports what is left (misses), and the next launch stages
 * it. A refused read stays the program's miss until its own awaited read of
 * the name answers it (one of the file's bytes for a refused read of them,
 * any for a refused stat), or the view knows the name absent; a fill behind
 * its back or a later synchronous answer does not, since it may have built
 * on the refusal by then (vite's resolver swallows a refused package.json).
 * A refused read of a file the view has fetches its bytes for the next read
 * (a fault-in): one fetch per file while it is out, which every read of it
 * joins; the refusals of one turn are fetched together; one that did not
 * land is asked again by the next refusal.
 */
export interface ProgramResidency {
  /** The speculative read running now (the import prefetch's), or null. */
  speculation(): ResidentSpeculation | null;
  /** A read the program was refused, by key, for the first time: told as it happens, so a run the platform kills has reported it. */
  missed?(key: string): void;
}

/**
 * A speculative read (an import's prefetch, reading ahead of its load as the
 * load will read): a read refused under it is its own, never the program's,
 * and the fetch of a file it is refused is charged to its quota first.
 */
export interface ResidentSpeculation {
  /**
   * `key` was refused under it. `fetch` brings its bytes: a fill issued for
   * it, or one out it joined, telling whether they are held once it ends.
   * Null where none was issued: past its quota, or nothing to fetch (a name
   * the view cannot say, bytes only the session reads).
   */
  missed(key: string, fetch: Promise<boolean> | null): void;
  /** One more file, of `bytes`, before its fetch is issued: false past its quota, and nothing is issued. */
  charge(bytes: number): boolean;
}

export function residentFilesystem(session: RuntimeFsBridge, resident: ResidentNamespace, delegation?: ResidentDelegation): ResidentFilesystem {
  let directoryPool: ReadDirectoryPool | null = null;
  const counts: ResidentFilesystemStats = { local: 0, delegated: {}, lookups: 0, listings: 0, treeListings: 0, fills: 0, filledBytes: 0, readAhead: 0, faultIns: 0, barriers: 0, barrierFailures: 0, leasedBarriers: 0, waitMs: 0, sessionCalls: 0, notResident: 0, pinnedBytes: 0, pins: 0, provisionalBytes: 0, pagedReads: 0, pagesFetched: 0 };
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
  const residency = delegation?.residency;
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
    entry: (key) => (holder === null ? resident.entry(key) : holder.row(key)),
    children: (key) => (holder === null ? resident.children(key) : holder.children(key, resident.children(key))),
    list: (key) => begin(() => resident.list(key)),
    lookup: (keys, content) => begin(() => resident.lookup(keys, content)),
    listTree: (key) => begin(() => resident.listTree(key)),
    content: (key, revision) => resident.content(key, revision),
    fill: (key, entry) => begin(() => resident.fill(key, entry)),
    pages: (key, revision, size, first, last) => begin(() => resident.pages(key, revision, size, first, last)),
    fillMany: (files) => begin(() => resident.fillMany(files)),
    // A barrier that lands retires what this process changed and the session answered before it began:
    // a delivered answer's, when its arguments were built (acquireArgs); one this process did not build vouches for nothing.
    barrier: (options) => {
      const begun = holder?.barrierBegun();
      return begin(() => resident.barrier(options)).then((result) => {
        // A given answer was asked when its caller asked, not now: it retires nothing.
        const from = options?.answer ? undefined : result.fromDelivery ? options?.delivered?.args.begin : begun;
        if (result.landed && typeof from === 'number') holder?.retire(from);
        return result;
      });
    },
    acquireArgs: () => resident.acquireArgs(),
    ...(resident.repairOwed === undefined ? {} : { repairOwed: () => resident.repairOwed!() }),
    cursor: () => resident.cursor(),
    reserve: (bytes) => resident.reserve(bytes),
    release: (bytes) => resident.release(bytes),
  };
  const delegated = (name: string): void => { counts.delegated[name] = (counts.delegated[name] ?? 0) + 1; };
  /**
   * What the barrier is owed, of two kinds: input from outside the process
   * (`inbound`), and the process's own changes the store has not seen (a
   * wave its client sent, a call it made to the session after `changing`, a
   * client call's answer). `caught` is as much of each as a barrier that
   * landed covered: what was owed when it began, or (an answer a delivery
   * carried) its own debt as of the delivery's arguments.
   */
  const owed = { input: 0, own: 0 };
  const caught = { input: 0, own: 0 };
  const owes = (): boolean => owed.input > caught.input || owed.own > caught.own;
  /**
   * The barrier, for what is owed now: true once it lands (a debt made while
   * it ran is owed still). An answer a delivery carried stands in only if no
   * own debt arose since its arguments were built: an own change the session
   * answered meanwhile is not in it. One the session started itself (a
   * routed request's, answered from where the session stands: no arguments
   * of this process's) stands in only if no own debt arose since this
   * process last caught up (protocol §9.2's piggyback). It asks a read lease
   * with it where this run takes them, held from the moment it is granted
   * and vouched once applied.
   */
  const catchUp = (given?: ResidentBarrierOptions['delivered']): Promise<boolean> => {
    const at = { input: owed.input, own: owed.own };
    const own = given?.args.own;
    const delivered = given && (typeof own === 'number' ? owed.own <= own : owed.own <= caught.own) ? given : undefined;
    counts.barriers++;
    const client = holder?.client;
    const ask = client !== undefined && delegation?.readLeases?.() === true ? client.readLeaseAsk() : null;
    const lease = ask === null ? undefined : { answered: (terms: ResidentReadLease) => client!.readLeaseAnswered(terms) };
    return store.barrier({ ...(delivered ? { delivered } : {}), ...(lease ? { lease } : {}) }).then((result) => {
      if (!result.landed || result.dropped === true) counts.barrierFailures++;
      if (!result.landed || !store.ready()) return false;
      if (ask !== null && result.readLease && !result.fromDelivery) client!.readLeased(result.readLease, ask);
      caught.input = Math.max(caught.input, at.input);
      caught.own = Math.max(caught.own, result.fromDelivery && typeof own === 'number' ? own : at.own);
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
        ...(resident.keep === undefined ? {} : { keep: (key: string, revision: number, bytes: Uint8Array) => resident.keep!(key, revision, bytes) }),
        mounted: (key) => walkedMounts && mountedName(key),
        unreported: (key) => walkedMounts && unreportedName(key),
      },
      isHomeRoot: delegation.isHomeRoot,
      ...(delegation.grantAfter === undefined ? {} : { grantAfter: delegation.grantAfter }),
      ...(delegation.grantInos === undefined ? {} : { grantInos: delegation.grantInos }),
      ...(delegation.journal === undefined ? {} : { journal: delegation.journal }),
      ...(delegation.logged === undefined ? {} : { logged: delegation.logged }),
      ...(delegation.umask === undefined ? {} : { umask: delegation.umask }),
      ...(delegation.timers === undefined ? {} : { timers: delegation.timers }),
      ...(delegation.now === undefined ? {} : { now: delegation.now }),
      // A call of the synchronous view decides what no held subtree does, provisionally.
      cannotWait: () => now,
      // What it sent changed the session: the store catches up before it answers next.
      sent: () => { owed.own++; directoryPool?.invalidate(); },
    });
    // Each row the view takes in reaches the file the process holds by that number, in the same turn.
    const decisions = holder.provisional;
    resident.onAdmitted?.((key, dev, ino) => {
      if (decisions.inode(dev, ino) === undefined) return;
      const entry = resident.entry(key);
      if (entry) decisions.admitted(key, entry);
    });
    if (delegation.readDirectories) directoryPool = readDirectoryPool({
      call: (request) => { delegated('readDirectories'); return begin(() => delegation.readDirectories!(request)); }, store, client: holder.client,
      before: async () => { if (holder?.pending()) await holder.send(); },
    });
  }
  /** The session's descriptors this process opened read-only: closing one changes nothing, so it owes no barrier. */
  const readers = new Set<number>();
  /** Of those, the names they were opened by, whose reads answer the program's misses (ProgramResidency). */
  const readerKeys = new Map<number, string>();
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
      if (step.done) return step.value === null ? null : step.value.reached;
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
      if (entry === undefined) {
        // Node's walk passes a directory the launch's listing could not name (a device that resolves
        // its own paths shows only what its user consented to, as the session hands it the whole
        // name): a name beneath it is answered where the listing named it, else missing.
        if (!walkedMounts) return { missing: key };
        step = walk.next(PASSED_THROUGH);
        continue;
      }
      if (entry !== null && entry.dev !== store.device && !answerable(key, entry)) return DELEGATE;
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
  /** Files a batch is fetching (read ahead, or faulted in), and the batch, which a read of one joins; and the bytes read ahead so far. */
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

  /**
   * The fault-ins of refused synchronous reads (ProgramResidency): the files
   * this turn's refusals named, fetched together once its synchronous calls
   * are done (one fillMany, where a fetch may begin); and every fetch a
   * refusal issued or joined, until it ends (misses, settle).
   */
  let faults: Array<[string, ResidentEntry]> | null = null;
  let faulted: Promise<void> = Promise.resolve();
  const faulting = new Set<Promise<unknown>>();
  const outstanding = <T>(fetch: Promise<T>): Promise<T> => {
    faulting.add(fetch);
    void fetch.then(() => { faulting.delete(fetch); });
    return fetch;
  };
  const faultsEnded = async (): Promise<void> => {
    while (faulting.size > 0) await Promise.all(faulting);
  };
  /** The fetch the refusal of the synchronous call running now issued or joined. */
  let refusedFetch: Promise<boolean> | null = null;
  /**
   * A refused read of the file at `key` (`entry`), whose bytes are the
   * store's: fetched for its next read, joined with a fetch of it out; under
   * a speculation, charged to it first. Whether they are held once it ends,
   * or null where none was issued.
   */
  const faultIn = (key: string, entry: ResidentEntry): Promise<boolean> | null => {
    if (residency === undefined) return null;
    const held = (): boolean => store.content(key, entry.revision)?.byteLength === entry.size;
    const out = fetchingAhead.get(key);
    if (out !== undefined) return outstanding(out.then(held));
    const speculation = residency.speculation();
    if (speculation !== null && !speculation.charge(entry.size)) return null;
    let files = faults;
    if (files === null) {
      const named: Array<[string, ResidentEntry]> = [];
      files = faults = named;
      faulted = outstanding(Promise.resolve().then(() => { faults = null; return store.fillMany(named); }).catch(() => {}));
    }
    const batch = faulted;
    files.push([key, entry]);
    counts.fills++;
    counts.faultIns++;
    counts.filledBytes += entry.size;
    fetchingAhead.set(key, batch);
    void batch.then(() => { if (fetchingAhead.get(key) === batch) fetchingAhead.delete(key); });
    return outstanding(batch.then(held));
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
    if (entry !== null && entry.dev !== store.device && !answerable(key, entry)) return undefined;
    return entry;
  };

  /**
   * Whether the view answers for `entry` at `key`, a row off the session's
   * own filesystem's device (whose rows it answers, asked first at each
   * call site): a row of a fed mount (a mount whose backend states its
   * change model: VFS.changes, /dev and /proc among them), never one of a
   * mount without a feed (a snapshot its listing walked), which is the
   * session's to answer. A row is its fed mount's where its device is that
   * mount's root's (the deepest fed mount point at or above it): a mount
   * without a feed beneath it has a device of its own. A directory the
   * namespace makes above a fed mount point is answered too. A moving
   * feed's (not fixed) not while a read lease is trusted.
   */
  // Node's walked mounts answer its calls that cannot wait; one that may is the session's, as a fed mount's moving rows under a trusted lease are.
  const answerable = (key: string, entry: ResidentEntry): boolean => fedRow(key, entry) === true || (walkedMounts && now);
  const walkedMounts = delegation?.walkedMounts === true;
  const answeredWrites = delegation?.answeredWrites === true;

  /**
   * Whether `entry` at `key`, a row off the session's own device, is a fed
   * mount's (true), one a feed answers for but not now (false: a moving feed
   * while a read lease is trusted, or no cursor), or a mount's without a feed
   * (undefined: its changes are never reported).
   */
  const fedRow = (key: string, entry: ResidentEntry): boolean | undefined => {
    const cursor = store.cursor();
    if (cursor === null) return false;
    // A directory the namespace makes above a fed mount that no backend holds (no device: the namespace's own): the
    // table's, which a poison moves. One a backend without a feed holds is that backend's, its changes unreported.
    if (entry.type === 'directory' && entry.dev === NAMESPACE_DEV && abovePoint(cursor, key)) return true;
    const at = feedPointOf(cursor, key);
    if (at === ROOT_FEED) return undefined;
    const point = at.slice(1);
    const root = point === key ? entry : store.entry(point);
    if (root === undefined || root === null || root.dev !== entry.dev) return undefined;
    // A read lease vouches for the engine alone, whose writes recall it (a table change too): while one is
    // trusted, the view has not asked since it was granted, so a row of a feed that moves is the session's.
    return !(feedOf(cursor, at)?.fixed !== true && holder?.client.readTrusted() === true);
  };

  /** The row nearest `key` the view has: its own, else its directory's. */
  const nearestRow = (key: string): { key: string; row: ResidentEntry } | undefined => {
    const own = store.entry(key);
    if (own) return { key, row: own };
    const parent = parentKey(key);
    const above = key === '' ? undefined : store.entry(parent);
    return above ? { key: parent, row: above } : undefined;
  };
  /** Whether `key` is on a mount: a fed mount's point is at or above it, or its row (or its directory's) is a mount's. */
  const mountedName = (key: string): boolean => {
    if (onMount(key)) return true;
    const near = nearestRow(key);
    return near !== undefined && near.row.dev !== store.device && near.row.dev !== NAMESPACE_DEV;
  };
  /** Whether `key` is on a mount with no change feed: the view never hears of a change there. */
  const unreportedName = (key: string): boolean => {
    const near = nearestRow(key);
    return near !== undefined && near.row.dev !== store.device && near.row.dev !== NAMESPACE_DEV && fedRow(near.key, near.row) === undefined;
  };
  /** Whether `key` is on the kernel's /dev or /proc (a fixed feed): only the session changes them. */
  const onKernelMount = (key: string): boolean => {
    const cursor = store.cursor();
    if (cursor === null) return false;
    const at = feedPointOf(cursor, key);
    return at !== ROOT_FEED && feedOf(cursor, at)?.fixed === true;
  };

  /** Whether `key` is on a mount (its deepest fed mount point is not the root): the session's to change, never this process's to decide. */
  const onMount = (key: string): boolean => {
    const cursor = store.cursor();
    return cursor !== null && feedPointOf(cursor, key) !== ROOT_FEED;
  };

  /**
   * The row at `key` where this process may decide a change on it: the
   * session's own filesystem's (absent there too). A mount's row, or a name
   * absent on a mount, is the session's: a wave deciding on it is refused
   * (the name leads to a mount, not the file the process decided on).
   */
  const ownEntryAt = (key: string): ResidentEntry | null | undefined => {
    const entry = entryAt(key);
    if (entry === undefined) return undefined;
    if (walkedMounts) return onKernelMount(key) ? undefined : entry;
    return (entry === null ? onMount(key) : entry.dev !== store.device) ? undefined : entry;
  };

  /** Whether `entry` at `key` is a volatile /proc file: made at each read, its row size 0 (as procfs says), no bytes to hold. */
  const volatileProc = (key: string, entry: ResidentEntry): boolean => {
    if (entry.type !== 'file' || entry.size !== 0) return false;
    const cursor = store.cursor();
    return cursor !== null && feedPointOf(cursor, key) === PROC_MOUNT_POINT;
  };

  /**
   * A generated /proc file's bytes, made here by the session's own generator
   * (proc-files.ts) where this process has it; undefined where only the
   * session makes it (/proc/mounts).
   */
  const generated = (key: string): Uint8Array | undefined => {
    const generate = procFileGenerator(('/' + key).slice(PROC_MOUNT_POINT.length + 1));
    if (generate === undefined) return undefined;
    const content = generate({ ...store.cred, umask: 0 });
    return typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
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
    if (now) {
      refusedFetch = faultIn(key, entry);
      notNow();
    }
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
   * A file's bytes for a caller that may wait, where the store did not take
   * them whole (it has no room, or the file changed): read through its pages
   * at the revision the view has, each held as room allows, where the file
   * is past what one batch read asks (FS_READ_BATCH_REQUEST_BYTES). The
   * session's whole-file read holds as much of its transient allocation as
   * the file is (readWholeFile's lease), and none past what one call
   * carries (MAX_RPC_SAFE_PAYLOAD_BYTES): a page batch never asks more than
   * a batch read does, and a read of any size answers. A smaller file, or
   * one whose pages are not at that revision either, is DELEGATE: the
   * session's read, in one round trip.
   */
  const wholeByPages = (key: string, entry: ResidentEntry): Promise<Uint8Array | Delegate> | Delegate => {
    if (entry.size <= FS_READ_BATCH_REQUEST_BYTES) return DELEGATE;
    return store.pages(key, entry.revision, entry.size, 0, Math.floor((entry.size - 1) / RESIDENT_PAGE_BYTES)).then((found) => {
      if (found === null) return DELEGATE;
      counts.pagedReads++;
      counts.pagesFetched += found.fetched;
      const whole = new Uint8Array(entry.size);
      found.pages.forEach((page, at) => whole.set(page, at * RESIDENT_PAGE_BYTES));
      return whole;
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
    return after(resolve(path, follow, false, crossed), (key) => {
      // Links that do not end (more than the walk follows): open(2)'s ELOOP.
      if (key === null) throw fsError('ELOOP', 'open', pathOf(path));
      return typeof key === 'string' && key !== '' ? { key, crossed } : DELEGATE;
    });
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
    if (onMount(key)) return false;
    if (holder!.client.held(key) === undefined) return true;
    const cursor = store.cursor();
    return walks.every((walk) => walk.crossed.every((name) => holder!.entry(name) !== undefined
      || (cursor !== null && holder!.client.certifies(name, rootOf(cursor)) !== undefined)));
  };

  /** The authority, for a call that may change what the store holds: the barrier is owed once it returns. */
  const changing = <T>(name: string, call: () => T | Promise<T>): T | Promise<T> => {
    if (now) throw NOT_NOW;
    directoryPool?.invalidate();
    delegated(name);
    try {
      return after(call(), (value) => { owed.own++; return value; });
    } catch (error) {
      owed.own++;
      throw error;
    }
  };

  /**
   * A change the session made by name, for a caller that may wait in a
   * process whose view shows its own changes (a holder's): answered once a
   * barrier begun after it lands, so the view shows it before the caller
   * goes on (a call that cannot wait reads it next).
   */
  const shown = <T>(change: T | Promise<T>): T | Promise<T> => (holder === null ? change
    : after(change, (value) => (store.ready() ? catchUp().then(() => value, () => value) : value)));

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
      ? DESCRIPTOR_CALLS.has(name) ? (...args: unknown[]) => changing(name, () => call(...args)) : (...args: unknown[]) => shown(changing(name, () => call(...args)))
      : (...args: unknown[]) => {
        if (now) throw NOT_NOW;
        delegated(name);
        return call(...args);
      });
  }

  fs.inbound = () => { owed.input++; directoryPool?.invalidate(); };
  fs.catchUp = async (options = {}) => {
    fs.inbound();
    // Under a trusted read lease, I/O just arrived changes nothing this
    // process holds: the input stays owed, and what runs next reads the
    // standing view. Not past its own changes the store has not seen: the
    // lease trusts only what its client logged, and a change it made at the
    // session by name is not there. A delivery's answer, or a store owed a
    // repair, asks.
    if (options.viaIo === true && !options.delivered && owed.own <= caught.own && holder?.client.readTrusted() === true
      && store.ready() && store.repairOwed?.() !== true) {
      counts.leasedBarriers++;
      return;
    }
    await catchUp(options.delivered);
  };
  fs.acquireArgs = () => {
    const args = store.acquireArgs();
    return args === null ? null : { ...args, begin: holder?.barrierBegun() ?? 0, own: owed.own };
  };
  fs.cancelPendingDirectories = () => { owed.input++; directoryPool?.cancelPending(); };
  fs.holding = () => holder?.pending() ?? false;
  Object.defineProperty(fs, 'client', { value: holder?.client ?? null, enumerable: true });
  fs.logHeld = () => holder?.logHeld();
  // What leaves the process is preceded by everything it logged.
  fs.flush = async () => { await holder?.flush(); };
  fs.send = async () => { await holder?.send(); };
  fs.settle = async () => {
    const failures: UnsettledWrite[] = [];
    await faultsEnded();
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
      if (key === DELEGATE) return DELEGATE;
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
    // Bytes no row holds (a device's, a volatile /proc file's): a descriptor of the session's reads them.
    if (isCharacterDevice(entry.mode) || volatileProc(key, entry)) return null;
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
    if (key === DELEGATE) return DELEGATE;
    if (key === null) return null;
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    if (entry === null) return null;
    // As the authority checks: permission before what kind of name it is.
    if (!modeAllows(entry, 4, store.cred)) throw fsError('EACCES', 'open', path);
    if (entry.type === 'directory') throw fsError('EISDIR', 'open', path);
    if (entry.type !== 'file' || isCharacterDevice(entry.mode)) return DELEGATE;
    if (volatileProc(key, entry)) return generated(key) ?? DELEGATE;
    // A file this process changed is the session's to read where its bytes are not known here.
    return after(contentOf(key, entry), (bytes) => bytes ?? (holder?.provisional.pending(entry.dev, entry.ino) ? DELEGATE : wholeByPages(key, entry)));
  }), () => authority.readFile(path, options));

  fs.readdir = (path, options = {}) => answer<RuntimeVfsDirEntry[]>('readdir', () => after(resolve(path, options.followSymlinks !== false), (key) => {
    if (key === DELEGATE || key === null) return DELEGATE;
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
    if (key === DELEGATE) return DELEGATE;
    if (key === null) return null;
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    return entry !== null && entry.type === 'symlink' && entry.target !== null ? entry.target : null;
  }), () => authority.readlink(path));

  fs.realpath = (path) => answer<string>('realpath', () => after(resolve(path, true), (key) => {
    if (key === DELEGATE) return DELEGATE;
    if (key === null) throw fsError('ELOOP', 'realpath', path);
    const entry = entryAt(key);
    if (entry === undefined) return DELEGATE;
    if (entry === null) throw fsError('ENOENT', 'realpath', path);
    return '/' + key;
  }), () => authority.realpath(path));

  /** A descriptor of the holder's, as an open answers it: with its stat, the holder's. */
  /** `handleId`'s file's attributes, by its identity; where the view can say nothing of it now, what a stat by name there says (notResident). */
  const identified = (handleId: number, syscall: string): ResidentEntry => {
    const entry = holder!.fstat(handleId);
    if (entry !== undefined) return entry;
    if (now) notNow();
    throw notResident(syscall, [handleId]);
  };
  const heldOpen = (handle: RuntimeFileHandle): RuntimeOpenedFile => ({ ...handle, stat: statOf(identified(handle.id, 'open')) });

  fs.access = (path, mode) => answer<void>('access', () => after(resolve(path, true), (key) => {
    if (key === DELEGATE) return DELEGATE;
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
      // The final link followed as open(2) follows it: never under O_CREAT|O_EXCL nor O_NOFOLLOW (openFollows).
      const local = decide<RuntimeOpenedFile>(() => after(walkFor(path, openFollows(openFlags(flags))), (walk) => (walk === DELEGATE || !decidable(walk.key, walk) ? DELEGATE
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
    const row = ownEntryAt(walk.key);
    if (row === undefined) throw NOT_NOW;
    const done = decided(walk.key, row);
    if (done === false || done === undefined) throw NOT_NOW;
    counts.local++;
    return done;
  };

  /**
   * A change an awaited caller makes that the session would otherwise make by
   * name (a whole-file write, mkdir -p): decided here as a caller
   * that cannot wait decides it (`decided`), then answered once the session
   * has everything this process logged (its refusal thrown) and a barrier
   * begun after it landed, as the session's own change by name is (shown),
   * so it travels in the process's waves (a stopped run's are put back:
   * SqliteVFS restoreRun) as the program's own change. The session's
   * (`session`) where this view cannot decide it.
   */
  const decidedThenSent = <T>(decided: () => T, session: () => T | Promise<T>): T | Promise<T> => {
    if (now || holder === null) return session();
    let value: T;
    try { value = decided(); } catch { return session(); }
    return shown(holder.flush().then(() => value));
  };

  /**
   * A change by name no held subtree decided, at `keys` (where each name's
   * walk led; undefined where it led nowhere the view places): the
   * provisional decisions' (`decided`, given the row the view has at each
   * and whether its caller waits), for either caller, else the session's
   * (`session`). A caller that cannot wait is answered now, or refused as
   * one that cannot answer now. One that may wait is answered, where no
   * grant decides the name (outside one, or one the decisions touch: the
   * holder declines it), once the session answers what was decided (its
   * refusal the call's error, undone by then); where the decisions decline,
   * a grant decides a name or the view cannot place one, by the session.
   */
  const ownChange = <T>(keys: readonly (string | undefined)[], decided: (rows: (ResidentEntry | null)[], awaited: boolean) => boolean | Promise<unknown>, session: () => Awaitable<T>): Awaitable<T | undefined> => {
    const rows = keys.map((key) => (key === undefined || !store.ready() ? undefined : ownEntryAt(key)));
    const placed = rows.every((row) => row !== undefined) ? rows as (ResidentEntry | null)[] : undefined;
    if (now) {
      if (placed === undefined || decided(placed, false) === false) throw NOT_NOW;
      counts.local++;
      return undefined;
    }
    if (placed !== undefined && keys.every((key) => !holder!.holds(key!) || holder!.provisional.touches(key!))) {
      // What the view refuses (a name it says is not there, a mode it says forbids it) the session says, which
      // may hold what the view has not seen yet: a caller that may wait is answered by it, as one decided here is.
      let answer: boolean | Promise<unknown>;
      try { answer = decided(placed, true); } catch { return session(); }
      if (answer !== false) {
        counts.local++;
        return after(answer, () => undefined);
      }
    }
    return session();
  };

  /**
   * An open no held subtree decides, for a caller that cannot wait: its
   * file's, by its number (Provisional.open), its access judged and nothing
   * read; one it makes or empties, decided as a write's open is.
   */
  const openByNumber = (path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeOpenedFile => {
    if (flags.directory) throw NOT_NOW;
    return heldOpen(provisionally(path, openFollows(openFlags(flags)), (key, row) => holder!.provisional.open(key, pathOf(path), flags, row)));
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
    // A grant's cell answers here. Its own description reads the live file;
    // a borrowed anchor is only needed once no name leads to this reader's file.
    const desc = holder!.provisional.descriptor(handleId)!;
    if (!now && desc.inode.cell === undefined && holder!.provisional.sessionOf(handleId, 'read') !== undefined
      && (desc.description !== undefined || holder!.provisional.inodeOf(handleId) === undefined)) return readByAnchor(handleId, offset, length);
    const read = (): Uint8Array | undefined => holder!.read(handleId, offset, length);
    let done: Uint8Array | undefined;
    try {
      done = read();
    } catch (error) {
      if (now || (error as { code?: string }).code !== 'ESTALE') throw error;
      return readByAnchor(handleId, offset, length);
    }
    if (done !== undefined) return done;
    if (now) {
      const of = holder!.provisional.inodeOf(handleId);
      if (of !== undefined && !holder!.provisional.pending(of.entry.dev, of.entry.ino)) refusedFetch = faultIn(of.key, of.entry);
      throw NOT_NOW;
    }
    const at = holder!.provisional.inodeOf(handleId);
    if (at === undefined) return readByAnchor(handleId, offset, length);
    // Fetched by the name, while its access lets the process read it; else through its anchor, whose access was its open's.
    return Promise.resolve(contentOf(at.key, at.entry)).then(() => read() ?? readByAnchor(handleId, offset, length), (error: unknown) => {
      if (holder!.provisional.sessionOf(handleId, 'read') === undefined) throw error;
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
    const desc = holder!.provisional.descriptor(handleId)!;
    if (!desc.read) throw fsError('EBADF', 'read', desc.path);
    const key = holder!.keyOf(handleId);
    await holder!.send();
    const session = holder!.provisional.sessionOf(handleId, 'read');
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
        return after(walkFor(path, openFollows(openFlags(flags))), (walk) => {
          if (walk === DELEGATE) return DELEGATE;
          const there = ownEntryAt(walk.key);
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
        if (flags.create || flags.truncate) return shown(changing('open', () => authority.open(path, flags)));
        // An open that makes and empties nothing changes nothing: its writes will, each a call of its own.
        delegated('open');
        return after(authority.open(path, flags), (opened) => { unwritten.add(opened.id); return opened; });
      });
    }
    // A read-only open is the session's descriptor (it has what this process logged first).
    delegated('open');
    return after(authority.open(path, flags), (handle) => {
      readers.add(handle.id);
      if (residency !== undefined) readerKeys.set(handle.id, keyOf(handle.path));
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
      // As its open description at the session has it (its names, its size), as its reads are.
      if (!now && holder!.provisional.descriptor(handleId)!.inode.cell === undefined && holder!.provisional.sessionOf(handleId) !== undefined) return statByAnchor(handleId);
      const entry = identified(handleId, 'fstat');
      counts.local++;
      return statOf(entry);
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
    if (holder?.owns(handleId)) { counts.local++; return holder.write(handleId, offset, bytes, !now && answeredWrites); }
    if (now) throw NOT_NOW;
    unwritten.delete(handleId);
    return changing('write', () => authority.write(handleId, offset, bytes));
  };

  fs.ftruncate = (handleId, size) => {
    if (holder?.owns(handleId)) { counts.local++; return holder.ftruncate(handleId, size, !now && answeredWrites); }
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
      readerKeys.delete(handleId);
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
      const desc = held.provisional.descriptor(target.handle)!;
      const described = desc.inode.cell === undefined && (desc.description !== undefined || held.provisional.sessionOf(target.handle) !== undefined);
      const local = !now && described ? undefined : held.reopen(target.handle, flags);
      if (local !== undefined) { counts.local++; return heldOpen(local); }
      if (now) throw NOT_NOW;
      // Its file by its identity, not by what a stat would say of it now.
      const identity = { dev: desc.inode.dev, ino: desc.inode.ino };
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
   * A change by name neither a held subtree nor the provisional decisions
   * decide, where the store places the name: an op of the process's client
   * (ordered with everything it logged), answered once the session answers
   * it and the view shows it.
   */
  const byClient = (name: string, op: ProcessFsOp): Awaitable<void> => {
    if (now) throw NOT_NOW;
    // What the names of the files it moves grow by, admitted before anything is done: pending until the session
    // answers, and given back unless it made it.
    const files = op.type === 'rename' ? holder!.provisional.planMove(op.from, op.to, '/' + op.from) : undefined;
    return shown((async () => {
      try {
        delegated(name);
        // A name it changes: the files the process holds open at or under it write through first.
        if (op.type === 'rename') holder!.changing([op.from, op.to]);
        else if (op.type === 'call' && (op.call.call === 'unlink' || op.call.call === 'rmdir')) holder!.changing([op.call.path]);
        const answered = holder!.client.submit(op);
        try {
          await answered;
        } finally {
          owed.own++;
        }
        // The session's answer supersedes the held names it changed, even
        // while their grant remains held. Its rename moves the one registry's
        // inodes too, as a rename decided under the grant does.
        if (op.type === 'rename') {
          holder!.superseded(op.from);
          holder!.superseded(op.to);
          files?.commit();
        } else if (op.type === 'call' && (op.call.call === 'unlink' || op.call.call === 'rmdir')) holder!.superseded(op.call.path);
      } finally {
        files?.cancel();
      }
    })());
  };
  const pathOf = (path: RuntimeFsPath): string => (typeof path === 'string' ? path : path.path);

  // Changes by name a held subtree holds are decided here; any other by the provisional decisions (ownChange), else the session's.
  // A whole file written by name: made or emptied, written and closed here
  // where the holder decides that open, as the three calls are. One that
  // makes its parents is decided here too where its directory is (making
  // none); where a directory on the way is missing, the session makes them.
  const bySessionWriteFile = fs.writeFile;
  /** The walk to a file a write names; one that makes its parents and meets a directory missing on the way is the session's. */
  const walkToWrite = (path: RuntimeFsPath, makesParents: boolean): Walk | Delegate | Promise<Walk | Delegate> => {
    if (!makesParents) return walkFor(path, true);
    const missing = (error: unknown): Delegate => {
      if (errnoCodeOf(error) === 'ENOENT') return DELEGATE;
      throw error;
    };
    try {
      const walk = walkFor(path, true);
      return walk instanceof Promise ? walk.catch(missing) : walk;
    } catch (error) {
      return missing(error);
    }
  };
  fs.writeFile = (path, bytes, options) => {
    if (holder === null || options?.expectedRevision !== undefined) return bySessionWriteFile(path, bytes, options);
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const flags: RuntimeOpenFlags = { write: true, create: true, truncate: true, mode: 0o666, ...(options?.umask === undefined ? {} : { umask: options.umask }) };
    const local = decide<number>(() => after(walkToWrite(path, options?.createParents === true), (walk) => {
      if (walk === DELEGATE || !decidable(walk.key, walk)) return DELEGATE;
      return holder!.writeFile(walk.key, pathOf(path), data, flags) ?? DELEGATE;
    }));
    const decided = (): number => provisionally(path, true, (key, row) => holder!.provisional.writeFile(key, pathOf(path), data, row, options?.umask) && (holder!.entry(key)?.revision ?? 0));
    return after(local, (done) => (done !== DELEGATE ? done
      : options?.createParents === true ? bySessionWriteFile(path, bytes, options)
      : now ? decided()
      : decidedThenSent(decided, () => bySessionWriteFile(path, bytes, options))));
  };
  const bySessionMkdir = fs.mkdir;
  fs.mkdir = (path, options) => {
    if (holder === null) return bySessionMkdir(path, options);
    // A caller that cannot wait makes each missing directory on the way, as
    // mkdir -p does; any other asks the session to.
    if (options?.recursive) {
      if (typeof path !== 'string') return bySessionMkdir(path, options);
      return now ? mkdirParents(path, options) : decidedThenSent(() => mkdirParents(path, options), () => bySessionMkdir(path, options));
    }
    const mode = options?.mode ?? 0o777;
    let named: string | undefined;
    const local = decide<void>(() => after(walkFor(path, false), (walk) => {
      if (walk === DELEGATE) return DELEGATE;
      named = walk.key;
      if (!decidable(walk.key, walk)) return DELEGATE;
      return after(holder!.mkdir(walk.key, pathOf(path), mode, options?.umask), (done) => (done ? undefined : DELEGATE));
    }));
    return after(local, (done) => (done !== DELEGATE ? undefined
      : ownChange([named], ([row], awaited) => holder!.provisional.mkdir(named!, pathOf(path), mode, row, options?.umask, awaited),
        () => (named !== undefined ? byClient('mkdir', { type: 'call', call: { call: 'mkdir', path: named, mode, ...(options?.umask === undefined ? {} : { umask: options.umask }) } }) : bySessionMkdir(path, options)))));
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
      const entry = typeof walked === 'string' ? ownEntryAt(walked) : undefined;
      if (entry === undefined) throw NOT_NOW;
      if (entry === null) {
        const parent = ownEntryAt(parentKey(walked as string));
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
      : ownChange([named], ([row], awaited) => holder!.provisional.unlink(named!, pathOf(path), row, awaited),
        () => (named !== undefined ? byClient('unlink', { type: 'call', call: { call: 'unlink', path: named } }) : bySessionUnlink(path)))));
  };
  /**
   * The store's bytes of the file `walk` reaches (a decidable walk), where
   * this view is the session's for them (ProcessFsClient.vouch at the view's
   * cursor: the file held, and nothing of the process's own missing from
   * the view). Undefined where the view cannot vouch for them.
   */
  const vouchedContent = ({ key }: Walk): Uint8Array | undefined => {
    const cursor = store.cursor();
    if (cursor === null || holder!.client.vouch(key, rootOf(cursor)) !== 'held') return undefined;
    const entry = entryAt(key);
    return entry ? store.content(key, entry.revision) : undefined;
  };
  // A copy both of whose names a held subtree holds, its source's bytes the
  // holder's or ones the view vouches for: decided here; any other, and one
  // that preserves (cp -p's metadata, the session's to judge), the session's.
  const bySessionCopy = fs.copyFile;
  fs.copyFile = (from, to, options) => {
    if (holder === null || options?.preserve === true) return bySessionCopy(from, to, options);
    const local = decide<void>(() => after(walkFor(from, true), (source) => (source === DELEGATE ? DELEGATE
      : after(walkFor(to, true), (target) => {
        if (target === DELEGATE || !decidable(target.key, source, target)) return DELEGATE;
        return holder!.copyFile(source.key, target.key, pathOf(to), vouchedContent(source), options?.keepMode === true) ? undefined : DELEGATE;
      }))));
    // A caller that cannot wait copies what this view holds of the source, as it reads it.
    return after(local, (done) => (done !== DELEGATE ? undefined
      : now ? void provisionally(from, true, (source, row) => {
        if (row === null) throw fsError('ENOENT', 'copyfile', pathOf(from));
        return provisionally(to, true, (target, there) => holder!.provisional.copyFile(source, target, pathOf(to), row, there, options?.keepMode === true));
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
      : ownChange(names ?? [undefined], ([source, target], awaited) => holder!.provisional.rename(names![0], names![1], pathOf(from), source, target, awaited),
        () => (names !== undefined ? byClient('rename', { type: 'rename', from: names[0], to: names[1] }) : bySessionRename(from, to)))));
  };
  // An attribute change by name: decided here where a held subtree holds the
  // name (counted toward taking it either way), else by the provisional
  // decisions (ownChange), else the session's, after what the holder has;
  // one it holds but did not decide (another's file, a grant the session
  // judges) is the session's in its view after. A link's own (lchown,
  // lutimes) only by the provisional decisions, which log it as its call.
  for (const name of ['chmod', 'chown', 'utimes'] as const) {
    const passed = Reflect.get(fs, name) as (...args: unknown[]) => unknown;
    Reflect.set(fs, name, (path: RuntimeFsPath, ...rest: unknown[]) => {
      const link = name !== 'chmod' && (rest[2] as { followSymlinks?: boolean } | undefined)?.followSymlinks === false;
      const attrs: W7Attrs = name === 'chmod' ? { mode: Number(rest[0]) }
        : name === 'chown' ? { uid: ownerSide(rest[0]), gid: ownerSide(rest[1]) }
        : { atime: rest[0] as FsTime, mtime: rest[1] as FsTime };
      if (holder === null) return passed.call(fs, path, ...rest);
      let named: string | undefined;
      const local = decide<void>(() => after(walkFor(path, !link), (walk) => {
        if (walk === DELEGATE) return DELEGATE;
        named = walk.key;
        if (link || !decidable(walk.key, walk)) return DELEGATE;
        return holder!.setattr(walk.key, attrs) ? undefined : DELEGATE;
      }));
      return after(local, (done) => {
        if (done !== DELEGATE) return undefined;
        const key = named;
        return ownChange([key], ([row], awaited) => holder!.provisional.setattr(key!, pathOf(path), attrs, row, awaited, link), () => (key === undefined || !holder!.holds(key)
          ? passed.call(fs, path, ...rest)
          : after(passed.call(fs, path, ...rest), (receipt) => { holder!.undecided(key); return receipt; })));
      });
    });
  }
  // Nothing of these is decided by a held subtree: by the provisional
  // decisions, else by the client when the store places the name.
  const byName = <A extends unknown[]>(name: 'rmdir' | 'symlink', passed: (...args: A) => Awaitable<void>, pathAt: number, op: (key: string, args: A) => ProcessFsOp,
    decided: (key: string, row: ResidentEntry | null, args: A, awaited: boolean) => boolean | Promise<unknown>) =>
    (...args: A): Awaitable<void> => {
      if (holder === null) return passed(...args);
      return after(walkFor(args[pathAt] as RuntimeFsPath, false), (walk) => {
        const key = walk === DELEGATE ? undefined : walk.key;
        return ownChange([key], ([row], awaited) => decided(key!, row, args, awaited), () => (key === undefined ? passed(...args) : byClient(name, op(key, args))));
      });
    };
  const bySessionRmdir = fs.rmdir;
  fs.rmdir = byName('rmdir', (path: RuntimeFsPath) => bySessionRmdir(path), 0, (key) => ({ type: 'call', call: { call: 'rmdir', path: key } }),
    (key, row, [path], awaited) => holder!.provisional.rmdir(key, pathOf(path), row, awaited));
  const bySessionSymlink = fs.symlink;
  fs.symlink = byName('symlink', (target: string, path: RuntimeFsPath) => bySessionSymlink(target, path), 1, (key, [target]) => ({ type: 'call', call: { call: 'symlink', path: key, target } }),
    (key, row, [target, path], awaited) => holder!.provisional.symlink(key, pathOf(path), target, row, awaited));

  /**
   * What a call that needed the session is told when it must answer now:
   * the name's own state where this view knows it, as the session would say
   * it to this call (a directory to a call for a file's bytes or that makes
   * one, a name the process may not read); else EAGAIN, naming what is not
   * resident here.
   */
  /**
   * What the session's open says of `flags` at `path` before it opens
   * anything, where this view knows the name (SqliteRuntimeFsBridge.open, in
   * Linux's order): the flags alone (flagsRefusal), a name there under
   * O_CREAT|O_EXCL, a link the open declined to follow. Null where it would
   * go on to open.
   */
  const openRefusal = (path: string, given: RuntimeOpenFlags): Error | null => {
    const flags = openFlags(given);
    const flagged = flagsRefusal(flags);
    if (flagged !== null) return fsError(flagged, 'open', path);
    let walked: ReturnType<typeof walkOnce>;
    try { walked = walkOnce('', keyOf(path), openFollows(flags)); } catch { return null; }
    const entry = typeof walked === 'string' ? entryAt(walked) : undefined;
    if (!entry) return null;
    if (flags.exclusive && flags.create) return fsError('EEXIST', 'open', path);
    if (entry.type === 'symlink' && !flags.followSymlinks) return fsError(flags.directory ? 'ENOTDIR' : 'ELOOP', 'open', path);
    return null;
  };
  const notResident = (syscall: string, args: readonly unknown[]): Error => {
    counts.notResident++;
    const target = args[0];
    const path = typeof target === 'number'
      ? (holder?.owns(target) ? '/' + holder.keyOf(target) : String(target))
      : typeof target === 'string' || (typeof target === 'object' && target !== null && 'path' in target) ? pathOf(target as RuntimeFsPath) : '';
    if (syscall === 'open' && typeof target === 'string' && !target.split('/').includes('..')) {
      const refusal = openRefusal(target, args[1] as RuntimeOpenFlags);
      if (refusal !== null) return refusal;
    }
    if (typeof target === 'string' && !target.split('/').includes('..')) {
      const walked = walkOnce('', keyOf(target), true);
      const entry = typeof walked === 'string' ? entryAt(walked) : undefined;
      if (entry?.type === 'directory' && refusesADirectory(syscall, args)) return fsError('EISDIR', syscall, target);
      if (entry && !modeAllows(entry, 4, store.cred)) return fsError('EACCES', syscall, target);
    }
    return fsError('EAGAIN', syscall, path, undefined, {
      detail: `resource temporarily unavailable, ${syscall} '${path}' — '${path}' exists but its content is not resident in this process, and a synchronous call cannot wait to fetch it`,
    });
  };

  /** The program's refused reads nothing has answered since (misses), by key, in the order first refused. */
  const missed = new Set<string>();
  /** The key a read names: as spelled, no link followed; a descriptor, its file's name. */
  const keyFor = (target: unknown): string | undefined => {
    if (typeof target === 'number') return holder?.owns(target) ? holder.keyOf(target) : readerKeys.get(target);
    if (typeof target === 'string') return keyOf(target);
    if (typeof target === 'object' && target !== null && 'root' in target) return keyOf(`${(target as { root: string }).root}/${pathOf(target as RuntimeFsPath)}`);
    return undefined;
  };
  /** A synchronous read refused as not resident: its speculation's, or the program's miss. `fetch`: the fault-in it issued or joined. */
  const refused = (syscall: string, args: readonly unknown[], fetch: Promise<boolean> | null): void => {
    const key = CONTENT_READS.has(syscall) ? keyFor(args[0]) : undefined;
    if (key === undefined) return;
    const speculation = residency!.speculation();
    if (speculation !== null) {
      speculation.missed(key, fetch);
      return;
    }
    if (missed.has(key)) return;
    missed.add(key);
    residency!.missed?.(key);
  };
  /** The program's awaited read of `args[0]` answered: the miss of that name goes, as spelled and as it resolves. */
  const answered = (args: readonly unknown[]): void => {
    const key = keyFor(args[0]);
    if (key === undefined) return;
    missed.delete(key);
    try {
      const at = walkOnce('', key, true);
      if (typeof at === 'string') missed.delete(at);
    } catch { /* the name as spelled */ }
  };
  if (residency !== undefined) {
    for (const name of CONTENT_READS) {
      const passed: unknown = Reflect.get(fs, name);
      if (typeof passed !== 'function') continue;
      Reflect.set(fs, name, (...args: unknown[]) => {
        // A miss is answered by the program's own read, which may wait, asked once it was refused.
        if (now || missed.size === 0) return Reflect.apply(passed, fs, args);
        const refusal = (error: unknown): never => {
          if (ANSWERED_REFUSALS.has(errnoCodeOf(error) ?? '')) answered(args);
          throw error;
        };
        let answer: unknown;
        try { answer = Reflect.apply(passed, fs, args); } catch (error) { return refusal(error); }
        if (!(answer instanceof Promise)) { answered(args); return answer; }
        return answer.then((value: unknown) => { answered(args); return value; }, refusal);
      });
    }
  }
  /** Whether the view knows nothing is at `key`, links followed: the session proved it absent. */
  const knownAbsent = (key: string): boolean => {
    if (!store.ready()) return false;
    try {
      const at = walkOnce('', key, true);
      return typeof at === 'string' && entryAt(at) === null;
    } catch (error) {
      const code = errnoCodeOf(error);
      return code === 'ENOENT' || code === 'ENOTDIR';
    }
  };
  fs.misses = async () => {
    await faultsEnded();
    for (const key of [...missed]) if (knownAbsent(key)) missed.delete(key);
    return [...missed];
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
        if (error !== NOT_NOW) throw error;
        const refusal = notResident(name, args);
        if (residency !== undefined && errnoCodeOf(refusal) === 'EAGAIN') refused(name, args, refusedFetch);
        refusedFetch = null;
        throw refusal;
      } finally {
        now = was;
      }
    });
  }
  Reflect.set(fs, 'synchronous', synchronous);

  return fs;
}
