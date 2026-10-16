/**
 * A WASI process as a delegation's holder (spike/delegation/MEMO.md, P4a):
 * inside the subtrees it holds, the process decides its creates, writes,
 * mkdirs, unlinks, renames and attribute changes itself, against what its
 * resident store knows and what it decided, with no round trip, and logs
 * them as calls into the process's filesystem client (process-fs-client.ts,
 * P4b), which takes the subtrees, numbers the log and sends it, in order:
 * at each point where what it wrote could be observed (a socket send, an
 * fsync, the end of its run) and when the session recalls a subtree.
 *
 * What it decides is the session's answer, kept exactly:
 *   - A subtree is held once the process has mutated in it often enough to
 *     be worth it (the client's policy): the deepest existing directory
 *     holding the name it changes, a bounded number of them. Never the
 *     whole filesystem, a home directory itself, or the session's stores
 *     (the session refuses those), and never a subtree with a default ACL
 *     in it (its inheritance is the session's to apply): there, the process
 *     writes through as before.
 *   - Refusals are the walk's own (resolve), and the cases decided here are
 *     the plain ones: a create where the parent is a writable directory, a
 *     mkdir, an unlink of a file or link, a rename of a file, or of a
 *     directory to a free name outside itself, within one held subtree. Any
 *     other mutation in a held subtree sends the log first and is the
 *     session's, as before.
 *   - A name made here is numbered from the grant's reserved inode range and
 *     keeps that number in the session; it is owned as the session makes a
 *     holder's names (the process's, a setgid directory's group), its mode
 *     the asked mode less the umask.
 *   - The log keeps program order: each decision is logged as it is made,
 *     and a file's bytes, which change write by write, are logged whole (its
 *     latest) before the next decision is, or at the flush.
 *
 * A recall is answered by a loop per grant on the host side of the process:
 * a guest that waits in a syscall lets it run; one computing does not
 * (the documented limit, answered by the session's recall timeout).
 */

import type { FsTime, RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import { fsError } from '../beneath-walk.js';
import { chmodRefusal, chownedMode, chownRefusal, confinedModeRefusal, explicitTimes, modeAllows, timeAt, utimesRefusal } from '../../vfs/posix-access.js';
import { copiedPermissions, copyfileMode } from '../../vfs/vfs.js';
import { ownNames } from './own-names.js';
import { provisional as provisionalDecisions, type Provisional } from './provisional.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import { LINGER_MS, processFsClient, type ProcessFsClient, type ProcessFsGrant, type ProcessFsJournal, type ProcessFsOp, type ProcessFsSession } from '../../_shared/process-fs-client.js';

/** Descriptors this holder opens are numbered below every session descriptor. */
const FIRST_LOCAL_HANDLE = -1;

/** What the holder reads of the process's resident store (its own decisions aside). */
export interface HolderStore {
  readonly device: number;
  readonly cred: { uid: number; gid: number; groups: readonly number[] };
  /** As ResidentNamespace.entry: undefined when the store does not know. */
  entry(key: string): ResidentEntry | null | undefined;
  /** As ResidentNamespace.children. */
  children(key: string): RuntimeVfsDirEntry[] | undefined;
  /** As ResidentNamespace.content: the store's bytes of `key` at `revision`, where it holds them. */
  content?(key: string, revision: number): Uint8Array | undefined;
  /** As ResidentNamespace.reserve and release: what a provisional decision keeps takes of the process's budget (no grant reserved it). */
  reserve?(bytes: number): boolean;
  release?(bytes: number): void;
}

export interface HolderOptions {
  /** The session the process's filesystem client sends to and takes its grants from. */
  readonly session: ProcessFsSession;
  readonly store: HolderStore;
  /** Every engine key that is a home directory (`home/<name>`): never held itself. */
  readonly isHomeRoot?: (key: string) => boolean;
  /** Told when what the holder decided changed the namespace the store shows (the barrier is owed after a send). */
  readonly sent?: () => void;
  /** The clock files are stamped with. */
  readonly now?: () => number;
  /** Mutations in a subtree before it is taken (the client's GRANT_AFTER). */
  readonly grantAfter?: number;
  /** Inode numbers a first grant reserves (the client's GRANT_INOS). */
  readonly grantInos?: number;
  /** Where the client logs what it sends until the session answers: the process's own store, where it has one (process-fs-journal.ts). */
  readonly journal?: ProcessFsJournal;
  /**
   * Whether the caller deciding now cannot wait (ResidentFilesystem.synchronous):
   * what no held subtree decides is then its provisional decisions' (provisional.ts),
   * and a change is counted toward taking a subtree only once one makes it.
   */
  readonly cannotWait?: () => boolean;
  /** The process's live umask, for what it makes provisionally (a held subtree's grant carries the session's). */
  readonly umask?: () => number;
}

/** A file made or rewritten here: its bytes until they are sent. */
/** An attribute change by a descriptor: a mode, an owner (null or -1 kept), or times (FsTime). */
export type HolderAttrChange = { mode: number } | { uid: number | null; gid: number | null } | { atime: FsTime; mtime: FsTime };

interface LocalFile {
  key: string;
  bytes: Uint8Array;
  length: number;
  mode: number;
  /** Made here and not yet logged: its number, which its first logged write carries. */
  made?: number;
  /** The umask its mode was decided under, which its logged writeFile carries. */
  umask?: number;
  /**
   * How many of its bytes the log holds as they are now (a logged
   * decision of it), and the lowest offset written since: a file that only
   * changed past what was logged is logged from there, not whole.
   */
  logged?: number;
  changedFrom?: number;
  /**
   * Its name is gone (unlinked, or replaced by a rename) while descriptions
   * of it are open: they read and write its bytes, and no name is written
   * with them (POSIX: the file outlives its last name until its last close).
   * `detached` is its stat when it lost the name (nlink 0): what fstat of
   * those descriptions answers, never what a name leads to now.
   */
  detached?: ResidentEntry;
  /**
   * Written through: no subtree this process holds covers it (opened
   * outside one, or its grant was shared, recalled or given back). Nothing
   * of it is decided here: each write, append and truncate is a call by its
   * number (`ino`), ordered with everything else the process does; `bytes`
   * holds nothing, `length` is its size as this process last made or saw
   * it, and `entry` its stat at the open (or when it went through).
   */
  through?: { ino: number; entry: ResidentEntry };
}

interface LocalHandle {
  file: LocalFile;
  readable: boolean;
  writable: boolean;
  append: boolean;
  position: number;
  path: string;
  /**
   * Written through: the session's open description it writes by (W7Call
   * description), its access fixed at its open; and the session's descriptor
   * of it once the open is answered, which it reads and stats through.
   */
  description?: string;
  session?: Promise<number | undefined>;
}

/** A new open description's id: unguessable, so no other process's call names it. */
const descriptionId = (): string => crypto.randomUUID().replaceAll('-', '');

/** The decisions the process made in a held subtree, not yet sent. */
export interface DelegationHolder {
  /** The process's filesystem client: what the holder decided is logged into it. */
  readonly client: ProcessFsClient;
  /** What a caller that cannot wait decides where no held subtree does: its descriptors are the holder's too (owns). */
  readonly provisional: Provisional;
  /** What the process decided is at `key`: an entry, null (removed), or undefined (nothing decided). */
  entry(key: string): ResidentEntry | null | undefined;
  /** The names in `key`, as `base` lists them with what the process decided there. */
  children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
  /** The bytes of a file made or rewritten here. */
  content(entry: ResidentEntry): Uint8Array | undefined;
  /** Whether `handleId` is one of the holder's own descriptors. */
  owns(handleId: number): boolean;
  /**
   * Open `key` to write it at the session, as a write description outside
   * any subtree this process holds: one `open` call (W7Call open), ordered
   * with everything the process logged before it and answered with the
   * file's stat; the description it returns writes through (LocalFile.through).
   */
  openThrough(key: string, path: string, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle>;
  /**
   * Everything logged so far answered, what the session refused kept for the
   * next sync (flush) to report: what goes before a call to the session.
   */
  send(): Promise<void>;
  /** A refusal the session has made of what this process logged, thrown now (with its errno), not waiting for anything: what a close reports. */
  reportRecorded(): void;
  /**
   * Whether a change written through (no subtree held decides it: its bytes
   * are the session's, not held here) was logged since the store last
   * caught up: what the store answers waits for it to be sent (send), so the
   * process reads its own writes.
   */
  throughPending(): boolean;
  /**
   * The process is about to change a name or an access at or above `keys`
   * (anywhere, when absent) by a route not decided here (a call of the
   * session's, or a change by name the client logs): each file it holds
   * open there writes through from now on, its descriptions opened first.
   */
  changing(keys?: readonly string[]): void;
  /** Whether `handleId` writes through: its reads are the session's (readThrough). */
  through(handleId: number): boolean;
  /** A write-through description's session descriptor (its open answered), or undefined (a mount's file keeps none). */
  sessionOf(handleId: number): Promise<number | undefined>;
  /** fcntl(F_SETFL) of one of the holder's descriptors: O_APPEND is its writes' to keep. */
  setStatus(handleId: number, status: { append?: boolean }): void;
  /** The size this process gave file `ino` through a description of it still open, or undefined: what a stat of it by name reports here. */
  writing(ino: number): number | undefined;
  /**
   * A read through a write-through description, at `offset` or its
   * position: `read` reads the session's bytes of `key` (what this process
   * sent before it is answered first).
   */
  readThrough(handleId: number, offset: number | null, length: number, read: (key: string, at: number, length: number) => Promise<Uint8Array>): Promise<Uint8Array>;
  /**
   * Decide an open that creates or empties a file at `key` (resolved, its
   * parent known): a descriptor of the holder's, or undefined when the
   * session is to decide it.
   */
  open(key: string, path: string, flags: RuntimeOpenFlags): RuntimeFileHandle | undefined;
  /** As open, with room for `initial` bytes drawn before anything is decided (undefined where there is none). */
  openFor(key: string, path: string, flags: RuntimeOpenFlags, initial: number): RuntimeFileHandle | undefined;
  /**
   * A whole file written by name (an open of `flags`, a write and a close),
   * decided here as `open` decides: its revision, or undefined when the
   * session must write it. Its bytes' room is drawn before anything is
   * decided, so no name is made for bytes that do not fit.
   */
  writeFile(key: string, path: string, bytes: Uint8Array, flags: RuntimeOpenFlags): number | undefined;
  /** Undefined where its bytes are the store's and it does not hold them (a provisional descriptor's: Provisional.inodeOf). */
  read(handleId: number, offset: number | null, length: number): Uint8Array | undefined;
  write(handleId: number, offset: number | null, bytes: Uint8Array): number;
  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
  ftruncate(handleId: number, size: number): void;
  fstat(handleId: number): ResidentEntry;
  close(handleId: number): void;
  /** The name a descriptor of the holder's writes, now. */
  keyOf(handleId: number): string;
  /** Another descriptor of the same open file (its position shared). */
  dup(handleId: number): RuntimeFileHandle;
  /**
   * A new open of the file a descriptor of the holder's is on (an open of
   * /proc/self/fd/N), its offset its own, when decided here: a file whose
   * bytes are here, opened without O_APPEND. Undefined when the session is
   * to decide it (by the file's identity, once what was decided is sent).
   */
  reopen(handleId: number, flags: { read?: boolean; write?: boolean; append?: boolean; create?: boolean; exclusive?: boolean; truncate?: boolean }): RuntimeFileHandle | undefined;
  /**
   * Decide a copy of the file at `from` to `to` (both resolved): true when
   * decided here, its bytes `bytes` where they are not the holder's own
   * (what the store read of it under the grant). Its mode as the session's
   * copy leaves it: cp(1)'s (a new file the source's permission bits less
   * the umask, one there its own), or with `keepMode` copyfile's
   * (copyfileMode). Logged as the copy is made, through one description:
   * the destination opened (O_CREAT|O_TRUNC; with `keepMode` its fchmod,
   * part of the open, as libuv's copyfile makes it), the bytes written
   * through it, and its close.
   */
  copyFile(from: string, to: string, path: string, bytes: Uint8Array | undefined, keepMode: boolean): boolean;
  /**
   * Log every decided file's unlogged bytes now, into the process's own log
   * and with no session round trip: what its facet keeps of it when the
   * session ends it (a resident's settle, before its facet goes). The log is
   * the session's drain's from then on (ProcessFsClient.seal).
   */
  logHeld(): void;
  /** Decide a mkdir at `key`: true when decided here (and done), false when the session is to. */
  mkdir(key: string, path: string, mode: number, umask?: number): boolean;
  /** Decide an unlink of `key` (a file or link): true when decided here. */
  unlink(key: string, path: string): boolean;
  /** Decide a rename of `from` to `to` (both resolved): true when decided here. */
  rename(from: string, to: string, path: string): boolean;
  /** Decide an attribute change of `key`: true when decided here. */
  setattr(key: string, attrs: W7Attrs): boolean;
  /**
   * Decide an attribute change of the file `handleId` opened (fchmod,
   * fchown, futimes): true when decided here, for a file of the holder's
   * that lost its name, or one it decides under its name, its times
   * resolved here as it is decided; false when it is the session's, through
   * the description it holds of the file (restat after).
   */
  fsetattr(handleId: number, change: HolderAttrChange): boolean;
  /** The session's stat of the file a through description opened, after a change through it: what fstat answers from now on. */
  restat(handleId: number, stat: Omit<ResidentEntry, 'target'>): void;
  /**
   * The session changed `key`'s attributes itself, after everything the
   * holder had was sent (one it holds but did not decide): what was decided
   * of it is the session's now, and the store answers it after its barrier.
   */
  undecided(key: string): void;
  /** Whether a mutation at `key` would be decided here (a held subtree holds it). */
  holds(key: string): boolean;
  /** A barrier begins: its number, which `retire` takes once it lands. */
  barrierBegun(): number;
  /**
   * Barrier `begun` landed: what this process changed by name and the
   * session answered before it began is the view's now. Its own record of
   * each such name retires, outside a held subtree (a held one keeps its
   * decisions while it holds it).
   */
  retire(begun: number): void;
  /** Whether anything decided here is not sent yet. */
  pending(): boolean;
  /** Send everything decided, in order. A refusal is thrown (the run fails, naming it). */
  flush(): Promise<void>;
  /** The end of the run: send everything, and give every subtree back. */
  settle(): Promise<void>;
  /** Waves sent, recalls answered, and grants taken. */
  stats(): { waves: number; ops: number; recalls: number; grants: number; widened: number };
}

function parentKey(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

function nameOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

function within(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

export function delegationHolder(options: HolderOptions): DelegationHolder {
  const { store } = options;
  const now = options.now ?? Date.now;
  /** What it decided by name, until the view has it. */
  const names = ownNames({
    entry: (key) => store.entry(key),
    held: (key) => client.held(key) !== undefined,
    // A cell goes with its name, but for bytes still unlogged or open.
    forgot: (key, entry) => {
      const file = entry ? files.get(entry.ino) : undefined;
      if (file === undefined || file.key !== key || file.through !== undefined || dirty.has(file) || isOpen(file)) return;
      files.delete(entry!.ino);
    },
  });
  /** Files whose bytes are here, by inode number. */
  const files = new Map<number, LocalFile>();
  const handles = new Map<number, LocalHandle>();
  let nextHandle = FIRST_LOCAL_HANDLE;
  /** Files written since their bytes were last logged, in the order last written. */
  const dirty = new Set<LocalFile>();

  // Changes logged, numbered; the last written through (the store answers for it once sent);
  // and the last a completed send covered: a send covers only what was logged when it began.
  let changes = 0;
  let throughLogged = 0;
  let sentAt = 0;

  /** Log `op`, the process told it succeeded. */
  const acknowledged = (op: ProcessFsOp) => client.submit(op, { acknowledged: true });

  /**
   * The grant of a subtree the process holds at `key`, which decides a
   * change there, counted toward taking one either way; undefined where none
   * does, or where a provisional decision of the process's on the name is
   * not yet the view's (provisional.ts decides there until it is). A caller
   * that cannot wait counts nothing here: its change is counted where it is
   * made (Provisional), never for one it cannot make now.
   */
  const deciding = (key: string): ProcessFsGrant | undefined => {
    if (options.cannotWait?.() === true && client.held(key) === undefined) return undefined;
    const grant = client.holder(key);
    return grant === undefined || prov.touches(key) ? undefined : grant;
  };

  /**
   * `file` stops being decided here (its grant is shared, recalled or gone,
   * or the process is about to change a name or an access above it): what
   * it holds was logged, and it writes through from now on. Each open
   * description of it is opened at the session, in the log's order, with
   * the access it was opened with. `made`: the file is not made at the
   * session yet, and its mode refuses what its descriptions do (creat(2) of
   * 0444): its first description's open makes it (create, exclusive, its
   * number), which keeps that access as creat(2) does, and its bytes are
   * written through that description.
   */
  const goThrough = (file: LocalFile, ino: number, made?: number): void => {
    if (file.through !== undefined) return;
    delete file.logged;
    const entry = names.decided(file.key) ?? store.entry(file.key);
    file.through = {
      ino,
      entry: entry ?? {
        type: 'file', dev: store.device, ino, nlink: 1, size: file.length, atime: now(), mtime: now(), ctime: now(),
        mode: 0o100000 | file.mode, uid: store.cred.uid, gid: store.cred.gid, revision: 0, target: null,
      },
    };
    const bytes = file.bytes.subarray(0, file.length);
    file.bytes = new Uint8Array(0);
    dirty.delete(file);
    const opened = [...new Set(handles.values())].filter((handle) => handle.file === file && handle.description === undefined);
    opened.forEach((handle, at) => {
      const description = handle.description = descriptionId();
      // The first makes the file when it is not made yet: the creating open, and the bytes written through it.
      const creating = made !== undefined && at === 0;
      const making = creating ? { create: true as const, exclusive: true as const, ino: made, ...(file.umask === undefined ? {} : { umask: file.umask }) } : {};
      const answer = acknowledged({ type: 'call', call: { call: 'open', path: file.key, mode: file.mode, ...making, ...(handle.readable ? { read: true as const } : {}), description } });
      handle.session = answer.then((answered) => answered.receipt?.handle, () => undefined);
      if (creating && bytes.byteLength > 0) {
        acknowledged({ type: 'call', call: { call: 'write', path: file.key, ino, description, offset: 0, data: bytes.slice() } });
      }
    });
  };

  /** Whether a description of `file` is open here. */
  const isOpen = (file: LocalFile): boolean => {
    for (const handle of handles.values()) if (handle.file === file) return true;
    return false;
  };

  /** Whether `file`'s mode, as decided here, refuses one of its open descriptions what it was opened to do: only its creating open could have. */
  const refusedByMode = (file: LocalFile): boolean => {
    const entry = names.decided(file.key);
    if (entry === undefined || entry === null) return false;
    for (const handle of handles.values()) {
      if (handle.file === file && !modeAllows(entry, handle.readable ? 6 : 2, store.cred)) return true;
    }
    return false;
  };

  /**
   * The process is about to change a name or an access at or above `keys`
   * (anywhere, when absent): each file it holds open there goes through
   * first. With the grant exclusive, the session's state under it changes
   * only by what this process does; so switching before each such change
   * keeps the local open's view exact: the open sent now is decided against
   * the state the local open saw, never re-authorized against a later one.
   */
  const throughAt = (keys?: readonly string[]): void => {
    const open: [number, LocalFile][] = [];
    for (const [ino, file] of files) {
      if (file.through !== undefined || file.detached !== undefined || !isOpen(file)) continue;
      if (keys === undefined || keys.some((key) => within(file.key, key))) open.push([ino, file]);
    }
    if (open.length === 0) return;
    drain();
    for (const [ino, file] of open) goThrough(file, ino);
  };

  /**
   * Log each file's latest bytes, in the order last written, under the name
   * it has now: whole, or where the log holds what it was up to an offset,
   * from there (cut to its length first, where it shrank).
   */
  const drain = (): void => {
    if (dirty.size > 0) changes++;
    for (const file of [...dirty]) {
      const from = Math.min(file.changedFrom ?? 0, file.logged ?? 0);
      // A copy: the file's buffer keeps changing as the process writes. A
      // file made here makes its name with this write, with its number.
      const ino = file.made;
      // Its mode refuses its creating open what it writes: made by that open, and written through it.
      if (ino !== undefined && refusedByMode(file)) {
        dirty.delete(file);
        delete file.changedFrom;
        delete file.made;
        goThrough(file, ino, ino);
        continue;
      }
      if (ino === undefined && from > 0) {
        if (file.length < file.logged!) acknowledged({ type: 'call', call: { call: 'ftruncate', path: file.key, size: file.length } });
        if (file.length > from) acknowledged({ type: 'call', call: { call: 'write', path: file.key, offset: from, data: file.bytes.slice(from, file.length) } });
      } else {
        acknowledged({ type: 'call', call: { call: 'writeFile', path: file.key, mode: file.mode, ...(ino === undefined ? {} : { ino }), ...(file.umask === undefined ? {} : { umask: file.umask }), data: file.bytes.slice(0, file.length) } });
      }
      // Unlogged until the log took it: one that refused it (the session
      // ended the process) leaves it for the settle's (logHeld).
      dirty.delete(file);
      delete file.changedFrom;
      delete file.made;
      file.logged = file.length;
    }
  };

  /** Armed while a file's bytes are unlogged: logs them at the latest LINGER_MS after the first, as the client sends what lingers. */
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The subtree at `root` is no longer held: what was decided there is sent,
   * and retires as anything of the process's own does, once a barrier
   * begun after its answer lands (retire). Its files' open descriptions
   * write through from now on: a peer may write the file, and a whole-file
   * write of what this process held would overwrite what the peer wrote.
   */
  const dropDecisions = (root: string): void => {
    drain();
    for (const [ino, file] of files) if (within(file.key, root)) goThrough(file, ino);
    names.released(root);
    options.sent?.();
  };

  const client = processFsClient({
    session: options.session,
    now,
    ...(options.isHomeRoot === undefined ? {} : { isHomeRoot: options.isHomeRoot }),
    ...(options.grantAfter === undefined ? {} : { grantAfter: options.grantAfter }),
    ...(options.grantInos === undefined ? {} : { grantInos: options.grantInos }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    released: dropDecisions,
    // Closing starts (a recall, an idle or renewing give-back): nothing more
    // is decided under it, and its files' descriptions write through from now
    // on, so the flush that follows covers everything accepted before.
    freezing: (root) => {
      drain();
      for (const [ino, file] of files) if (within(file.key, root)) goThrough(file, ino);
    },
    drain,
  });

  /** A file's bytes held here (decided under a grant), not written through. */
  const heldContent = (entry: ResidentEntry): Uint8Array | undefined => {
    if (entry.dev !== store.device) return undefined;
    const file = files.get(entry.ino);
    // A file written through holds no bytes here: the session's are its.
    return file === undefined || file.through !== undefined ? undefined : file.bytes.slice(0, file.length);
  };

  const prov: Provisional = provisionalDecisions({
    // The store's, as it knows it when asked (it learns it at its first barrier).
    get device() { return store.device; },
    get cred() { return store.cred; },
    row: (key) => entryOf(key),
    children: (key) => names.children(key, store.children(key)),
    content: (key, revision) => {
      const entry = names.decided(key);
      return (entry ? heldContent(entry) : undefined) ?? store.content?.(key, revision);
    },
    reserve: (bytes) => store.reserve?.(bytes) ?? true,
    release: (bytes) => store.release?.(bytes),
    client,
    drain,
    sent: () => options.sent?.(),
    held: (key) => client.held(key) !== undefined,
    count: (key) => { client.holder(key); },
    umask: () => options.umask?.() ?? 0o022,
    now,
    nextHandle: () => nextHandle--,
  });

  /** Log a decision, after the bytes written before it. */
  const log = (op: ProcessFsOp): void => {
    drain();
    changes++;
    acknowledged(op);
  };

  /** What was logged up to `covered` reached the session: the store owes a barrier once something did. */
  const sentSome = (covered: number): void => {
    if (covered <= sentAt) return;
    sentAt = covered;
    options.sent?.();
  };

  const entryOf = (key: string): ResidentEntry | null | undefined => {
    const mine = names.entry(key);
    return mine !== undefined ? mine : store.entry(key);
  };

  /** The ownership a new name under `parent` takes: the process's, with a setgid directory's group. */
  const ownership = (parent: ResidentEntry): { uid: number; gid: number; setgid: boolean } => {
    const setgid = (parent.mode & 0o2000) !== 0;
    return { uid: store.cred.uid, gid: setgid ? parent.gid : store.cred.gid, setgid };
  };

  /** The parent of `key`, when the process may make a name in it: a known, writable, searchable directory of the session's filesystem. */
  const writableParent = (key: string, path: string, syscall: string): ResidentEntry | undefined => {
    const parent = entryOf(parentKey(key));
    if (parent === undefined || parent === null || parent.dev !== store.device) return undefined;
    if (parent.type !== 'directory') throw fsError('ENOTDIR', syscall, path);
    if (!modeAllows(parent, 3, store.cred)) throw fsError('EACCES', syscall, path);
    return parent;
  };

  /**
   * The file's bytes changed, from `from` on: logged before the next
   * decision, at the flush, or LINGER_MS after the first unlogged change,
   * whichever comes first.
   */
  const written = (file: LocalFile, from = 0): void => {
    if (file.detached) return;
    file.changedFrom = Math.min(file.changedFrom ?? from, from);
    dirty.delete(file);
    dirty.add(file);
    lingerTimer ??= setTimeout(() => {
      lingerTimer = null;
      // No caller to answer here: a log that refuses (the session ended the
      // process) keeps the bytes unlogged, for the settle, and the next flush reports it.
      try { drain(); } catch { /* the next flush reports it */ }
    }, LINGER_MS);
  };

  /** `file` lost its name (it was `entry`): what is written through its open descriptions stays theirs. */
  const detach = (file: LocalFile, entry: ResidentEntry): void => {
    file.detached = { ...entry, nlink: 0, size: file.length };
    delete file.logged;
    dirty.delete(file);
  };

  const handleOf = (handleId: number): LocalHandle => {
    const handle = handles.get(handleId);
    if (handle === undefined) throw fsError('EBADF', 'fd', String(handleId));
    return handle;
  };

  /**
   * Room for `length` bytes of `file`: drawn from the storage its subtree's
   * grant reserved while one holds it. A file whose grant is being given back
   * (renewed, idle) or is gone grows as any write does: the session judges
   * its bytes when they reach it (a refusal then is the flush's error).
   */
  const room = (file: LocalFile, length: number): boolean => {
    if (length <= file.bytes.byteLength) return true;
    const grant = client.held(file.key);
    const size = Math.max(length, file.bytes.byteLength * 2, 4096);
    if (grant !== undefined && !client.draw(grant, size - file.bytes.byteLength)) return false;
    const next = new Uint8Array(size);
    next.set(file.bytes.subarray(0, file.length));
    file.bytes = next;
    return true;
  };

  /** What the session refused of what was decided here: the run fails, naming it. */
  const failed = (): void => {
    const failures = client.takeFailures();
    if (failures.length > 0) {
      // Its first refusal's errno is the call's (EACCES, ENOSPC, …), as the session said it.
      throw fsError(failures[0]!.errno, 'fsync', failures[0]!.path, undefined, {
        detail: `the session refused what this process decided: ${failures.map((failure) => `${failure.op} ${failure.path}: ${failure.message}`).join('; ')}`,
      });
    }
  };

  /** An owner or group id a chown keeps (null, or -1 as fchown(2) spells it): null, as chownRefusal takes it. */
  const kept = (id: number | null): number | null => (id === -1 ? null : id);

  /** `entry` as chmod, chown (the set-id bits chownedMode clears) and utimes leave it, its ctime now. */
  const changedBy = (entry: ResidentEntry, attrs: W7Attrs): ResidentEntry => (
    'mode' in attrs ? { ...entry, mode: (entry.mode & ~0o7777) | (attrs.mode & 0o7777), ctime: now() }
      : 'uid' in attrs ? { ...entry, uid: kept(attrs.uid) ?? entry.uid, gid: kept(attrs.gid) ?? entry.gid, mode: chownedMode(entry.mode, store.cred), ctime: now() }
        : { ...entry, atime: attrs.atime, mtime: attrs.mtime, ctime: now() });

  const holder: DelegationHolder = {
    client,
    provisional: prov,

    // The provisional decisions are the newest wherever they are pending: a held subtree decides nothing there (deciding).
    entry: (key) => {
      const mine = prov.entry(key);
      return mine !== undefined ? mine : names.entry(key);
    },

    children: (key, base) => prov.children(key, names.children(key, base)),

    copyFile: (from, to, path, stored, keepMode) => {
      const source = entryOf(from);
      // The source as the session's copy reads it: a file it may read, no set-id bit (the session's to judge).
      if (source === undefined || source === null || source.type !== 'file' || (source.mode & 0o7000) !== 0) return false;
      if (!modeAllows(source, 4, store.cred)) return false;
      const target = entryOf(to);
      if (target === undefined || (target !== null && target.type !== 'file')) return false;
      // Counted toward taking the destination's subtree, as any change there is.
      const grant = deciding(to);
      if (grant === undefined || client.held(from) === undefined) return false;
      const bytes = holder.content(source) ?? stored;
      if (bytes === undefined) return false;
      const known = target === null ? undefined : files.get(target.ino);
      // Another's file there, or one this process holds open, is the session's to copy over.
      if (target !== null && ((store.cred.uid !== 0 && target.uid !== store.cred.uid) || (known !== undefined && isOpen(known)))) return false;
      const umask = grant.umask;
      const asked = copiedPermissions(source.mode, false);
      // What the open leaves (cp(1)'s mode), and with keepMode its fchmod to the source's: one a confined principal may not grant is the session's.
      const opened = target === null ? asked & ~umask : target.mode & 0o7777;
      const mode = keepMode ? copyfileMode(source.mode, bytes.byteLength, store.cred.uid) : opened;
      if (keepMode && confinedModeRefusal(opened, mode) !== null) return false;
      let entry: ResidentEntry;
      let made: number | undefined;
      if (target === null) {
        const parent = writableParent(to, path, 'copyfile');
        if (parent === undefined) return false;
        made = client.number(grant);
        if (made === undefined) return false;
        const { uid, gid } = ownership(parent);
        const stamp = now();
        entry = { type: 'file', dev: store.device, ino: made, nlink: 1, size: bytes.byteLength, atime: stamp, mtime: stamp, ctime: stamp, mode: 0o100000 | mode, uid, gid, revision: 0, target: null };
      } else {
        if (!modeAllows(target, 2, store.cred)) throw fsError('EACCES', 'copyfile', path);
        entry = { ...target, size: bytes.byteLength, mode: (target.mode & ~0o7777) | mode, mtime: now(), ctime: now() };
      }
      // After everything decided before it, the destination's own bytes among them.
      drain();
      // Held here as an emptied file's written bytes are: in its cell (an
      // O_TRUNC open keeps it), what more they take drawn from what the
      // grant reserved (room); else the session copies.
      const file: LocalFile = known !== undefined && known.through === undefined ? known : { key: to, bytes: new Uint8Array(0), length: 0, mode };
      if (!room(file, bytes.byteLength)) return false;
      file.bytes.set(bytes);
      file.length = bytes.byteLength;
      file.logged = bytes.byteLength;
      file.mode = mode;
      if (target === null) names.note(parentKey(to), nameOf(to), 'file');
      names.decide(to, entry);
      files.set(entry.ino, file);
      const description = descriptionId();
      changes++;
      acknowledged({ type: 'call', call: { call: 'open', path: to, mode: asked, ...(made === undefined ? {} : { ino: made, umask }), create: true, truncate: true, ...(keepMode ? { fchmod: mode } : {}), description } });
      acknowledged({ type: 'call', call: { call: 'write', path: to, ...(made === undefined ? {} : { ino: made }), description, offset: 0, data: bytes.slice() } });
      acknowledged({ type: 'call', call: { call: 'close', path: to, description } });
      return true;
    },

    logHeld: () => {
      client.seal();
      drain();
    },

    content: (entry) => prov.content(entry) ?? heldContent(entry),

    owns: (handleId) => handles.has(handleId) || prov.owns(handleId),

    open: (key, path, flags) => holder.openFor(key, path, flags, 0),

    openFor: (key, path, flags, initial) => {
      if (!flags.write || flags.append) return undefined;
      if (!flags.create && !flags.truncate) return undefined;
      // Set-id and sticky bits asked at creation are the session's to grant or strip.
      if (((flags.mode ?? 0o666) & 0o7000) !== 0) return undefined;
      const current = entryOf(key);
      if (current === undefined || (current !== null && current.type !== 'file')) return undefined;
      const grant = deciding(key);
      if (grant === undefined) return undefined;
      if (current !== null && flags.exclusive && flags.create) throw fsError('EEXIST', 'open', path);
      if (current === null && !flags.create) throw fsError('ENOENT', 'open', path);
      let file: LocalFile;
      if (current === null) {
        const parent = writableParent(key, path, 'open');
        if (parent === undefined) return undefined;
        const asked = (flags.mode ?? 0o666) & 0o777;
        const umask = flags.umask ?? grant.umask;
        // Its mode was decided under this umask: the session applies the same one, and its number.
        file = { key, bytes: new Uint8Array(0), length: 0, mode: asked, umask };
        // Room for what it is opened to be written with, before anything is decided.
        if (!room(file, initial)) return undefined;
        const ino = client.number(grant);
        if (ino === undefined) return undefined;
        file.made = ino;
        const { uid, gid } = ownership(parent);
        const stamp = now();
        const entry: ResidentEntry = {
          type: 'file', dev: store.device, ino, nlink: 1, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
          mode: 0o100000 | (asked & ~umask), uid, gid, revision: 0, target: null,
        };
        names.decide(key, entry);
        names.note(parentKey(key), nameOf(key), 'file');
        files.set(ino, file);
        // Made here: the name exists from now on, in the log's order. Logged
        // with its bytes, before the next decision (drain), as one call.
        drain();
        written(file);
      } else if (!flags.truncate) {
        // An existing file opened to write, not emptied (O_CREAT without
        // O_TRUNC): its bytes are kept, so only one whose bytes are here is
        // opened here; any other is the session's. Read permission too, when
        // it is opened to read.
        if (!modeAllows(current, flags.read ? 6 : 2, store.cred)) throw fsError('EACCES', 'open', path);
        const local = files.get(current.ino);
        if (local === undefined || local.key !== key || local.through !== undefined) return undefined;
        file = local;
      } else {
        // An existing file emptied: decided here, its number the session's.
        if (!modeAllows(current, flags.read ? 6 : 2, store.cred)) throw fsError('EACCES', 'open', path);
        // A description writing it through is the session's: decided here anew.
        const known = files.get(current.ino);
        file = known !== undefined && known.through === undefined ? known : { key, bytes: new Uint8Array(0), length: 0, mode: current.mode & 0o7777 };
        if (!room(file, initial)) return undefined;
        file.length = 0;
        files.set(current.ino, file);
        names.decide(key, { ...current, size: 0, mtime: now(), ctime: now() });
        written(file);
      }
      const id = nextHandle--;
      handles.set(id, { file, readable: !!flags.read, writable: true, append: false, position: 0, path });
      return { id, path } as RuntimeFileHandle;
    },

    writeFile: (key, path, bytes, flags) => {
      // Its bytes' room drawn as it is opened: a write that cannot fail it.
      const handle = holder.openFor(key, path, flags, bytes.byteLength);
      if (handle === undefined) return undefined;
      holder.write(handle.id, 0, bytes);
      const revision = holder.fstat(handle.id).revision;
      holder.close(handle.id);
      return revision;
    },

    openThrough: async (key, path, flags) => {
      const description = descriptionId();
      const call: ProcessFsOp = {
        type: 'call',
        call: {
          call: 'open', path: key, mode: (flags.mode ?? 0o666) & 0o7777,
          ...(flags.umask === undefined ? {} : { umask: flags.umask }),
          ...(flags.create ? { create: true as const } : {}),
          ...(flags.truncate ? { truncate: true as const } : {}),
          ...(flags.exclusive ? { exclusive: true as const } : {}),
          ...(flags.followSymlinks === false ? { nofollow: true as const } : {}),
          ...(flags.read ? { read: true as const } : {}),
          description,
        },
      };
      // After what was decided before it, as every op is.
      drain();
      const answer = await client.submit(call);
      const stat = answer.receipt;
      if (stat === undefined) throw fsError('EIO', 'open', path);
      // A write through it has nothing of its own to be told: the session is current.
      options.sent?.();
      const entry: ResidentEntry = {
        type: 'file', dev: stat.dev, ino: stat.ino, nlink: 1, size: stat.size, atime: stat.mtimeMs, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
        mode: stat.mode, uid: stat.uid, gid: stat.gid, revision: stat.revision ?? 0, target: null,
      };
      // One file per number: every description of it shares its size.
      const known = files.get(stat.ino);
      const file: LocalFile = known?.through !== undefined
        ? Object.assign(known, { key, length: stat.size, through: { ino: stat.ino, entry } })
        : { key, bytes: new Uint8Array(0), length: stat.size, mode: stat.mode & 0o7777, through: { ino: stat.ino, entry } };
      files.set(stat.ino, file);
      const id = nextHandle--;
      handles.set(id, { file, readable: !!flags.read, writable: true, append: !!flags.append, position: 0, path, description, session: Promise.resolve(stat.handle) });
      return { id, path } as RuntimeFileHandle;
    },

    through: (handleId) => handles.get(handleId)?.file.through !== undefined,

    sessionOf: (handleId) => handles.get(handleId)?.session ?? Promise.resolve(undefined),

    setStatus: (handleId, status) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.setStatus(handleId, status);
      if (status.append !== undefined) handle.append = status.append;
    },

    writing: (ino) => {
      const file = files.get(ino);
      if (file?.through === undefined) return undefined;
      for (const handle of handles.values()) if (handle.file === file) return file.length;
      return undefined;
    },

    readThrough: async (handleId, offset, length, read) => {
      const handle = handleOf(handleId);
      if (!handle.readable) throw fsError('EBADF', 'read', handle.path);
      // What this process wrote is the session's before it reads.
      await client.flush();
      const start = offset ?? handle.position;
      const chunk = await read(handle.file.key, start, length);
      if (offset === null) handle.position = start + chunk.byteLength;
      return chunk;
    },

    read: (handleId, offset, length) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.read(handleId, offset, length);
      if (!handle.readable) throw fsError('EBADF', 'read', handle.path);
      const start = Math.min(offset ?? handle.position, handle.file.length);
      const chunk = handle.file.bytes.slice(start, Math.min(handle.file.length, start + length));
      if (offset === null) handle.position = start + chunk.byteLength;
      return chunk;
    },

    write: (handleId, offset, bytes) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.write(handleId, offset, bytes);
      const file = handle.file;
      if (file.through !== undefined) {
        // Through: by the file's number, ordered with everything else; an
        // O_APPEND write lands at the file's end as the session has it then.
        const { ino } = file.through;
        const by = handle.description === undefined ? {} : { description: handle.description };
        if (handle.append) {
          acknowledged({ type: 'call', call: { call: 'append', path: file.key, ino, ...by, data: bytes.slice() } });
          file.length += bytes.byteLength;
          handle.position = file.length;
        } else {
          const at = offset ?? handle.position;
          acknowledged({ type: 'call', call: { call: 'write', path: file.key, ino, ...by, offset: at, data: bytes.slice() } });
          file.length = Math.max(file.length, at + bytes.byteLength);
          if (offset === null) handle.position = at + bytes.byteLength;
        }
        throughLogged = ++changes;
        return bytes.byteLength;
      }
      const start = handle.append ? file.length : offset ?? handle.position;
      const end = start + bytes.byteLength;
      if (!room(file, end)) throw fsError('ENOSPC', 'write', handle.path);
      const from = Math.min(start, file.length);
      if (start > file.length) file.bytes.fill(0, file.length, start);
      file.bytes.set(bytes, start);
      file.length = Math.max(file.length, end);
      if (offset === null || handle.append) handle.position = end;
      const entry = names.decided(file.key);
      if (entry) names.decide(file.key, { ...entry, size: file.length, mtime: now(), ctime: now() });
      written(file, from);
      return bytes.byteLength;
    },

    seek: (handleId, offset, whence) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.seek(handleId, offset, whence);
      const position = (whence === 'set' ? 0 : whence === 'current' ? handle.position : handle.file.length) + offset;
      if (position < 0) throw fsError('EINVAL', 'lseek', handle.path);
      handle.position = position;
      return position;
    },

    ftruncate: (handleId, size) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.ftruncate(handleId, size);
      if (!handle.writable) throw fsError('EINVAL', 'ftruncate', handle.path);
      const file = handle.file;
      if (file.through !== undefined) {
        acknowledged({ type: 'call', call: { call: 'ftruncate', path: file.key, ino: file.through.ino, ...(handle.description === undefined ? {} : { description: handle.description }), size } });
        file.length = size;
        throughLogged = ++changes;
        return;
      }
      if (!room(file, size)) throw fsError('ENOSPC', 'ftruncate', handle.path);
      const from = Math.min(size, file.length);
      if (size > file.length) file.bytes.fill(0, file.length, size);
      file.length = size;
      const entry = names.decided(file.key);
      if (entry) names.decide(file.key, { ...entry, size, mtime: now(), ctime: now() });
      written(file, from);
    },

    fstat: (handleId) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.fstat(handleId);
      const file = handle.file;
      // Through: its stat at the open, with its size as this process made it.
      if (file.through !== undefined) return { ...file.through.entry, size: file.length };
      // Its name gone: the description's own file, as it was then.
      if (file.detached !== undefined) return { ...file.detached, size: file.length };
      const entry = names.decided(file.key) ?? store.entry(file.key);
      if (!entry) throw fsError('EBADF', 'fstat', handle.path);
      return { ...entry, size: file.length };
    },

    close: (handleId) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.close(handleId);
      handles.delete(handleId);
      // The session's description closes with its last descriptor here (a dup shares it), in the log's order.
      if (handle.description === undefined) return;
      for (const other of handles.values()) if (other === handle) return;
      acknowledged({ type: 'call', call: { call: 'close', path: handle.file.key, description: handle.description } });
      throughLogged = ++changes;
    },

    keyOf: (handleId) => handles.get(handleId)?.file.key ?? prov.keyOf(handleId),

    dup: (handleId) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.dup(handleId);
      const id = nextHandle--;
      handles.set(id, handle);
      return { id, path: handle.path } as RuntimeFileHandle;
    },

    reopen: (handleId, flags) => {
      const handle = handles.get(handleId);
      if (handle === undefined) return prov.reopen(handleId, flags);
      const file = handle.file;
      if (file.through !== undefined || flags.append) return undefined;
      const entry = file.detached ?? names.decided(file.key) ?? store.entry(file.key);
      if (!entry) throw fsError('EBADF', 'open', handle.path);
      if (flags.create && flags.exclusive) throw fsError('EEXIST', 'open', handle.path);
      if (!modeAllows(entry, (flags.read ? 4 : 0) | (flags.write || flags.truncate ? 2 : 0), store.cred)) throw fsError('EACCES', 'open', handle.path);
      // Its truncate is made before the descriptor exists: one whose room is not there is the session's.
      if (flags.truncate && !room(file, 0)) return undefined;
      const id = nextHandle--;
      handles.set(id, { file, readable: !!flags.read, writable: !!flags.write, append: false, position: 0, path: handle.path });
      if (flags.truncate) {
        const from = 0;
        file.length = 0;
        const decided = names.decided(file.key);
        if (decided) names.decide(file.key, { ...decided, size: 0, mtime: now(), ctime: now() });
        written(file, from);
      }
      return {
        id, path: handle.path, position: 0, closed: false,
        flags: { read: !!flags.read, write: !!flags.write, append: false, create: !!flags.create, exclusive: !!flags.exclusive, directory: false, truncate: !!flags.truncate, followSymlinks: true },
      };
    },

    mkdir: (key, path, mode, mask) => {
      if ((mode & 0o7000) !== 0) return false;
      const current = entryOf(key);
      if (current === undefined) return false;
      const grant = deciding(key);
      if (grant === undefined) return false;
      if (current !== null) throw fsError('EEXIST', 'mkdir', path);
      const parent = writableParent(key, path, 'mkdir');
      if (parent === undefined) return false;
      const ino = client.number(grant);
      if (ino === undefined) return false;
      const { uid, gid, setgid } = ownership(parent);
      const stamp = now();
      const umask = mask ?? grant.umask;
      const perm = (mode & 0o777 & ~umask) | (setgid ? 0o2000 : 0);
      names.decide(key, {
        type: 'directory', dev: store.device, ino, nlink: 2, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
        mode: 0o40000 | perm, uid, gid, revision: 0, target: null,
      });
      names.note(parentKey(key), nameOf(key), 'directory');
      names.madeDirectory(key);
      log({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, ino, umask } });
      return true;
    },

    unlink: (key, path) => {
      const current = entryOf(key);
      if (current === undefined || current === null || current.type === 'directory') return false;
      if (deciding(key) === undefined) return false;
      if (writableParent(key, path, 'unlink') === undefined) return false;
      names.decide(key, null);
      names.note(parentKey(key), nameOf(key), null);
      const local = files.get(current.ino);
      if (local !== undefined && local.key === key) {
        files.delete(current.ino);
        // Its bytes go with it: nothing of them is logged, now or through a
        // description still open on it.
        detach(local, current);
        // Made here and never logged: the session never had the name.
        if (local.made !== undefined) return true;
      }
      log({ type: 'call', call: { call: 'unlink', path: key } });
      return true;
    },

    rename: (from, to, path) => {
      const source = entryOf(from);
      const target = entryOf(to);
      if (source === undefined || source === null || target === undefined) return false;
      if (source.type === 'directory' && (target !== null || within(to, from))) return false;
      if (target !== null && (target.type === 'directory' || source.type === 'directory')) return false;
      const grant = deciding(from);
      if (grant === undefined || deciding(to) !== grant) return false;
      if (from === to) return true;
      if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined) return false;
      // What was written before the rename is logged under the name it had.
      drain();
      // What was decided under the source moves with it.
      names.move(from, to);
      names.decide(from, null);
      names.decide(to, { ...source, ctime: now() });
      names.note(parentKey(from), nameOf(from), null);
      names.note(parentKey(to), nameOf(to), source.type);
      // A file it replaces loses its name: its open descriptions keep its bytes.
      if (target !== null) {
        const replaced = files.get(target.ino);
        if (replaced !== undefined && replaced.key === to) { files.delete(target.ino); detach(replaced, target); }
      }
      for (const file of files.values()) if (within(file.key, from)) file.key = to + file.key.slice(from.length);
      log({ type: 'rename', from, to });
      return true;
    },

    setattr: (key, attrs) => {
      const current = entryOf(key);
      if (current === undefined || current === null) return false;
      if (deciding(key) === undefined) return false;
      // Only the owner (or root) changes a mode, an owner or times here, as
      // chmod, chown and utimes allow it; anything else is the session's to judge.
      if (store.cred.uid !== 0 && store.cred.uid !== current.uid) return false;
      if ('uid' in attrs && chownRefusal(current, kept(attrs.uid), kept(attrs.gid), store.cred) !== null) return false;
      // A grant a confined principal may not make: the session's to judge.
      if ('mode' in attrs && confinedModeRefusal(current.mode, attrs.mode) !== null) return false;
      if ('mode' in attrs) throughAt([key]);
      const next = changedBy(current, attrs);
      names.decide(key, next);
      const local = files.get(current.ino);
      if (local !== undefined) local.mode = next.mode & 0o7777;
      log({ type: 'setattr', path: key, attrs: 'uid' in attrs ? { uid: next.uid, gid: next.gid } : attrs });
      return true;
    },

    fsetattr: (handleId, change) => {
      const handle = handles.get(handleId);
      if (handle === undefined) {
        prov.fsetattr(handleId, change);
        return true;
      }
      const file = handle.file;
      if (file.through !== undefined) return false;
      const entry = file.detached ?? names.decided(file.key) ?? store.entry(file.key);
      if (entry === undefined || entry === null) return false;
      // Its times as it is decided (timeAt): now, explicit, or as they are.
      const at = now();
      const attrs: W7Attrs = 'atime' in change ? { atime: timeAt(change.atime, entry.atime, at), mtime: timeAt(change.mtime, entry.mtime, at) } : change;
      if (file.detached === undefined) return holder.setattr(file.key, attrs);
      // Its name gone, the file is this process's alone: judged and changed
      // here, as the session judges a description, its confinement of the
      // principal too (judged confined once no grant there says).
      const confined = client.held(file.key)?.confined ?? true;
      const refused = 'mode' in attrs ? chmodRefusal(entry, store.cred) ?? (confined ? confinedModeRefusal(entry.mode, attrs.mode) : null)
        : 'uid' in attrs ? chownRefusal(entry, kept(attrs.uid), kept(attrs.gid), store.cred)
        : utimesRefusal(entry, 'atime' in change && explicitTimes(change.atime, change.mtime), store.cred);
      if (refused !== null) throw fsError(refused, 'mode' in attrs ? 'fchmod' : 'uid' in attrs ? 'fchown' : 'futimes', '/' + file.key);
      file.detached = changedBy(entry, attrs);
      file.mode = file.detached.mode & 0o7777;
      return true;
    },
    undecided: (key) => { names.undecide(key); },
    restat: (handleId, stat) => {
      const through = handles.get(handleId)?.file.through;
      if (through !== undefined) through.entry = { ...stat, target: null };
    },

    holds: (key) => client.held(key) !== undefined,
    barrierBegun: () => {
      prov.barrierBegun();
      return names.barrierBegun();
    },
    retire: (begun) => {
      names.retire(begun);
      prov.retire(begun);
    },
    pending: () => dirty.size > 0 || client.pending(),
    flush: async () => {
      drain();
      const covered = changes;
      await client.flush();
      sentSome(covered);
      failed();
    },
    send: async () => {
      drain();
      const covered = changes;
      await client.flush();
      sentSome(covered);
    },
    reportRecorded: () => failed(),

    throughPending: () => throughLogged > sentAt,

    changing: (keys) => throughAt(keys),
    settle: async () => {
      drain();
      const covered = changes;
      await client.settle();
      sentSome(covered);
    },
    stats: () => {
      const stats = client.stats();
      return { waves: stats.waves, ops: stats.ops, recalls: stats.recalls, grants: stats.grants, widened: stats.widened };
    },
  };
  return holder;
}
