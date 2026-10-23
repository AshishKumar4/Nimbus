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

import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import type { ResidentEntry } from './resident-filesystem.js';
import { fsError } from '../beneath-walk.js';
import { chmodRefusal, chownedMode, chownRefusal, confinedModeRefusal, explicitTimes, modeAllows, timeAt, utimesRefusal } from '../../vfs/posix-access.js';
import { copiedPermissions, copyfileMode } from '../../vfs/vfs.js';
import { ownNames } from './own-names.js';
import { provisional as provisionalDecisions, type Desc, type HeldCell, type Inode, type Provisional } from './provisional.js';
import { owned } from './inode-fold.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import { LINGER_MS, processFsClient, type ProcessFsClient, type ProcessFsClientOptions, type ProcessFsGrant, type ProcessFsJournal, type ProcessFsOp, type ProcessFsSession } from '../../_shared/process-fs-client.js';
import type { WaveTimers } from '@nimbus-sh/platform/wave-writer.js';
import {
  arrayJoin, bytesCopy, bytesView, dateNow, mathMax, mathMin, ownValue, promiseThen, SafeSet, stringLastIndexOf, stringOf, stringSlice,
  stringStartsWith, typedArrayByteLength, typedArrayFill, typedArraySet, Uint8ArrayConstructor,
} from '../../_shared/primordials.js';

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
  /** As ProvisionalHost.mounted and unreported: a name on a mount, and one the view never hears a change of. */
  mounted?(key: string): boolean;
  unreported?(key: string): boolean;
  /** As ProvisionalHost.keep: bytes the session holds of `key` at `revision`, the view's to keep. */
  keep?(key: string, revision: number, bytes: Uint8Array): void;
}

export interface HolderOptions {
  /** The session the process's filesystem client sends to and takes its grants from. */
  readonly session: ProcessFsSession;
  readonly store: HolderStore;
  /** Every engine key that is a home directory (`home/<name>`): never held itself. */
  readonly isHomeRoot?: (key: string) => boolean;
  /** Told when what the holder decided changed the namespace the store shows (the barrier is owed after a send). */
  readonly sent?: () => void;
  /** The clock files are stamped with, and its client runs on. */
  readonly now?: () => number;
  /** The timers its client lingers and retries on (ProcessFsClientOptions.timers). */
  readonly timers?: WaveTimers;
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
  /**
   * The process's live umask: for what it makes provisionally (a held
   * subtree's grant carries the session's), and stamped by its client on
   * each call logged that makes a name and does not name one.
   */
  readonly umask?: () => number;
  /** Told of each change its client logs (ProcessFsClientOptions.logged). */
  readonly logged?: ProcessFsClientOptions['logged'];
}

/** A file made or rewritten here: its bytes until they are sent. */
/** An attribute change by a descriptor: a mode, an owner (null or -1 kept), or times (FsTime). */

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
  /** What the process sees at `key`: what it decided (entry), else the store's; undefined where neither knows. */
  row(key: string): ResidentEntry | null | undefined;
  /** The names in `key`, as `base` lists them with what the process decided there. */
  children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
  /** The bytes of a file made or rewritten here. */
  content(entry: ResidentEntry): Uint8Array | undefined;
  /** Whether `handleId` is one of the holder's own descriptors. */
  owns(handleId: number): boolean;
  /**
   * Everything logged so far answered, what the session refused kept for the
   * next sync (flush) to report: what goes before a call to the session.
   */
  send(): Promise<void>;
  /** A refusal the session has made of what this process logged, thrown now (with its errno), not waiting for anything: what a close reports. */
  reportRecorded(): void;
  /**
   * The process is about to change a name or an access at or above `keys`
   * (anywhere, when absent) by a route not decided here (a call of the
   * session's, or a change by name the client logs): no grant decides a
   * file it holds open there from now on (Provisional.unhold), its
   * descriptions opened at the session first.
   */
  changing(keys?: readonly string[]): void;
  /** fcntl(F_SETFL) of one of the holder's descriptors: O_APPEND is its writes' to keep. */
  setStatus(handleId: number, status: { append?: boolean }): void;
  /**
   * Decide an open that creates or empties a file at `key` (resolved, its
   * parent known): a descriptor of the holder's, or undefined when the
   * session is to decide it.
   */
  open(key: string, path: string, flags: RuntimeOpenFlags, initial?: number): RuntimeFileHandle | undefined;

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
  /** Its file's attributes, by its identity: undefined where the view can say nothing of it now (Provisional.fstat). */
  fstat(handleId: number): ResidentEntry | undefined;
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
   * An attribute change of the file `handleId` opened (fchmod, fchown,
   * futimes): decided here where the file's grant decides it (or it lost its
   * name: it is this process's alone), its times resolved as it is decided;
   * true then. False where the provisional decisions logged it, through its
   * description: the session's to apply (a caller that may wait waits for it).
   */
  fsetattr(handleId: number, change: W7Attrs): boolean;
  /**
   * The session changed `key`'s attributes itself, after everything the
   * holder had was sent (one it holds but did not decide): what was decided
   * of it is the session's now, and the store answers it after its barrier.
   */
  undecided(key: string): void;
  /** The session moved or removed the name `key` (OwnNames.superseded). */
  superseded(key: string): void;
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
  const at = stringLastIndexOf(key, '/');
  return at < 0 ? '' : stringSlice(key, 0, at);
}

function nameOf(key: string): string {
  return stringSlice(key, stringLastIndexOf(key, '/') + 1);
}

function within(key: string, root: string): boolean {
  return key === root || stringStartsWith(key, `${root}/`);
}

export function delegationHolder(options: HolderOptions): DelegationHolder {
  const { store } = options;
  const now = ownValue(options, 'now') ?? dateNow;
  /** What it decided by name, until the view has it. */
  const names = ownNames({
    entry: (key) => store.entry(key),
    // A cell goes with its name, but for bytes still unlogged or open.
    forgot: (key, entry) => {
      const inode = entry ? prov.inode(entry.dev, entry.ino) : undefined;
      if (inode?.cell === undefined || inode.key !== key || dirty.has(inode) || inode.descs > 0) return;
      prov.dropCell(inode);
    },
  });
  /** What it decided by name (OwnNames.decided). */
  const { decided } = names;
  let nextHandle = FIRST_LOCAL_HANDLE;
  /** Files written since their bytes were last logged, in the order last written. */
  const dirty = new SafeSet<Inode>();

  // Changes logged, numbered; and the last a completed send covered: a send covers only what was logged when it began.
  let changes = 0;
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
    if (ownValue(options, 'cannotWait')?.() === true && client.held(key) === undefined) return undefined;
    const grant = client.holder(key);
    return grant === undefined || (provisionalActive && prov.touches(key)) ? undefined : grant;
  };
  /** Whether the process sees anything of its provisional decisions (ProvisionalHost.active). */
  let provisionalActive = false;

  /**
   * No grant decides `inode` from now on (its grant is shared, recalled or
   * gone, or the process is about to change a name or an access above it):
   * what it decided was logged; each open description of it is opened at
   * the session, in the log's order, with the access it was opened with,
   * its file's anchor (Provisional.unhold); its bytes are its content here.
   * `made`: the file is not made at the session yet, and its mode refuses
   * what its descriptions do (creat(2) of 0444): its first description's
   * open makes it (create, exclusive, its number), which keeps that access
   * as creat(2) does, and its bytes are written through that description.
   * A file that lost its name stays its descriptions' alone: nothing of it
   * is the session's.
   */
  const unhold = (inode: Inode, made?: number): void => {
    const cell = inode.cell;
    if (cell === undefined || cell.detached !== undefined) return;
    dirty.delete(inode);
    cell.logged = undefined;
    // A made file's cell keeps the mode its open asked, its umask beside it, until a chmod here decides it.
    const mode = cell.umask === undefined ? cell.mode : cell.mode & ~cell.umask;
    const entry = decided.get(inode.key) ?? store.entry(inode.key) ?? {
      type: 'file' as const, dev: store.device, ino: inode.ino, nlink: 1, size: cell.length, atime: now(), mtime: now(), ctime: now(),
      mode: 0o100000 | mode, uid: store.cred.uid, gid: store.cred.gid, revision: 0, target: null,
    };
    // Each that may write: one opened only to read reads the content here, and needs none.
    const opened = prov.descriptorsOf(inode).filter((desc) => desc.description === undefined && desc.write);
    opened.forEach((desc, at) => {
      const description = desc.description = descriptionId();
      // The first makes the file when it is not made yet: the creating open, and the bytes written through it.
      const creating = made !== undefined && at === 0;
      const making = creating ? { create: true as const, exclusive: true as const, ino: made, ...(cell.umask === undefined ? {} : { umask: cell.umask }) } : {};
      const read = desc.read;
      void promiseThen(acknowledged({ type: 'call', call: { call: 'open', path: inode.key, mode: cell.mode, ...making, access: read ? 'readwrite' : 'write', description } }), (answered) => prov.anchored(description, ownValue(answered, 'receipt')?.handle, read), () => {});
      if (creating && cell.length > 0) {
        acknowledged({ type: 'call', call: { call: 'write', path: inode.key, ino: made, description, offset: 0, data: owned(cell.bytes, cell.length) } });
      }
    });
    prov.unhold(inode, { ...entry, dev: inode.dev, ino: inode.ino, mode: (entry.mode & ~0o7777) | mode });
  };

  /** What is decided here, else what the view has, at `inode`'s name while that name leads to the file. */
  const atName = (inode: Inode): ResidentEntry | undefined => {
    const entry = decided.get(inode.key) ?? store.entry(inode.key);
    return entry && entry.ino === inode.ino ? entry : undefined;
  };

  /** `inode`'s decided row, while its name leads to it, at `size` and changed now. */
  const resized = (inode: Inode, size: number): void => {
    const entry = decided.get(inode.key);
    if (!entry || entry.ino !== inode.ino) return;
    // The decided row is the holder's own object: changed where it is, not copied per write.
    const at = now();
    entry.size = size;
    entry.mtime = at;
    entry.ctime = at;
    names.rewritten(inode.key);
  };

  /** Whether `inode`'s mode, as decided here, refuses one of its open descriptions what it was opened to do: only its creating open could have. */
  const refusedByMode = (inode: Inode): boolean => {
    const entry = decided.get(inode.key);
    if (entry === undefined || entry === null || entry.ino !== inode.ino) return false;
    for (const desc of prov.descriptorsOf(inode)) {
      if (!modeAllows(entry, (desc.read ? 4 : 0) | (desc.write ? 2 : 0), store.cred)) return true;
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
    const open = prov.cells().filter((inode) => inode.cell!.detached === undefined && inode.descs > 0
      && (keys === undefined || keys.some((key) => within(inode.key, key))));
    if (open.length === 0) return;
    drain();
    for (let i = 0; i < open.length; i++) { const inode = open[i]; unhold(inode); }
  };

  /**
   * Log each file's latest bytes, in the order last written, under the name
   * it has now: whole, or where the log holds what it was up to an offset,
   * from there (cut to its length first, where it shrank). `except`: one
   * whose bytes go unlogged with it (a file being unlinked). Every decision
   * drains first, before it decides anything: one the client refuses
   * (ENOMEM) decides nothing.
   */
  const drain = (except?: Inode): void => {
    if (dirty.size === 0) return;
    changes++;
    for (const inode of [...dirty]) {
      if (inode === except) continue;
      const file = inode.cell!;
      const from = mathMin(file.changedFrom ?? 0, file.logged ?? 0);
      // A copy: the file's buffer keeps changing as the process writes. A
      // file made here makes its name with this write, with its number.
      const ino = file.made;
      // Its mode refuses its creating open what it writes: made by that open, and written through it.
      if (ino !== undefined && refusedByMode(inode)) {
        dirty.delete(inode);
        file.changedFrom = undefined;
        file.made = undefined;
        unhold(inode, ino);
        continue;
      }
      if (ino === undefined && from > 0) {
        if (file.length < file.logged!) acknowledged({ type: 'call', call: { call: 'ftruncate', path: inode.key, size: file.length } });
        if (file.length > from) acknowledged({ type: 'call', call: { call: 'write', path: inode.key, offset: from, data: bytesCopy(file.bytes, from, file.length) } });
      } else {
        acknowledged({ type: 'call', call: { call: 'writeFile', path: inode.key, mode: file.mode, ...(ino === undefined ? {} : { ino }), ...(file.umask === undefined ? {} : { umask: file.umask }), data: bytesCopy(file.bytes, 0, file.length) } });
      }
      // Unlogged until the log took it: one that refused it (the session
      // ended the process) leaves it for the settle's (logHeld).
      dirty.delete(inode);
      file.changedFrom = undefined;
      file.made = undefined;
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
    for (const inode of prov.cells()) if (within(inode.key, root)) unhold(inode);
    names.released(root);
    prov.answeredHeld(root);
    ownValue(options, 'sent')?.();
  };

  const client = processFsClient({
    session: options.session,
    now,
    ...(ownValue(options, 'timers') === undefined ? {} : { timers: ownValue(options, 'timers') }),
    ...(ownValue(options, 'umask') === undefined ? {} : { umask: ownValue(options, 'umask') }),
    ...(ownValue(options, 'isHomeRoot') === undefined ? {} : { isHomeRoot: ownValue(options, 'isHomeRoot') }),
    ...(ownValue(options, 'grantAfter') === undefined ? {} : { grantAfter: ownValue(options, 'grantAfter') }),
    ...(ownValue(options, 'grantInos') === undefined ? {} : { grantInos: ownValue(options, 'grantInos') }),
    ...(ownValue(options, 'journal') === undefined ? {} : { journal: ownValue(options, 'journal') }),
    ...(ownValue(options, 'logged') === undefined ? {} : { logged: ownValue(options, 'logged') }),
    released: dropDecisions,
    // Closing starts (a recall, an idle or renewing give-back): nothing more
    // is decided under it, and its files' descriptions write through from now
    // on, so the flush that follows covers everything accepted before.
    freezing: (root) => {
      drain();
      for (const inode of prov.cells()) if (within(inode.key, root)) unhold(inode);
    },
    drain,
  });

  /** A file's bytes a grant decides here (its cell). */
  const heldContent = (entry: ResidentEntry): Uint8Array | undefined => {
    const cell = prov.inode(entry.dev, entry.ino)?.cell;
    return cell === undefined ? undefined : bytesCopy(cell.bytes, 0, cell.length);
  };

  const prov: Provisional = provisionalDecisions({
    // The store's, as it knows it when asked (it learns it at its first barrier).
    get device() { return store.device; },
    get cred() { return store.cred; },
    row: (key) => entryOf(key),
    children: (key) => names.children(key, store.children(key)),
    content: (key, revision) => {
      const entry = decided.get(key);
      return (entry ? heldContent(entry) : undefined) ?? ownValue(store, 'content')?.(key, revision);
    },
    reserve: (bytes) => ownValue(store, 'reserve')?.(bytes) ?? true,
    release: (bytes) => ownValue(store, 'release')?.(bytes),
    client,
    drain,
    sent: () => ownValue(options, 'sent')?.(),
    // Reads by name and by number consult them only while the process sees any.
    active: (on) => { provisionalActive = on; },
    held: (key) => client.held(key) !== undefined,
    count: (key) => { client.holder(key); },
    umask: () => ownValue(options, 'umask')?.() ?? 0o022,
    now,
    nextHandle: () => nextHandle--,
    unhold: (inode) => {
      drain();
      unhold(inode);
    },
    generation: (key) => names.generation(key),
    settled: (key, generation) => names.settled(key, generation),
    ...(ownValue(store, 'mounted') === undefined ? {} : { mounted: (key: string) => ownValue(store, 'mounted')!(key) }),
    ...(ownValue(store, 'unreported') === undefined ? {} : { unreported: (key: string) => ownValue(store, 'unreported')!(key) }),
    ...(ownValue(store, 'keep') === undefined ? {} : { keep: (key: string, row: ResidentEntry, bytes: Uint8Array) => ownValue(store, 'keep')!(key, row.revision, bytes) }),
    absorb: (key, file) => {
      const decision = decided.get(key);
      if (!decision || decision.dev !== file.dev || decision.ino !== file.ino) return undefined;
      // In place: the decision it is, not a new one (its generation and what was given back of it stand).
      decision.size = file.size;
      decision.mode = file.mode;
      decision.uid = file.uid;
      decision.gid = file.gid;
      decision.atime = file.atime;
      decision.mtime = file.mtime;
      decision.ctime = file.ctime;
      return decision;
    },
  });

  // The provisional decisions are the newest wherever they are pending: a held subtree decides nothing there (deciding).
  const composedEntry = (key: string): ResidentEntry | null | undefined => {
    const mine = prov.entry(key);
    return mine !== undefined ? mine : names.entry(key);
  };
  /** entryOf, with the provisional decisions' word first: the store asked once, for both. */
  const composedRow = (key: string): ResidentEntry | null | undefined => {
    const row = entryOf(key);
    const mine = prov.entry(key, row);
    return mine !== undefined ? mine : row;
  };
  const composedChildren = (key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined => prov.children(key, names.children(key, base));
  const composedContent = (entry: ResidentEntry): Uint8Array | undefined => prov.content(entry) ?? heldContent(entry);

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
    ownValue(options, 'sent')?.();
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
  const written = (inode: Inode, from = 0): void => {
    const file = inode.cell!;
    if (file.detached) return;
    file.changedFrom = mathMin(file.changedFrom ?? from, from);
    dirty.delete(inode);
    dirty.add(inode);
    lingerTimer ??= setTimeout(() => {
      lingerTimer = null;
      // No caller to answer here: a log that refuses (the session ended the
      // process) keeps the bytes unlogged, for the settle, and the next flush reports it.
      try { drain(); } catch { /* the next flush reports it */ }
    }, LINGER_MS);
  };

  /** `inode` lost its name (it was `entry`): what is written through its open descriptions stays theirs. */
  const detach = (inode: Inode, entry: ResidentEntry): void => {
    const file = inode.cell!;
    file.detached = { ...entry, nlink: 0, size: file.length };
    file.logged = undefined;
    dirty.delete(inode);
  };

  /** Descriptor `handleId` where its file's grant decides it (its cell), else undefined: the provisional decisions' to answer. */
  /** What a descriptor of a grant's file stats: its file at its name, at its cell's size; one whose name went, as it was then. */
  const heldEntry = (handle: Desc & { inode: Inode & { cell: HeldCell } }): ResidentEntry => {
    const file = handle.inode.cell;
    if (file.detached !== undefined) return { ...file.detached, size: file.length };
    const entry = atName(handle.inode);
    if (!entry) throw fsError('EBADF', 'fstat', handle.path);
    return { ...entry, size: file.length };
  };

  const heldDesc = (handleId: number): (Desc & { inode: Inode & { cell: HeldCell } }) | undefined => {
    const desc = prov.descriptor(handleId);
    if (desc === undefined) throw fsError('EBADF', 'fd', stringOf(handleId));
    return desc.inode.cell === undefined ? undefined : desc as Desc & { inode: Inode & { cell: HeldCell } };
  };

  /**
   * Room for `length` bytes of `file`: drawn from the storage its subtree's
   * grant reserved while one holds it. A file whose grant is being given back
   * (renewed, idle) or is gone grows as any write does: the session judges
   * its bytes when they reach it (a refusal then is the flush's error).
   */
  const room = (file: HeldCell, key: string, length: number): boolean => {
    if (length <= typedArrayByteLength(file.bytes)) return true;
    const grant = client.held(key);
    const size = mathMax(length, typedArrayByteLength(file.bytes) * 2, 4096);
    if (grant !== undefined && !client.draw(grant, size - typedArrayByteLength(file.bytes))) return false;
    const next = new Uint8ArrayConstructor(size);
    typedArraySet(next, bytesView(file.bytes, 0, file.length));
    file.bytes = next;
    return true;
  };

  /** What the session refused of what was decided here: the run fails, naming it. */
  const failed = (): void => {
    const failures = client.takeFailures();
    if (failures.length > 0) {
      // Its first refusal's errno is the call's (EACCES, ENOSPC, …), as the session said it.
      throw fsError(failures[0]!.errno, 'fsync', failures[0]!.path, undefined, {
        detail: `the session refused what this process decided: ${arrayJoin(failures.map((failure) => `${failure.op} ${failure.path}: ${failure.message}`), '; ')}`,
      });
    }
  };

  /** An owner or group id a chown keeps (null, or -1 as fchown(2) spells it): null, as chownRefusal takes it. */
  /** `entry` as chmod, chown (the set-id bits chownedMode clears) and utimes leave it, its ctime now. */
  const changedBy = (entry: ResidentEntry, attrs: W7Attrs): ResidentEntry => (
    'mode' in attrs ? { ...entry, mode: (entry.mode & ~0o7777) | (attrs.mode & 0o7777), ctime: now() }
      : 'uid' in attrs ? { ...entry, uid: attrs.uid ?? entry.uid, gid: attrs.gid ?? entry.gid, mode: chownedMode(entry.mode, store.cred), ctime: now() }
        : { ...entry, atime: timeAt(attrs.atime, entry.atime, now()), mtime: timeAt(attrs.mtime, entry.mtime, now()), ctime: now() });

  const holder: DelegationHolder = {
    client,
    provisional: prov,

    // Composed with the provisional decisions while the process sees any (ProvisionalHost.active).
    entry: (key) => (provisionalActive ? composedEntry(key) : names.entry(key)),

    row: (key) => (provisionalActive ? composedRow(key) : entryOf(key)),

    children: (key, base) => (provisionalActive ? composedChildren(key, base) : names.children(key, base)),

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
      const known = target === null ? undefined : prov.inode(target.dev, target.ino);
      // Another's file there, or one this process holds open or changes outside a grant, is the session's to copy over.
      if (target !== null && ((store.cred.uid !== 0 && target.uid !== store.cred.uid) || (known !== undefined && (known.descs > 0 || known.cell === undefined)))) return false;
      const umask = grant.umask;
      const asked = copiedPermissions(source.mode, false);
      // What the open leaves (cp(1)'s mode), and with keepMode its fchmod to the source's: one a confined principal may not grant is the session's.
      const opened = target === null ? asked & ~umask : target.mode & 0o7777;
      const mode = keepMode ? copyfileMode(source.mode, typedArrayByteLength(bytes), store.cred.uid) : opened;
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
        entry = { type: 'file', dev: store.device, ino: made, nlink: 1, size: typedArrayByteLength(bytes), atime: stamp, mtime: stamp, ctime: stamp, mode: 0o100000 | mode, uid, gid, revision: 0, target: null };
      } else {
        if (!modeAllows(target, 2, store.cred)) throw fsError('EACCES', 'copyfile', path);
        entry = { ...target, size: typedArrayByteLength(bytes), mode: (target.mode & ~0o7777) | mode, mtime: now(), ctime: now() };
      }
      // Its Inode: the file's, or one made for it where the budget has room; else the session copies.
      const inode = known ?? prov.inodeFor(to, { ...entry });
      if (inode === undefined) return false;
      // After everything decided before it, the destination's own bytes among them.
      drain();
      // Held here as an emptied file's written bytes are: in its cell (an
      // O_TRUNC open keeps it), what more they take drawn from what the
      // grant reserved (room); else the session copies.
      const file: HeldCell = inode.cell ?? { bytes: new Uint8ArrayConstructor(0), length: 0, mode, made: undefined, umask: undefined, logged: undefined, changedFrom: undefined, detached: undefined };
      if (!room(file, to, typedArrayByteLength(bytes))) {
        if (inode.cell === undefined) prov.dropCell(inode);
        return false;
      }
      typedArraySet(file.bytes, bytes);
      file.length = typedArrayByteLength(bytes);
      file.logged = typedArrayByteLength(bytes);
      file.mode = mode;
      if (target === null) names.note(parentKey(to), nameOf(to), 'file');
      names.decide(to, entry);
      prov.hold(inode, file);
      const description = descriptionId();
      changes++;
      acknowledged({ type: 'call', call: { call: 'open', path: to, mode: asked, access: 'write', ...(made === undefined ? {} : { ino: made, umask }), create: true, truncate: true, ...(keepMode ? { fchmod: mode } : {}), description } });
      acknowledged({ type: 'call', call: { call: 'write', path: to, ...(made === undefined ? {} : { ino: made }), description, offset: 0, data: bytesCopy(bytes) } });
      acknowledged({ type: 'call', call: { call: 'close', path: to, description } });
      return true;
    },

    logHeld: () => {
      client.seal();
      drain();
    },

    content: (entry) => (provisionalActive ? composedContent(entry) : heldContent(entry)),

    owns: (handleId) => prov.owns(handleId),

    open: (key, path, flags, initial = 0) => {
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
      let inode: Inode | undefined;
      if (current === null) {
        const parent = writableParent(key, path, 'open');
        if (parent === undefined) return undefined;
        const ino = client.number(grant);
        if (ino === undefined) return undefined;
        const asked = (flags.mode ?? 0o666) & 0o777;
        const umask = flags.umask ?? grant.umask;
        const { uid, gid } = ownership(parent);
        const stamp = now();
        const entry: ResidentEntry = {
          type: 'file', dev: store.device, ino, nlink: 1, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
          mode: 0o100000 | (asked & ~umask), uid, gid, revision: 0, target: null,
        };
        drain();
        // Its mode was decided under this umask: the session applies the same one, and its number.
        const file: HeldCell = { bytes: new Uint8ArrayConstructor(0), length: 0, mode: asked, made: ino, umask, logged: undefined, changedFrom: undefined, detached: undefined };
        // Room for what it is opened to be written with, before anything is decided (its number unused if not).
        if (initial > 0 && !room(file, key, initial)) return undefined;
        inode = prov.inodeFor(key, { ...entry });
        if (inode === undefined) return undefined;
        prov.hold(inode, file);
        names.decide(key, entry);
        names.note(parentKey(key), nameOf(key), 'file');
        // Made here: the name exists from now on, in the log's order. Logged
        // with its bytes, before the next decision (drain), as one call.
        written(inode);
      } else if (!flags.truncate) {
        // An existing file opened to write, not emptied (O_CREAT without
        // O_TRUNC): its bytes are kept, so only one whose bytes are here is
        // opened here; any other is the session's. Read permission too, when
        // it is opened to read.
        if (!modeAllows(current, flags.read ? 6 : 2, store.cred)) throw fsError('EACCES', 'open', path);
        inode = prov.inode(current.dev, current.ino);
        if (inode?.cell === undefined || inode.key !== key) return undefined;
      } else {
        // An existing file emptied: decided here, its number the session's.
        if (!modeAllows(current, flags.read ? 6 : 2, store.cred)) throw fsError('EACCES', 'open', path);
        inode = prov.inode(current.dev, current.ino);
        // One the provisional decisions change is theirs to empty.
        if (inode !== undefined && inode.cell === undefined && (inode.state !== null || inode.records.length > 0)) return undefined;
        inode ??= prov.inodeFor(key, current);
        if (inode === undefined) return undefined;
        const file: HeldCell = inode.cell ?? { bytes: new Uint8ArrayConstructor(0), length: 0, mode: current.mode & 0o7777, made: undefined, umask: undefined, logged: undefined, changedFrom: undefined, detached: undefined };
        if (initial > 0 && !room(file, key, initial)) {
          if (inode.cell === undefined) prov.dropCell(inode);
          return undefined;
        }
        file.length = 0;
        prov.hold(inode, file);
        names.decide(key, { ...current, size: 0, mtime: now(), ctime: now() });
        written(inode);
      }
      return prov.heldDescriptor(inode, path, !!flags.read, false);
    },

    writeFile: (key, path, bytes, flags) => {
      // Its bytes' room drawn as it is opened: a write that cannot fail it.
      const handle = holder.open(key, path, flags, typedArrayByteLength(bytes));
      if (handle === undefined) return undefined;
      holder.write(handle.id, 0, bytes);
      const held = heldDesc(handle.id);
      const revision = held === undefined ? undefined : heldEntry(held).revision;
      holder.close(handle.id);
      return revision;
    },

    setStatus: (handleId, status) => prov.setStatus(handleId, status),

    read: (handleId, offset, length) => {
      const handle = heldDesc(handleId);
      if (handle === undefined) return prov.read(handleId, offset, length);
      if (!handle.read) throw fsError('EBADF', 'read', handle.path);
      const file = handle.inode.cell;
      const start = mathMin(offset ?? handle.position, file.length);
      const chunk = bytesCopy(file.bytes, start, mathMin(file.length, start + length));
      if (offset === null) handle.position = start + typedArrayByteLength(chunk);
      return chunk;
    },

    write: (handleId, offset, bytes) => {
      const handle = heldDesc(handleId);
      if (handle === undefined) return prov.write(handleId, offset, bytes);
      if (!handle.write) throw fsError('EBADF', 'write', handle.path);
      const inode = handle.inode;
      const file = inode.cell;
      const start = handle.append ? file.length : offset ?? handle.position;
      const end = start + typedArrayByteLength(bytes);
      if (!room(file, inode.key, end)) throw fsError('ENOSPC', 'write', handle.path);
      const from = mathMin(start, file.length);
      if (start > file.length) typedArrayFill(file.bytes, 0, file.length, start);
      typedArraySet(file.bytes, bytes, start);
      file.length = mathMax(file.length, end);
      if (offset === null || handle.append) handle.position = end;
      resized(inode, file.length);
      written(inode, from);
      return typedArrayByteLength(bytes);
    },

    seek: (handleId, offset, whence) => {
      const handle = heldDesc(handleId);
      if (handle === undefined) return prov.seek(handleId, offset, whence);
      const position = (whence === 'set' ? 0 : whence === 'current' ? handle.position : handle.inode.cell.length) + offset;
      if (position < 0) throw fsError('EINVAL', 'lseek', handle.path);
      handle.position = position;
      return position;
    },

    ftruncate: (handleId, size) => {
      const handle = heldDesc(handleId);
      if (handle === undefined) return prov.ftruncate(handleId, size);
      if (!handle.write) throw fsError('EINVAL', 'ftruncate', handle.path);
      const inode = handle.inode;
      const file = inode.cell;
      if (!room(file, inode.key, size)) throw fsError('ENOSPC', 'ftruncate', handle.path);
      const from = mathMin(size, file.length);
      if (size > file.length) typedArrayFill(file.bytes, 0, file.length, size);
      file.length = size;
      resized(inode, size);
      written(inode, from);
    },

    fstat: (handleId) => {
      const handle = heldDesc(handleId);
      return handle === undefined ? prov.fstat(handleId) : heldEntry(handle);
    },

    close: (handleId) => prov.close(handleId),

    keyOf: (handleId) => prov.keyOf(handleId),

    dup: (handleId) => prov.dup(handleId),

    reopen: (handleId, flags) => {
      const handle = heldDesc(handleId);
      if (handle === undefined) return prov.reopen(handleId, flags);
      const inode = handle.inode;
      const file = inode.cell;
      if (flags.append) return undefined;
      const entry = file.detached ?? atName(inode);
      if (!entry) throw fsError('EBADF', 'open', handle.path);
      if (flags.create && flags.exclusive) throw fsError('EEXIST', 'open', handle.path);
      if (!modeAllows(entry, (flags.read ? 4 : 0) | (flags.write || flags.truncate ? 2 : 0), store.cred)) throw fsError('EACCES', 'open', handle.path);
      // Its truncate is made before the descriptor exists: one whose room is not there is the session's.
      if (flags.truncate && !room(file, inode.key, 0)) return undefined;
      const opened = prov.heldDescriptor(inode, handle.path, !!flags.read, false);
      prov.descriptor(opened.id)!.write = !!flags.write;
      if (flags.truncate) {
        file.length = 0;
        resized(inode, 0);
        written(inode, 0);
      }
      return {
        id: opened.id, path: handle.path, position: 0, closed: false,
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
      drain();
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
      const local = prov.inode(current.dev, current.ino);
      drain(local?.cell !== undefined && local.key === key ? local : undefined);
      names.decide(key, null);
      names.note(parentKey(key), nameOf(key), null);
      if (local?.cell !== undefined && local.key === key) {
        const made = local.cell.made;
        // Its bytes go with it: nothing of them is logged, now or through a
        // description still open on it.
        detach(local, current);
        if (local.descs === 0) prov.dropCell(local);
        // Made here and never logged: the session never had the name.
        if (made !== undefined) return true;
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
      // What the names of its files grow by, admitted before anything is done; not made, given back.
      const files = prov.planMove(from, to, path);
      try {
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
          const replaced = prov.inode(target.dev, target.ino);
          if (replaced?.cell !== undefined && replaced.key === to) {
            detach(replaced, target);
            if (replaced.descs === 0) prov.dropCell(replaced);
          }
        }
        // Its files move with it: the name they are reached by, which the view will have.
        files.commit();
      } finally {
        files.cancel();
      }
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
      if ('uid' in attrs && chownRefusal(current, attrs.uid, attrs.gid, store.cred) !== null) return false;
      // A grant a confined principal may not make: the session's to judge.
      if ('mode' in attrs && confinedModeRefusal(current.mode, attrs.mode) !== null) return false;
      if ('mode' in attrs) {
        throughAt([key]);
        if (provisionalActive && prov.touches(key)) return false;
      }
      drain();
      const next = changedBy(current, attrs);
      names.decide(key, next);
      const local = prov.inode(current.dev, current.ino)?.cell;
      if (local !== undefined) {
        local.mode = next.mode & 0o7777;
        local.umask = undefined;
      }
      log({ type: 'setattr', path: key, attrs: 'uid' in attrs ? { uid: next.uid, gid: next.gid } : attrs });
      return true;
    },

    fsetattr: (handleId, change) => {
      const handle = heldDesc(handleId);
      if (handle === undefined) {
        prov.fsetattr(handleId, change);
        return false;
      }
      const inode = handle.inode;
      const file = inode.cell;
      const entry = file.detached ?? atName(inode);
      // Its times as it is decided (timeAt): now, explicit, or as they are.
      const at = now();
      const attrs: W7Attrs = entry && 'atime' in change ? { atime: timeAt(change.atime, entry.atime, at), mtime: timeAt(change.mtime, entry.mtime, at) } : change;
      if (file.detached === undefined) {
        // By its name where its grant decides it; else no grant decides the file from now on: the provisional decisions', through its description.
        if (entry && holder.setattr(inode.key, attrs)) return true;
        drain();
        unhold(inode);
        prov.fsetattr(handleId, change);
        return false;
      }
      // Its name gone, the file is this process's alone: judged and changed
      // here, as the session judges a description, its confinement of the
      // principal too (judged confined once no grant there says).
      const detached = file.detached;
      const confined = client.held(inode.key)?.confined ?? true;
      const refused = 'mode' in attrs ? chmodRefusal(detached, store.cred) ?? (confined ? confinedModeRefusal(detached.mode, attrs.mode) : null)
        : 'uid' in attrs ? chownRefusal(detached, attrs.uid, attrs.gid, store.cred)
        : utimesRefusal(detached, 'atime' in change && explicitTimes(change.atime, change.mtime), store.cred);
      if (refused !== null) throw fsError(refused, 'mode' in attrs ? 'fchmod' : 'uid' in attrs ? 'fchown' : 'futimes', '/' + inode.key);
      file.detached = changedBy(detached, attrs);
      file.mode = file.detached.mode & 0o7777;
      return true;
    },
    undecided: (key) => { names.undecide(key); },
    superseded: (key) => { names.superseded(key); },

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
