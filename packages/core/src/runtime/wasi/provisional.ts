/**
 * What a caller that cannot wait (ResidentFilesystem.synchronous) decides
 * where no subtree the process holds decides it (VFS-9 B stage 3, rev 5):
 * answered now from this process's view, logged as the operations it made,
 * and the session's to refuse.
 *
 * The log is the overlay. Every decision is a record in log order: a name
 * made, removed or moved, or an operation on an inode (write, append,
 * truncate, chmod, chown, utimes). What the process sees of a name or an
 * inode is its admitted baseline with its pending records folded over it
 * (inode-fold.ts). An answered record retires once a barrier begun after
 * its answer lands; a refused one leaves, and what it touched is folded
 * again from the baseline. A rename moves names, never records.
 *
 * One Inode per (dev, ino) this process has opened or changed here: every
 * descriptor's read, write, truncate, stat, seek, attribute change, reopen
 * and close goes through it. Its identity is checked against the row its
 * name leads to: a name that leads elsewhere leaves it what it retains, or
 * ESTALE, never another file's bytes or attributes. A descriptor that may
 * write is opened at the session as it was opened here, by a description of
 * its own, and writes by it.
 *
 * Every call plans what it will log and keep, judges all of it (refusals,
 * the client's synchronous cap on what it logs, the budget for what it
 * keeps), then commits: a refusal, or a call that cannot answer now, leaves
 * nothing. What is admitted is given back by the object that holds it.
 */

import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import type { ResidentEntry } from './resident-filesystem.js';
import { fsError } from '../beneath-walk.js';
import { chmodRefusal, chownRefusal, explicitTimes, modeAllows, utimesRefusal } from '../../vfs/posix-access.js';
import { copiedPermissions, copyfileMode } from '../../vfs/vfs.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import type { ProcessFsAnswer, ProcessFsClient, ProcessFsOp, ProcessFsReceipt } from '../../_shared/process-fs-client.js';
import { applyOp, copyState, foldOps, owned, type InodeOp, type InodeState } from './inode-fold.js';

/** Where a provisional file's own numbers start: past any the session gives. */
const LOCAL_INOS = 2 ** 50;

/** What one record of a name or an inode costs the process's budget, besides the bytes it keeps. */
const RECORD_COST = 160;
/** What an Inode object keeps beside its names, buffers and records. */
const INODE_COST = 320;
/** What a string keeps: two bytes a code unit. */
const stringCost = (text: string): number => text.length * 2;
/** The bytes an operation carries, which its record keeps until it retires. */
const payloadOf = (op: InodeOp): number => ('data' in op ? op.data.byteLength : 0);

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

/** A new open description's id: unguessable, so no other process's call names it. */
const descriptionId = (): string => crypto.randomUUID().replaceAll('-', '');

/** What the provisional decisions read and log through: the holder's. */
export interface ProvisionalHost {
  readonly device: number;
  readonly cred: { uid: number; gid: number; groups: readonly number[] };
  /** The row at `key` this process's provisional decisions aside (a held subtree's included): undefined where the view does not know. */
  row(key: string): ResidentEntry | null | undefined;
  /** The listing of `key`, as `row` sees it. */
  children(key: string): RuntimeVfsDirEntry[] | undefined;
  /** The store's bytes of `key` at `revision`, where it holds them. */
  content(key: string, revision: number): Uint8Array | undefined;
  reserve(bytes: number): boolean;
  release(bytes: number): void;
  readonly client: ProcessFsClient;
  /** Log what a held subtree decided and has not logged yet: what is logged here comes after it. */
  drain(): void;
  /** What was logged here was answered: the view owes the session's version of it (a barrier). */
  sent(): void;
  /** Whether the process sees anything of its provisional decisions now: what reads by name and by number consult them only while it does. */
  active(on: boolean): void;
  /** Whether a held subtree holds `key`: its grant decides there, and its names wait for it. */
  held(key: string): boolean;
  /** Count a change at `key` toward taking a subtree there, as a decided one is: once it is made. */
  count(key: string): void;
  /** The process's live umask. */
  umask(): number;
  now(): number;
  /** The next descriptor id, from the holder's own range. */
  nextHandle(): number;
  /** A grant's file a provisional decision is about to change: no grant decides it from now on (Provisional.unhold, after what it decided is logged). */
  unhold(inode: Inode): void;
}

/**
 * A file's content while a grant decides it (the holder's): its bytes here,
 * each change logged at the next decision, the flush or LINGER_MS, not
 * refused here. What the process's descriptors of the file read and write
 * while it is (Inode.cell).
 */
export interface HeldCell {
  bytes: Uint8Array;
  length: number;
  mode: number;
  /** Made here and not yet logged: its number, which its first logged write carries. */
  made?: number;
  /** The umask its mode was decided under, which its logged writeFile carries. */
  umask?: number;
  /**
   * How many of its bytes the log holds as they are now (a logged decision
   * of it), and the lowest offset written since: a file that only changed
   * past what was logged is logged from there, not whole.
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
}

/** A file this process has open or changed: one per device and number, whatever decides its changes. */
export interface Inode {
  dev: number;
  ino: number;
  type: ResidentEntry['type'];
  /** The name it is reached by here (a rename here moves it). */
  key: string;
  /** The name it is reached by in the view, its retired renames included: where a replay of the pending ones starts it. */
  origin: string;
  /** The name the session last opened it by (an open's answer): where the view will have it, a peer's rename since included. */
  opened?: string;
  /** Merged into another (reconcile): every reference to it is to that one. */
  mergedInto?: Inode;
  /** Its row: the view's as last read while nothing of the process's is pending on it, or what this process made it. */
  row: ResidentEntry;
  /**
   * Its admitted baseline while records are pending on it: the view's row,
   * and its bytes where the view held them (null: not held), as they were
   * when the first was made, advanced over each answered in order.
   */
  base: InodeState | null;
  /** `base` with `records` folded over it: what the process sees. */
  state: InodeState | null;
  records: InodeRecord[];
  /** What `records` keep of the budget (recordCost each), kept as they come and go. */
  recordsCost: number;
  /** No name leads to it any more: its descriptors keep what it holds until the last closes. */
  unnamed: boolean;
  /** Made by this process and not yet numbered by the session (reconcile). */
  local: boolean;
  descs: number;
  /** An open description at the session whose descriptor closed while others of the file stay open, none of them with one: kept until the last closes (at most one), its anchor. */
  retained: string[];
  /** What it holds back of the budget for its pending opens' answers: an Inode another file may need (reconcile). */
  credit: number;
  /** The view's bytes of it at `revision` its descriptors last read: what they read once the view no longer has a name for it. */
  pin?: { readonly revision: number; readonly bytes: Uint8Array };
  /** What it holds of the process's budget: cost(inode), its credit included, and never more but transiently. */
  reserved: number;
  /** While a grant decides it: its content, which every descriptor of it reads and writes. Its bytes are the grant's, not the budget's. */
  cell?: HeldCell;
  /**
   * Its content was decided under a grant now given back (Provisional.unhold):
   * the barriers begun when that grant's decisions were answered, Infinity
   * until they are. Its own content stands until a barrier begun after (retire).
   */
  heldAt?: number;
}

/** One of the process's operations on an inode, kept until the view has its outcome (retire). */
interface InodeRecord {
  /** Log order. */
  readonly id: number;
  /** Its change: a write the client folded into the same entry extends it (extended), as the session answers the entry once. */
  op: InodeOp;
  /** An extended write's bytes and their room, grown by doubling: op.data is the front of it. */
  room?: Uint8Array;
  /** The inode it is of: the one its op reached at the session, once an open's answer says which (reconcile). */
  owner: Inode;
  /** The description it was made through, where one was: what an open's answer moves with it. */
  readonly description?: string;
  answered: boolean;
  /** Barriers begun when it was answered: one begun after retires it. */
  answeredAt: number;
  /** Gone from its inode's records (refused, retired or moved): its answer says nothing more. */
  gone?: true;
}

/** An inode with none: one shared empty list each, frozen, until it has one of its own. */
const NO_RECORDS = Object.freeze([]) as readonly InodeRecord[] as InodeRecord[];
const NO_RETAINED = Object.freeze([]) as readonly string[] as string[];

/** A name made, removed or moved: replayed in log order over the view, it makes the overlay. */
interface NameRecord {
  readonly id: number;
  readonly keys: readonly string[];
  /** What it keeps of the budget until it leaves (refused, retired). */
  readonly cost: number;
  readonly replay: () => void;
  /** It is the view's now: what it moved is where the view has it (Inode.origin). */
  readonly retired?: () => void;
  answered: boolean;
  answeredAt: number;
}

/** A descriptor: of an Inode, with the rights, offset and session description of its open. */
export interface Desc {
  inode: Inode;
  read: boolean;
  write: boolean;
  append: boolean;
  position: number;
  path: string;
  /** Its open description at the session, where it may write: opened there as it was here. */
  description?: string;
  /** For a caller that waits for it: the session's answer to its open, which rejects with the open's refusal. */
  opening?: Promise<unknown>;
  /** Its last content change's record and the client's answer for its entry: a change folded into that entry extends the record. */
  lastRecord: InodeRecord | null;
  lastAnswer: Promise<unknown> | null;
}


export interface Provisional {
  /** What it keeps of the process's budget now, counted afresh from what it holds: what it has taken of it, where its accounting is right. */
  kept(): number;
  /** The Inode of file (dev, ino), where this process has one. */
  inode(dev: number, ino: number): Inode | undefined;
  /** Its Inode, made where none is (`key` the name it is reached by, `row` what it is): undefined where the budget has no room for one. */
  inodeFor(key: string, row: ResidentEntry): Inode | undefined;
  /** A descriptor of `inode` an open decided under its grant made (Inode.cell): no session description, its rights the open's. */
  heldDescriptor(inode: Inode, path: string, read: boolean, append: boolean): RuntimeFileHandle;
  /** The descriptor `handleId`, where it is one of this process's. */
  descriptor(handleId: number): Desc | undefined;
  /** Every descriptor of `inode`, each open once (a dup shares its open). */
  descriptorsOf(inode: Inode): Desc[];
  /** The Inodes a grant decides now (their cells). */
  cells(): Inode[];
  /** `inode`'s cell goes (its name retired, nothing holds it): the Inode with it, but for what else holds it. */
  dropCell(inode: Inode): void;
  /**
   * A rename a grant decided, `from` to `to`: every file reached beneath
   * `from` (a grant's cell, or one these decisions hold, a descriptor's
   * included) is reached at its name beneath `to` from now on, the name the
   * view will have it at too. A cell that no name leads to stays where it is.
   */
  moved(from: string, to: string): void;
  /**
   * No grant decides `inode` any more: its cell's bytes are its content
   * from now on, known (Inode.heldAt: the session's once what was decided is
   * answered and a barrier begun after lands), `entry` what it is; its
   * descriptors read it here and write through their descriptions.
   */
  unhold(inode: Inode, entry: ResidentEntry): void;
  /** What was decided under `root` is answered (its grant given back): its files are the session's after the next barrier. */
  answeredHeld(root: string): void;
  /** Whether file (dev, ino)'s content and size are this process's here (a cell, or its fold), not the view's. */
  pending(dev: number, ino: number): boolean;
  /** The session descriptor of `handleId`'s own description, else its file's anchor. With `read`, only a description opened for reading. */
  sessionOf(handleId: number, access?: 'read'): number | undefined;
  /** Open description `description` was answered: `handle` is the session's descriptor of it. */
  anchored(description: string, handle: number | undefined, read: boolean): void;
  owns(handleId: number): boolean;
  /** Whether a decision of this process's at `key`, or at the directory it is in, is not yet the view's: a held subtree decides nothing there until it is. */
  touches(key: string): boolean;
  /** fcntl(F_SETFL) of a descriptor: O_APPEND is its writes' to keep. */
  setStatus(handleId: number, status: { append?: boolean }): void;
  /** This process's provisional word on `key`: an entry, null (no name), or undefined (none). */
  entry(key: string): ResidentEntry | null | undefined;
  children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
  /** An open of `key` (resolved; `row` what it names, null for nothing): a descriptor, undefined where it is not made here. */
  open(key: string, path: string, flags: RuntimeOpenFlags, row: ResidentEntry | null, awaited?: boolean): RuntimeFileHandle | undefined;
  /** A descriptor whose open the session refused (Desc.opening): gone, nothing of it logged. */
  abandon(handleId: number): void;
  /** A whole file written by name: its open, write and close, judged together. False where it is not made here. */
  writeFile(key: string, path: string, bytes: Uint8Array, row: ResidentEntry | null, umask: number | undefined): boolean;
  /** Undefined where its bytes are the store's and it does not hold them: inodeOf says what to fetch. */
  read(handleId: number, offset: number | null, length: number): Uint8Array | undefined;
  /** Logged as made: it needs none of the file's bytes (what it keeps is folded over them when they are held). */
  write(handleId: number, offset: number | null, bytes: Uint8Array): number;
  ftruncate(handleId: number, size: number): void;
  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
  fstat(handleId: number): ResidentEntry;
  fsetattr(handleId: number, attrs: W7Attrs): void;
  close(handleId: number): void;
  dup(handleId: number): RuntimeFileHandle;
  reopen(handleId: number, flags: RuntimeOpenFlags): RuntimeFileHandle | undefined;
  /** What a descriptor's read needs fetched: the name its file is at and its row; undefined where no name leads to it. */
  inodeOf(handleId: number): { key: string; entry: ResidentEntry } | undefined;
  keyOf(handleId: number): string;
  mkdir(key: string, path: string, mode: number, row: ResidentEntry | null | undefined, umask: number | undefined): boolean;
  unlink(key: string, path: string, row: ResidentEntry | null | undefined): boolean;
  rmdir(key: string, path: string, row: ResidentEntry | null | undefined): boolean;
  symlink(key: string, path: string, target: string, row: ResidentEntry | null | undefined): boolean;
  rename(from: string, to: string, path: string, source: ResidentEntry | null | undefined, target: ResidentEntry | null | undefined): boolean;
  setattr(key: string, path: string, attrs: W7Attrs, row: ResidentEntry | null | undefined): boolean;
  copyFile(to: string, path: string, source: ResidentEntry, bytes: Uint8Array | undefined, target: ResidentEntry | null, keepMode: boolean): boolean;
  /** The bytes of the file `entry` names, where this process's are its content. */
  content(entry: ResidentEntry): Uint8Array | undefined;
  barrierBegun(): number;
  /** A barrier that began as `begun` landed: what was answered before it, outside a held subtree, is the view's now. */
  retire(begun: number): void;
}

export function provisional(host: ProvisionalHost): Provisional {
  /** Every file this process has open or changed, one Inode each, by device and number. */
  const table = new Map<number, Map<number, Inode>>();
  const inodeAtNumber = (dev: number, ino: number): Inode | undefined => table.get(dev)?.get(ino);
  const addInode = (inode: Inode): void => {
    let numbers = table.get(inode.dev);
    if (numbers === undefined) table.set(inode.dev, numbers = new Map());
    numbers.set(inode.ino, inode);
  };
  const removeInode = (inode: Inode): void => {
    const numbers = table.get(inode.dev);
    if (numbers?.get(inode.ino) !== inode) return;
    numbers.delete(inode.ino);
    if (numbers.size === 0) table.delete(inode.dev);
  };
  function* everyInode(): Generator<Inode> {
    for (const numbers of table.values()) yield* numbers.values();
  }
  /** Every descriptor of those files, held and provisional alike. */
  const descs = new Map<number, Desc>();
  /** Each answered session description's descriptor and the read access its open asked for. */
  const sessions = new Map<string, { handle: number; read: boolean }>();
  /** The overlay: the names the pending name records made, removed or moved, and the listings' changes, replayed over the view. */
  const layer = new Map<string, Inode | null>();
  const added = new Map<string, Map<string, RuntimeVfsDirEntry['type']>>();
  const removed = new Map<string, Set<string>>();
  const nameRecords: NameRecord[] = [];
  /** The inodes whose own content or attributes the process sees (a fold): every name the view has them at shows them. */
  const touched = new Set<Inode>();
  let ids = 0;
  let barriers = 0;
  let localIno = LOCAL_INOS;
  let wasActive = false;
  /** Told the host when the process starts or stops seeing anything of its decisions here. */
  const activity = (): void => {
    const on = layer.size > 0 || touched.size > 0;
    if (on === wasActive) return;
    wasActive = on;
    host.active(on);
  };

  /** `bytes` of the budget, before anything is published: ENOSPC where it has no room. */
  const admit = (bytes: number, syscall: string, path: string): void => {
    if (bytes > 0 && !host.reserve(bytes)) throw fsError('ENOSPC', syscall, path);
  };

  /** The row a name leads to now, this process's own first. */
  const rowAt = (key: string): ResidentEntry | null | undefined => {
    const own = provisionalEntry(key);
    return own !== undefined ? own : host.row(key);
  };

  /** An inode as this process sees it. */
  const entryOf = (inode: Inode): ResidentEntry => {
    const s = inode.state;
    const row = inode.row;
    const nlink = inode.unnamed ? 0 : row.nlink;
    return s === null
      ? (nlink === row.nlink ? row : { ...row, nlink })
      : { ...row, size: s.size, mode: s.mode, uid: s.uid, gid: s.gid, atime: s.atime, mtime: s.mtime, ctime: s.ctime, nlink };
  };

  const provisionalEntry = (key: string): ResidentEntry | null | undefined => {
    if (layer.size === 0 && touched.size === 0) return undefined;
    if (layer.has(key)) {
      const inode = layer.get(key)!;
      return inode === null ? null : entryOf(inode);
    }
    // A file whose content this process changed, at any name the view has it at.
    if (touched.size > 0) {
      const row = host.row(key);
      const changed = row ? inodeAtNumber(row.dev, row.ino) : undefined;
      if (changed !== undefined && changed.state !== null && !changed.local && changed.cell === undefined
        && changed.heldAt === undefined && changed.records.length === 0 && ![...layer.values()].includes(changed)) {
        // A retained fold is only the fallback while no name leads to its inode.
        // The view found it again (a peer's rename): its retired content is the view's.
        changed.key = changed.origin = key;
        changed.row = row!;
        changed.base = changed.state = null;
        touched.delete(changed);
        fit(changed);
        activity();
        return undefined;
      }
      if (changed !== undefined && changed.state !== null) return entryOf(changed);
    }
    if (layer.size === 0) return undefined;
    // A directory made here has no names but the ones made in it.
    const dir = parentKey(key);
    const made = layer.get(dir);
    return made && made.local && !added.get(dir)?.has(nameOf(key)) ? null : undefined;
  };

  /** The one Inode of the file `row` (at `key`) names. */
  const inodeAt = (key: string, row: ResidentEntry): Inode => {
    let inode = inodeAtNumber(row.dev, row.ino);
    if (inode === undefined) {
      inode = { dev: row.dev, ino: row.ino, type: row.type, key, origin: key, row, base: null, state: null, records: NO_RECORDS, recordsCost: 0, unnamed: false, local: false, descs: 0, retained: NO_RETAINED, credit: 0, reserved: 0 };
      addInode(inode);
    }
    return inode;
  };

  /**
   * Whether `inode` is still the file at its name: the row there names it
   * (or the view cannot say, and it was). One whose name leads elsewhere is
   * unnamed while it does: it serves what it retains, never another file's.
   */
  const named = (inode: Inode): boolean => {
    let row = rowAt(inode.key);
    if (row === undefined) return !inode.unnamed;
    let found = row !== null && row.dev === inode.dev && row.ino === inode.ino;
    // The name the session opened it by, where the view has it there since (a peer moved it).
    if (!found && inode.opened !== undefined && inode.opened !== inode.key) {
      const there = rowAt(inode.opened);
      if (there && there.dev === inode.dev && there.ino === inode.ino) {
        inode.key = inode.origin = inode.opened;
        row = there;
        found = true;
      }
    }
    inode.unnamed = !found;
    if (found && inode.state === null && !inode.local) inode.row = row!;
    return found;
  };

  /**
   * The view's row and bytes of `inode`, by the name the view has it at
   * (origin), where that name still leads to it: never another file's that
   * a name came to lead to since. Its row refreshed from there.
   */
  const viewed = (inode: Inode): { row: ResidentEntry; bytes: Uint8Array | undefined } | undefined => {
    for (const name of [inode.origin, inode.opened, inode.key]) {
      if (name === undefined) continue;
      const row = host.row(name);
      if (!row || row.dev !== inode.dev || row.ino !== inode.ino) continue;
      const held = inode.type === 'file' ? host.content(name, row.revision) : undefined;
      return { row, bytes: held !== undefined && held.byteLength === row.size ? held : undefined };
    }
    return undefined;
  };

  /** What an inode's records fold over: the view's version of it where the view still has it, else its row as last known, its bytes not held. */
  const baseline = (inode: Inode): InodeState => {
    const seen = inode.local ? undefined : viewed(inode);
    if (seen !== undefined) inode.row = seen.row;
    const row = inode.row;
    const held = seen?.bytes ?? (inode.pin?.revision === row.revision ? inode.pin.bytes : undefined);
    const bytes = held === undefined ? (row.size === 0 ? new Uint8Array(0) : null) : owned(held);
    return { bytes, size: row.size, mode: row.mode, uid: row.uid, gid: row.gid, atime: row.atime, mtime: row.mtime, ctime: row.ctime };
  };

  /** What `inode` keeps of the budget now: itself and its names, its baseline's and fold's buffers, its records and their bytes, its anchors, its credit. */
  const cost = (inode: Inode): number => {
    let total = INODE_COST + stringCost(inode.key) + stringCost(inode.origin) + (inode.opened === undefined ? 0 : stringCost(inode.opened))
      + (inode.row.target === null ? 0 : stringCost(inode.row.target)) + (inode.base?.bytes?.byteLength ?? 0) + (inode.state?.bytes?.byteLength ?? 0)
      + (inode.pin?.bytes.byteLength ?? 0) + inode.credit + inode.recordsCost;
    return total;
  };

  /** What a record keeps of the budget: itself and what its op carries. */
  const recordCost = (record: InodeRecord): number => RECORD_COST + payloadOf(record.op);

  /** `inode`'s records less `leaving` (a set of them), each gone. */
  const dropRecords = (inode: Inode, leaving: ReadonlySet<InodeRecord>): void => {
    if (leaving.size === 0) return;
    inode.records = inode.records.filter((record) => {
      if (!leaving.has(record)) return true;
      record.gone = true;
      inode.recordsCost -= recordCost(record);
      return false;
    });
  };

  /**
   * What `inode` will keep once `ops` more are folded into it, judged before
   * they are and without allocating: its baseline taken first where it has
   * none (the view's bytes of it, where held), its fold's buffer grown as a
   * fold grows it, and their records.
   */
  const projectedCost = (inode: Inode, ops: readonly InodeOp[]): number => {
    if (ops.length === 0) return cost(inode);
    let baseBytes = inode.base === null ? 0 : inode.base.bytes?.byteLength ?? 0;
    let capacity = inode.state?.bytes?.byteLength ?? 0;
    let known = inode.state !== null && inode.state.bytes !== null;
    let size = inode.state?.size ?? inode.row.size;
    if (inode.base === null) {
      // A grant's file: its cell's bytes are what the first record folds over (fold: unhold).
      const seen = inode.local || inode.cell !== undefined ? undefined : viewed(inode);
      const held = inode.cell !== undefined ? inode.cell.bytes.subarray(0, inode.cell.length)
        : seen?.bytes ?? (inode.pin?.revision === (seen?.row.revision ?? inode.row.revision) ? inode.pin.bytes : undefined);
      known = held !== undefined || inode.row.size === 0;
      baseBytes = held?.byteLength ?? 0;
      capacity = baseBytes;
      size = held?.byteLength ?? inode.row.size;
    }
    let total = cost(inode) - (inode.base?.bytes?.byteLength ?? 0) - (inode.state?.bytes?.byteLength ?? 0) + baseBytes;
    for (const op of ops) {
      if (op.kind === 'truncate' && op.size === 0) known = true;
      const end = op.kind === 'write' ? op.offset + op.data.byteLength : op.kind === 'append' ? size + op.data.byteLength : op.kind === 'truncate' ? op.size : size;
      if (known && end > capacity) capacity = Math.max(end, capacity * 2, 4096);
      if (op.kind === 'truncate') size = op.size;
      else if (op.kind === 'write' || op.kind === 'append') size = Math.max(size, end);
      total += RECORD_COST + payloadOf(op);
    }
    return total + (known ? capacity : 0);
  };

  /**
   * `inode`'s charge brought to what it keeps (cost): what it no longer keeps
   * goes back; what it came to keep in an answer or a barrier (a fold again,
   * a baseline filled, a merge) is taken, and where the budget has no room
   * the bytes it cannot keep it does not: its content becomes unknown, the
   * view's to give again. Its records and what they carry were admitted when
   * they were made, so what is left always fits.
   */
  const fit = (inode: Inode): void => {
    let need = cost(inode) - inode.reserved;
    if (need > 0 && !host.reserve(need)) {
      delete inode.pin;
      if (inode.base !== null) inode.base = { ...inode.base, bytes: null };
      if (inode.state !== null) inode.state = foldOps(inode.base ?? { ...inode.state, bytes: null }, inode.records.map((record) => record.op));
      need = cost(inode) - inode.reserved;
      if (need > 0 && !host.reserve(need)) need = 0;
    }
    if (need < 0) host.release(-need);
    inode.reserved += need;
  };

  /** What `ops` on `inode` cost before they are made: admitted (ENOSPC where the budget has no room), its charge raised to it. */
  const admitOps = (inode: Inode, ops: readonly InodeOp[], syscall: string, path: string, credit = 0): void => {
    const need = projectedCost(inode, ops) + credit - inode.reserved;
    admit(need, syscall, path);
    if (need > 0) inode.reserved += need;
  };

  /** Fold `op` into `inode` (its baseline taken first): its record, kept until it retires; `description` the one it was made through. */
  /** `inode` ready for a change here: a grant's no longer (what that logs goes first), and its fold begun. */
  const ready = (inode: Inode): void => {
    // A grant's file changed here is no grant's from now on: one content, the fold.
    if (inode.cell !== undefined) host.unhold(inode);
    if (inode.base === null) {
      inode.base = baseline(inode);
      inode.state = copyState(inode.base);
    }
    touched.add(inode);
    activity();
  };

  const fold = (inode: Inode, op: InodeOp, description?: string): InodeRecord => {
    ready(inode);
    return recorded(inode, op, description);
  };

  /** `op` recorded for `inode` (ready) and folded into its state. */
  const recorded = (inode: Inode, op: InodeOp, description?: string): InodeRecord => {
    const record: InodeRecord = { id: ++ids, op, owner: inode, ...(description === undefined ? {} : { description }), answered: false, answeredAt: 0 };
    if (inode.records === NO_RECORDS) inode.records = [record];
    else inode.records.push(record);
    inode.recordsCost += recordCost(record);
    inode.state = applyOp(inode.state!, op);
    return record;
  };

  /** `inode` has nothing pending, nothing open and no name here: it goes, and what it held goes back. */
  const release = (inode: Inode): void => {
    if (inode.records.length > 0 || inode.descs > 0 || inode.credit > 0 || inode.cell !== undefined) return;
    for (const value of layer.values()) if (value === inode) return;
    // What the process sees of a file it changed stays until the view has it (retire), but where no name leads to it.
    if (inode.state !== null && named(inode)) return;
    touched.delete(inode);
    inode.base = null;
    inode.state = null;
    host.release(inode.reserved);
    inode.reserved = 0;
    removeInode(inode);
    activity();
  };

  /**
   * Log `op` acknowledged, after what a held subtree decided before it, its
   * fate to `settle`: refused only where the session never applied it (an
   * unknown fate counts as answered: only a fresh barrier retires it).
   */
  const logged = (op: ProcessFsOp, settle: (refused: boolean, answer: ProcessFsAnswer | undefined) => void, awaited = false): Promise<unknown> | undefined => {
    host.drain();
    const settled = (refused: boolean, answer: ProcessFsAnswer | undefined): void => {
      settle(refused, answer);
      host.sent();
    };
    if (awaited) {
      // Its caller waits for the session's answer: a refusal is the call's error, not the next sync's.
      const answer = host.client.submit(op);
      void answer.then((answered) => settled(false, answered), () => settled(true, undefined));
      return answer;
    }
    settles(host.client.submit(op, { acknowledged: true }), settle);
    return undefined;
  };

  /** `settle` told an acknowledged entry's answer once it comes: refused, or not. */
  const settles = (answer: Promise<ProcessFsAnswer>, settle: (refused: boolean, answer: ProcessFsAnswer | undefined) => void): void => {
    void answer.then(
      (answered) => { settle(answered.failed?.refused === true, answered); host.sent(); },
      () => { settle(false, undefined); host.sent(); },
    );
  };

  /** The Inode `inode` is now: itself, or the one it merged into (reconcile). */
  const live = (inode: Inode): Inode => {
    let at = inode;
    while (at.mergedInto !== undefined) at = at.mergedInto;
    return at;
  };

  /** `inode`'s fold again from its baseline: what it is with the records it has now. */
  const refold = (inode: Inode): void => {
    if (inode.base === null) return;
    inode.state = foldOps(inode.base, inode.records.map((record) => record.op));
  };

  /**
   * `records` met their op's fate, each on the inode it is of now (its
   * owner, whatever answers moved it since): a refused one leaves and its
   * inode folds again; an answered one is stamped, and stays until the view
   * has its outcome (retire).
   */
  const settleRecords = (records: readonly InodeRecord[], refused: boolean): void => {
    if (!refused) {
      for (const record of records) {
        if (record.gone) continue;
        record.answered = true;
        record.answeredAt = barriers;
      }
      return;
    }
    const refusedOf = new Map<Inode, Set<InodeRecord>>();
    for (const record of records) {
      if (record.gone) continue;
      let mine = refusedOf.get(record.owner);
      if (mine === undefined) refusedOf.set(record.owner, mine = new Set());
      mine.add(record);
    }
    for (const [inode, mine] of refusedOf) {
      dropRecords(inode, mine);
      refold(inode);
      fit(inode);
      release(inode);
    }
  };

  /** What a name record keeps: itself and its names, and a link's target. */
  const nameCost = (keys: readonly string[], target = ''): number => RECORD_COST + keys.reduce((sum, key) => sum + stringCost(key), 0) + stringCost(target);

  /** Log the op that made `records`, their fate its. */
  const loggedOn = (records: readonly InodeRecord[], op: ProcessFsOp): void => {
    logged(op, (refused) => settleRecords(records, refused));
  };

  /**
   * `record`, a write or append whose entry `op` was folded into by the client,
   * extended by it: its bytes after the record's, at the op's time. False where
   * `op` does not continue it (the client folds only what does).
   */
  const extended = (record: InodeRecord, op: InodeOp): boolean => {
    const was = record.op;
    if (!('data' in was) || !('data' in op)) return false;
    if (op.kind === 'append' ? was.kind !== 'append' : was.kind !== 'write' || op.offset !== was.offset + was.data.byteLength) return false;
    const before = was.data.byteLength;
    const length = before + op.data.byteLength;
    let room = record.room;
    if (room === undefined || room.byteLength < length) {
      const grown = new Uint8Array(Math.max(length, before * 2));
      grown.set(was.data);
      record.room = room = grown;
    }
    room.set(op.data, before);
    record.op = { ...was, data: room.subarray(0, length), at: op.at };
    record.owner.recordsCost += op.data.byteLength;
    return true;
  };

  /** The overlay rebuilt: every name record still pending replayed over the view, in log order. */
  const replay = (): void => {
    for (const inode of everyInode()) inode.key = inode.origin;
    layer.clear();
    added.clear();
    removed.clear();
    for (const record of nameRecords) record.replay();
    touched.clear();
    for (const inode of everyInode()) if (inode.state !== null) touched.add(inode);
    activity();
  };

  /**
   * Log a name record: replayed now, stamped by its answer, replayed away by
   * its refusal (`settled` told its fate too), and counted toward taking a
   * subtree at its names, as a change decided there is.
   */
  const loggedName = (op: ProcessFsOp, keys: readonly string[], cost: number, apply: () => void, settled?: (refused: boolean, answer: ProcessFsAnswer | undefined) => void, retired?: () => void, awaited = false): Promise<unknown> | undefined => {
    const record: NameRecord = { id: ++ids, keys, cost, replay: apply, ...(retired === undefined ? {} : { retired }), answered: false, answeredAt: 0 };
    nameRecords.push(record);
    apply();
    for (const key of keys) host.count(key);
    return logged(op, (refused, answer) => {
      if (refused) {
        const at = nameRecords.indexOf(record);
        if (at >= 0) nameRecords.splice(at, 1);
        host.release(record.cost);
        replay();
        // What only it kept goes: a file, directory or link it made that nothing else holds now.
        for (const inode of [...everyInode()]) if (inode.local) release(inode);
      } else {
        record.answered = true;
        record.answeredAt = barriers;
      }
      settled?.(refused, answer);
    }, awaited);
  };

  const note = (dir: string, name: string, type: RuntimeVfsDirEntry['type'] | null): void => {
    if (type === null) {
      added.get(dir)?.delete(name);
      let gone = removed.get(dir);
      if (gone === undefined) removed.set(dir, gone = new Set());
      gone.add(name);
    } else {
      removed.get(dir)?.delete(name);
      let made = added.get(dir);
      if (made === undefined) added.set(dir, made = new Map());
      made.set(name, type);
    }
  };

  /** `key` names `inode` from now on (null: nothing). */
  const place = (key: string, placed: Inode | null): void => {
    const inode = placed === null ? null : live(placed);
    layer.set(key, inode);
    note(parentKey(key), nameOf(key), inode === null ? null : inode.type);
    if (inode !== null) {
      touched.delete(inode);
      inode.key = key;
      inode.unnamed = false;
      if (inode.state !== null) touched.add(inode);
    }
    activity();
  };

  /** The parent of `key`, when the process may make a name in it: a known, writable, searchable directory of the session's filesystem. */
  const writableParent = (key: string, path: string, syscall: string): ResidentEntry | undefined => {
    const parent = rowAt(parentKey(key));
    if (parent === undefined || parent === null || parent.dev !== host.device) return undefined;
    if (parent.type !== 'directory') throw fsError('ENOTDIR', syscall, path);
    if (!modeAllows(parent, 3, host.cred)) throw fsError('EACCES', syscall, path);
    return parent;
  };

  const ownership = (parent: ResidentEntry): { uid: number; gid: number; setgid: boolean } => {
    const setgid = (parent.mode & 0o2000) !== 0;
    return { uid: host.cred.uid, gid: setgid ? parent.gid : host.cred.gid, setgid };
  };

  /** A file, directory or link made here: numbered by this process until its creating open's answer numbers it (reconcile). */
  const made = (key: string, type: ResidentEntry['type'], mode: number, parent: ResidentEntry, target: string | null = null): Inode => {
    const { uid, gid } = ownership(parent);
    const at = host.now();
    const row: ResidentEntry = {
      type, dev: host.device, ino: localIno++, nlink: type === 'directory' ? 2 : 1, size: target === null ? 0 : new TextEncoder().encode(target).byteLength,
      atime: at, mtime: at, ctime: at, mode, uid, gid, revision: 0, target,
    };
    const inode: Inode = { dev: row.dev, ino: row.ino, type, key, origin: key, row, base: null, state: null, records: NO_RECORDS, recordsCost: 0, unnamed: false, local: true, descs: 0, retained: NO_RETAINED, credit: 0, reserved: 0 };
    if (type === 'file') {
      inode.base = { bytes: new Uint8Array(0), size: 0, mode, uid, gid, atime: at, mtime: at, ctime: at };
      inode.state = copyState(inode.base);
      touched.add(inode);
      activity();
    }
    addInode(inode);
    // Admitted by its maker (madeCost): what it keeps from now on.
    inode.reserved = cost(inode);
    return inode;
  };

  /** What a file, directory or link made at `key` keeps (made): admitted before it is. */
  const madeCost = (key: string, target = ''): number => INODE_COST + 2 * stringCost(key) + stringCost(target);

  /**
   * The bytes the view holds of `inode`, kept for its descriptors once its
   * name goes (an unlink, a rename over it): admitted with what removes it
   * (`more`, its record), then taken.
   */
  const keepForDescriptors = (inode: Inode | undefined, more: number, syscall: string, path: string): void => {
    if (inode === undefined || inode.descs === 0 || inode.base !== null) {
      admit(more, syscall, path);
      return;
    }
    const held = viewed(inode)?.bytes?.byteLength ?? 0;
    admit(more + 2 * held, syscall, path);
    inode.reserved += 2 * held;
    inode.base = baseline(inode);
    inode.state = copyState(inode.base);
    touched.add(inode);
    fit(inode);
  };

  /** `records` are `target`'s from now on, in log order among its own; their old inodes fold again without them. */
  const moveRecords = (records: readonly InodeRecord[], target: Inode): void => {
    if (records.length === 0) return;
    const left = new Set<Inode>();
    const leaving = new Map<Inode, Set<InodeRecord>>();
    for (const record of records) {
      const from = record.owner;
      if (!record.gone) {
        let mine = leaving.get(from);
        if (mine === undefined) leaving.set(from, mine = new Set());
        mine.add(record);
      }
      if (from !== target) left.add(from);
      record.owner = target;
      // What it keeps of the budget goes with it.
      const kept = recordCost(record);
      from.reserved -= kept;
      target.reserved += kept;
    }
    for (const [from, mine] of leaving) dropRecords(from, mine);
    for (const record of records) delete record.gone;
    target.records = [...target.records, ...records].sort((a, b) => a.id - b.id);
    for (const record of records) target.recordsCost += recordCost(record);
    if (target.base === null) {
      target.base = baseline(target);
      touched.add(target);
    }
    refold(target);
    fit(target);
    for (const inode of left) {
      refold(inode);
      fit(inode);
      release(inode);
    }
    activity();
  };

  /** The session's file an open's answer named that this process has no Inode for, as its receipt has it; reached by `like`'s name, which the view has as another's. */
  const adopted = (receipt: ProcessFsReceipt, like: Inode): Inode => {
    const row: ResidentEntry = {
      type: 'file', dev: receipt.dev, ino: receipt.ino, nlink: 1, size: receipt.size,
      atime: receipt.mtimeMs, mtime: receipt.mtimeMs, ctime: receipt.ctimeMs, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid,
      revision: receipt.revision ?? 0, target: null,
    };
    const inode: Inode = { dev: row.dev, ino: row.ino, type: 'file', key: like.key, origin: like.origin, row, base: null, state: null, records: NO_RECORDS, recordsCost: 0, unnamed: true, local: false, descs: 0, retained: NO_RETAINED, credit: 0, reserved: 0 };
    addInode(inode);
    return inode;
  };

  /**
   * An open's answer names the file the session opened (its receipt): what
   * was made through its `description`, and its descriptors, are that
   * file's. A file this process made is the session's numbered one from
   * now on: rekeyed, its baseline the receipt's (the session may have had
   * the name already), or merged into the Inode this process has for it,
   * its records spliced in log order. A file it knew that the session's
   * name no longer led to gives up to the one the session opened only what
   * was made through this description.
   */
  const reconcile = (inode: Inode, key: string, description: string, answer: ProcessFsAnswer | undefined, creating: boolean): void => {
    const receipt = answer?.receipt;
    if (receipt === undefined) return;
    if (!inode.local && inode.dev === receipt.dev && inode.ino === receipt.ino) {
      inode.opened = key;
      return;
    }
    const known = inodeAtNumber(receipt.dev, receipt.ino);
    if (creating && inode.local) {
      removeInode(inode);
      inode.local = false;
      if (known === undefined) {
        inode.opened = key;
        inode.dev = receipt.dev;
        inode.ino = receipt.ino;
        inode.row = { ...inode.row, dev: receipt.dev, ino: receipt.ino, size: receipt.size, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid };
        addInode(inode);
        // The receipt is the file as the open left it: what this process made of it folds over that.
        inode.base = { bytes: receipt.size === 0 ? new Uint8Array(0) : null, size: receipt.size, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid, atime: receipt.mtimeMs, mtime: receipt.mtimeMs, ctime: receipt.ctimeMs };
        refold(inode);
        fit(inode);
        return;
      }
      inode.mergedInto = known;
      known.opened = key;
      for (const desc of descs.values()) if (desc.inode === inode) desc.inode = known;
      known.descs += inode.descs;
      inode.descs = 0;
      if (inode.retained.length > 0) {
        known.retained = [...known.retained, ...inode.retained];
        inode.retained = NO_RETAINED;
      }
      for (const [key, value] of layer) if (value === inode) layer.set(key, known);
      touched.delete(inode);
      // Its records and what they keep go with them; the rest of its charge, at once, to the file it is.
      moveRecords([...inode.records], known);
      known.reserved += inode.reserved;
      inode.reserved = 0;
      fit(known);
      return;
    }
    let target = known;
    if (target === undefined) {
      // Paid from what its open set aside for this (credit): the file as its receipt has it, its bytes known where it is empty.
      target = adopted(receipt, inode);
      target.opened = key;
      target.base = { bytes: receipt.size === 0 ? new Uint8Array(0) : null, size: receipt.size, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid, atime: receipt.mtimeMs, mtime: receipt.mtimeMs, ctime: receipt.ctimeMs };
      target.state = copyState(target.base);
      touched.add(target);
      target.reserved = cost(target);
      inode.reserved -= target.reserved;
    }
    target.opened = key;
    moveRecords(inode.records.filter((record) => record.description === description), target);
    const kept = inode.retained.indexOf(description);
    if (kept >= 0) {
      inode.retained.splice(kept, 1);
      target.retained = [...target.retained, description];
    }
    for (const desc of descs.values()) {
      if (desc.description !== description || desc.inode !== inode) continue;
      inode.descs--;
      desc.inode = target;
      target.descs++;
    }
    fit(target);
    fit(inode);
    release(inode);
  };

  /** What an open sets aside of the budget for its answer (reconcile): an Inode for the file the session opened, and the name it opened it by. */
  const openCredit = (inode: Inode, key: string): number => INODE_COST + stringCost(inode.key) + stringCost(inode.origin) + 2 * stringCost(key);

  /**
   * An open's answer, `credit` its open set aside: reconciled (reconcile),
   * then what was made through it settled, then what the answer did not
   * need of the credit given back.
   */
  const openAnswered = (inode: Inode, key: string, description: string, credit: number, records: readonly InodeRecord[], creating: boolean, read: boolean) => (refused: boolean, answer: ProcessFsAnswer | undefined): void => {
    const owner = live(inode);
    owner.credit -= credit;
    // The session's descriptor of the description: what reads its file once no name leads to it (sessionOf).
    if (!refused && answer?.receipt?.handle !== undefined) sessions.set(description, { handle: answer.receipt.handle, read });
    if (!refused) reconcile(owner, key, description, answer, creating);
    settleRecords(records, refused);
    fit(live(inode));
    release(live(inode));
  };

  /** A new descriptor of `inode` with its own rights; `description` its open at the session where it may write. */
  const descriptor = (inode: Inode, path: string, flags: RuntimeOpenFlags, description: string | undefined): RuntimeFileHandle => {
    const id = host.nextHandle();
    const write = flags.write === true || flags.append === true;
    descs.set(id, { inode, read: flags.read === true || !write, write, append: flags.append === true, position: 0, path, ...(description === undefined ? {} : { description }), lastRecord: null, lastAnswer: null });
    inode.descs++;
    return { id, path } as RuntimeFileHandle;
  };

  const descOf = (handleId: number): Desc => {
    const desc = descs.get(handleId);
    if (desc === undefined) throw fsError('EBADF', 'fd', String(handleId));
    return desc;
  };

  /** An inode's bytes now: its fold's, else the view's while its name leads to it. Undefined where none are held here; ESTALE where no name leads to it and it retains none. */
  const bytesOf = (inode: Inode, syscall: string, path: string): { bytes: Uint8Array; size: number } | undefined => {
    if (inode.state !== null) {
      if (inode.state.bytes === null) {
        // Its baseline's bytes not held when it took its first record: held now at that revision, the records fold over them.
        const seen = viewed(inode);
        if (seen?.bytes === undefined || seen.row.revision !== inode.row.revision) return undefined;
        inode.base = { ...inode.base!, bytes: owned(seen.bytes) };
        refold(inode);
        // Kept only where the budget has room (fit): else unknown again, and the read waits for the session.
        fit(inode);
        if (inode.state.bytes === null) return undefined;
      }
      return { bytes: inode.state.bytes!, size: inode.state.size };
    }
    const seen = viewed(inode);
    if (seen === undefined) {
      // No name the view has leads to it: what its descriptors last read of it, else ESTALE.
      if (named(inode) || inode.pin === undefined) {
        if (!named(inode)) throw fsError('ESTALE', syscall, path);
        return undefined;
      }
      return { bytes: inode.pin.bytes, size: inode.pin.bytes.byteLength };
    }
    inode.row = seen.row;
    // The view's name for it has no bytes yet (moved there by a rename): what its descriptors read of it at that revision.
    if (seen.bytes === undefined) return inode.pin?.revision === seen.row.revision ? { bytes: inode.pin.bytes, size: inode.pin.bytes.byteLength } : undefined;
    // Pinned for its descriptors while the view's name for it may move or go.
    if (inode.descs > 0 && inode.pin?.revision !== seen.row.revision) {
      inode.pin = { revision: seen.row.revision, bytes: seen.bytes };
      fit(inode);
    }
    return { bytes: seen.bytes, size: seen.bytes.byteLength };
  };

  /** An open description of `inode` at the session, any of its descriptors': what reaches it whatever names it (its anchor). */
  const anchorOf = (inode: Inode, read = false): string | undefined => {
    if (inode.descs === 0) return undefined;
    for (const description of inode.retained) if (!read || sessions.get(description)?.read === true) return description;
    for (const desc of descs.values()) if (desc.inode === inode && desc.description !== undefined && (!read || sessions.get(desc.description)?.read === true)) return desc.description;
    return undefined;
  };

  /** What a descriptor's call names its file by: its description, else its number. */
  const by = (desc: Desc): { description: string } | { ino: number } => (desc.description !== undefined ? { description: desc.description } : { ino: desc.inode.ino });

  /**
   * A content operation by a descriptor, judged then made: its file still
   * its own (or retained), its logged bytes under the client's cap, what it
   * keeps admitted; then folded and logged as it was made.
   */
  const contentOp = (desc: Desc, op: InodeOp, call: ProcessFsOp, logs: number, syscall: string): void => {
    const inode = desc.inode;
    // Through its description the session reaches its file wherever, or whether, a name leads to it; by number only while one does.
    if (desc.description === undefined && inode.state === null && !named(inode)) throw fsError('ESTALE', syscall, desc.path);
    host.drain();
    host.client.fitsSync(logs, desc.path);
    admitOps(inode, [op], syscall, desc.path);
    ready(inode);
    host.drain();
    // One record per entry the client keeps, as the session answers each entry once: a change it folds into the entry of this description's last extends that record.
    const answer = host.client.submit(call, { acknowledged: true });
    const last = desc.lastRecord;
    if (answer === desc.lastAnswer && last !== null && !last.answered && last.gone !== true && last.owner === inode && extended(last, op)) {
      inode.state = applyOp(inode.state!, op);
    } else {
      const record = recorded(inode, op, desc.description);
      desc.lastRecord = record;
      desc.lastAnswer = answer;
      settles(answer, (refused) => settleRecords([record], refused));
    }
    fit(inode);
  };

  const judgeAttrs = (row: ResidentEntry, attrs: W7Attrs, syscall: string, path: string): void => {
    const refused = 'mode' in attrs ? chmodRefusal(row, host.cred)
      : 'uid' in attrs ? chownRefusal(row, attrs.uid, attrs.gid, host.cred)
      : utimesRefusal(row, explicitTimes(attrs.atime, attrs.mtime), host.cred);
    if (refused !== null) throw fsError(refused, syscall, path);
  };

  const attrOp = (attrs: W7Attrs, at: number): InodeOp => ('mode' in attrs ? { kind: 'chmod', mode: attrs.mode, at }
    : 'uid' in attrs ? { kind: 'chown', uid: attrs.uid, gid: attrs.gid, by: host.cred.uid, at }
    : { kind: 'utimes', atime: attrs.atime, mtime: attrs.mtime, at });

  /**
   * A file opened to write here, planned and judged whole: made (O_CREAT on
   * nothing) or emptied (O_TRUNC), its open logged as it was made with a
   * description of its own, then `bytes` written by it and, with `close`,
   * closed. `chmod`: the mode its open sets (a copy's keepMode).
   */
  const openToWrite = (key: string, path: string, flags: RuntimeOpenFlags, row: ResidentEntry | null, given: Uint8Array | null, close: boolean, chmod?: number, awaited = false): RuntimeFileHandle | undefined => {
    // Its own bytes: what it logs and what it folds, whatever the caller does with its buffer after.
    const bytes = given === null ? null : owned(given);
    const read = flags.read === true;
    const umask = flags.umask ?? host.umask();
    const asked = (flags.mode ?? 0o666) & 0o777;
    // Judged whole first.
    let parent: ResidentEntry | undefined;
    if (row === null) {
      if (!flags.create) throw fsError('ENOENT', 'open', path);
      // Set-id and sticky bits asked at creation are the session's to grant or strip.
      if (((flags.mode ?? 0o666) & 0o7000) !== 0) return undefined;
      parent = writableParent(key, path, 'open');
      if (parent === undefined) return undefined;
    } else {
      if (row.type === 'directory') throw fsError('EISDIR', 'open', path);
      if (row.type !== 'file') return undefined;
      if (flags.create && flags.exclusive) throw fsError('EEXIST', 'open', path);
      if (!modeAllows(row, (read ? 4 : 0) | 2, host.cred)) throw fsError('EACCES', 'open', path);
    }
    const at = host.now();
    const ops: InodeOp[] = [];
    // A made file's O_TRUNC changes nothing here, but is the session's if the name turns out to be another's file (reconcile).
    if (flags.truncate) ops.push({ kind: 'truncate', size: 0, at });
    if (bytes !== null && bytes.byteLength > 0) ops.push({ kind: 'write', offset: 0, data: bytes, at });
    if (chmod !== undefined) ops.push({ kind: 'chmod', mode: chmod, at });
    // What older decisions left unlogged goes first, and with what this logs, must fit what the log holds unanswered.
    host.drain();
    host.client.fitsSync(bytes?.byteLength ?? 0, path);
    const inode = row === null ? null : inodeAt(key, row);
    let credit: number;
    if (inode !== null) {
      credit = openCredit(inode, key);
      try {
        admitOps(inode, ops, 'open', path, credit);
      } catch (error) {
        release(inode);
        throw error;
      }
    } else {
      credit = INODE_COST + 4 * stringCost(key);
      const written = bytes !== null && bytes.byteLength > 0 ? Math.max(bytes.byteLength, 4096) : 0;
      admit(madeCost(key) + nameCost([key]) + credit + written + ops.reduce((sum, op) => sum + RECORD_COST + payloadOf(op), 0), 'open', path);
    }
    // Made.
    const description = descriptionId();
    // The open as the caller asked it: the session's name may lead elsewhere by the time it lands, and its open is the one that decides.
    const open: ProcessFsOp = {
      type: 'call', call: {
        call: 'open', path: key, mode: flags.create ? asked : row!.mode & 0o7777,
        ...(flags.create ? { umask, create: true as const } : {}),
        ...(flags.exclusive && row === null ? { exclusive: true as const } : {}),
        ...(flags.truncate ? { truncate: true as const } : {}),
        ...(flags.followSymlinks === false ? { nofollow: true as const } : {}),
        access: read ? 'readwrite' : 'write',
        ...(chmod === undefined ? {} : { fchmod: chmod }),
        description,
      },
    };
    let target: Inode;
    if (row === null) {
      target = made(key, 'file', 0o100000 | (asked & ~umask), parent!);
      // Admitted above with it: its records, its fold's buffer, and its open's credit.
      target.reserved += credit + (bytes !== null && bytes.byteLength > 0 ? Math.max(bytes.byteLength, 4096) : 0) + ops.reduce((sum, op) => sum + RECORD_COST + payloadOf(op), 0);
    } else {
      target = inode!;
    }
    target.credit += credit;
    // The open's own effects (its truncate, its fchmod) are its records; its writes are theirs.
    const opened = ops.filter((op) => op.kind !== 'write').map((op) => fold(target, op, description));
    // Its answer says which file the session opened first: what was made through it is that file's before any is settled.
    const answered = openAnswered(target, key, description, credit, opened, row === null, read);
    let opening: Promise<unknown> | undefined;
    if (row === null) {
      opening = loggedName(open, [key], nameCost([key]), () => place(key, target), answered, undefined, awaited);
    } else {
      host.count(key);
      opening = logged(open, answered, awaited);
    }
    for (const op of ops) {
      if (op.kind !== 'write') continue;
      loggedOn([fold(target, op, description)], { type: 'call', call: { call: 'write', path: key, description, offset: op.offset, data: op.data } });
    }
    fit(target);
    const handle = descriptor(target, path, { ...flags, write: true }, description);
    descOf(handle.id).write = flags.write === true || flags.append === true || bytes !== null;
    if (opening !== undefined) descOf(handle.id).opening = opening;
    if (close) provisional.close(handle.id);
    return handle;
  };

  const provisional: Provisional = {
    inode: inodeAtNumber,

    inodeFor: (key, row) => {
      const known = inodeAtNumber(row.dev, row.ino);
      if (known !== undefined) return known;
      const inode = inodeAt(key, row);
      const need = cost(inode);
      if (!host.reserve(need)) {
        removeInode(inode);
        return undefined;
      }
      inode.reserved = need;
      return inode;
    },

    heldDescriptor: (inode, path, read, append) => {
      const id = host.nextHandle();
      descs.set(id, { inode, read, write: true, append, position: 0, path, lastRecord: null, lastAnswer: null });
      inode.descs++;
      return { id, path } as RuntimeFileHandle;
    },

    descriptor: (handleId) => descs.get(handleId),

    descriptorsOf: (inode) => {
      if (inode.descs === 0) return [];
      return [...new Set(descs.values())].filter((desc) => desc.inode === inode);
    },

    cells: () => [...everyInode()].filter((inode) => inode.cell !== undefined),

    dropCell: (inode) => {
      delete inode.cell;
      fit(inode);
      release(inode);
    },

    moved: (from, to) => {
      for (const inode of everyInode()) {
        if (inode.cell?.detached !== undefined || !within(inode.key, from)) continue;
        inode.key = inode.origin = to + inode.key.slice(from.length);
        fit(inode);
      }
    },

    unhold: (inode, entry) => {
      const cell = inode.cell;
      if (cell === undefined) return;
      delete inode.cell;
      inode.row = { ...entry, size: cell.length };
      // The cell's buffer is the baseline's own: no one else holds it now.
      inode.base = { bytes: cell.bytes.subarray(0, cell.length), size: cell.length, mode: entry.mode, uid: entry.uid, gid: entry.gid, atime: entry.atime, mtime: entry.mtime, ctime: entry.ctime };
      inode.state = copyState(inode.base);
      inode.heldAt = Infinity;
      touched.add(inode);
      // Its bytes are the budget's from now on: kept where it has room, else unknown here (the session reads them).
      fit(inode);
      activity();
    },

    answeredHeld: (root) => {
      for (const inode of everyInode()) if (inode.heldAt === Infinity && (within(inode.key, root) || within(inode.origin, root))) inode.heldAt = barriers;
    },

    pending: (dev, ino) => {
      const inode = inodeAtNumber(dev, ino);
      return inode !== undefined && (inode.cell !== undefined || inode.state !== null);
    },

    sessionOf: (handleId, access) => {
      const desc = descs.get(handleId);
      if (desc === undefined) return undefined;
      const own = desc.description;
      const description = own !== undefined && (access !== 'read' || sessions.get(own)?.read === true) ? own : anchorOf(desc.inode, access === 'read');
      return description === undefined ? undefined : sessions.get(description)?.handle;
    },

    anchored: (description, handle, read) => {
      if (handle !== undefined) sessions.set(description, { handle, read });
    },

    kept: () => {
      let total = 0;
      for (const inode of everyInode()) total += cost(inode);
      for (const record of nameRecords) total += record.cost;
      return total;
    },
    owns: (handleId) => descs.size > 0 && descs.has(handleId),

    touches: (key) => {
      if (layer.size === 0 && touched.size === 0) return false;
      if (layer.has(key) || layer.has(parentKey(key))) return true;
      const row = host.row(key);
      return row ? inodeAtNumber(row.dev, row.ino)?.state != null : false;
    },

    setStatus: (handleId, status) => {
      const desc = descOf(handleId);
      if (status.append !== undefined) desc.append = status.append;
    },

    entry: provisionalEntry,

    children: (key, base) => {
      if (layer.size === 0) return base;
      const made = added.get(key);
      const gone = removed.get(key);
      if (made === undefined && gone === undefined) return base;
      const dir = layer.get(key);
      if (base === undefined && !(dir && dir.local)) return undefined;
      const out = new Map<string, RuntimeVfsDirEntry['type']>();
      for (const child of base ?? []) if (!gone?.has(child.name)) out.set(child.name, child.type);
      for (const [name, type] of made ?? []) out.set(name, type);
      return [...out].map(([name, type]) => ({ name, type }));
    },

    open: (key, path, flags, row, awaited = false) => {
      // One refusal order for every open: a name there refuses O_CREAT|O_EXCL whatever it is or is asked for.
      if (row !== null && flags.create && flags.exclusive) throw fsError('EEXIST', 'open', path);
      const write = flags.write === true || flags.append === true;
      // One that makes or empties its file, or may write it, is opened at the session as here.
      if (write || flags.truncate || (row === null && flags.create)) {
        const handle = openToWrite(key, path, flags, row, null, false, undefined, awaited);
        if (handle !== undefined) descOf(handle.id).write = write;
        return handle;
      }
      if (row === null) throw fsError('ENOENT', 'open', path);
      // Read-only, for a caller that may wait (an O_CREAT of a file there): the session's descriptor, as every read-only open of such a caller is.
      if (awaited) return undefined;
      // Read-only: metadata only, nothing read and nothing logged.
      if (row.type === 'directory' || row.type !== 'file') return undefined;
      if (!modeAllows(row, 4, host.cred)) throw fsError('EACCES', 'open', path);
      const inode = inodeAt(key, row);
      try {
        admitOps(inode, [], 'open', path);
      } catch (error) {
        release(inode);
        throw error;
      }
      return descriptor(inode, path, flags, undefined);
    },

    writeFile: (key, path, bytes, row, umask) => openToWrite(key, path, { write: true, create: true, truncate: true, mode: 0o666, ...(umask === undefined ? {} : { umask }) }, row, bytes, true) !== undefined,

    read: (handleId, offset, length) => {
      const desc = descOf(handleId);
      if (!desc.read) throw fsError('EBADF', 'read', desc.path);
      const held = bytesOf(desc.inode, 'read', desc.path);
      if (held === undefined) return undefined;
      const start = Math.min(offset ?? desc.position, held.size);
      const chunk = owned(held.bytes.subarray(start, Math.min(held.size, start + length)));
      if (offset === null) desc.position = start + chunk.byteLength;
      return chunk;
    },

    write: (handleId, offset, bytes) => {
      const desc = descOf(handleId);
      if (!desc.write) throw fsError('EBADF', 'write', desc.path);
      const at = host.now();
      // One private copy: what is folded and what is logged, whatever the caller does with its buffer after.
      const data = owned(bytes);
      if (desc.append) {
        contentOp(desc, { kind: 'append', data, at }, { type: 'call', call: { call: 'append', path: desc.inode.key, ...by(desc), data } }, data.byteLength, 'write');
        desc.position = desc.inode.state!.size;
      } else {
        const start = offset ?? desc.position;
        contentOp(desc, { kind: 'write', offset: start, data, at }, { type: 'call', call: { call: 'write', path: desc.inode.key, ...by(desc), offset: start, data } }, data.byteLength, 'write');
        if (offset === null) desc.position = start + data.byteLength;
      }
      return bytes.byteLength;
    },

    ftruncate: (handleId, size) => {
      const desc = descOf(handleId);
      if (!desc.write) throw fsError('EINVAL', 'ftruncate', desc.path);
      contentOp(desc, { kind: 'truncate', size, at: host.now() }, { type: 'call', call: { call: 'ftruncate', path: desc.inode.key, ...by(desc), size } }, 0, 'ftruncate');
    },

    seek: (handleId, offset, whence) => {
      const desc = descOf(handleId);
      if (whence === 'end') named(desc.inode);
      const position = (whence === 'set' ? 0 : whence === 'current' ? desc.position : entryOf(desc.inode).size) + offset;
      if (position < 0) throw fsError('EINVAL', 'lseek', desc.path);
      desc.position = position;
      return position;
    },

    fstat: (handleId) => {
      const desc = descOf(handleId);
      named(desc.inode);
      return entryOf(desc.inode);
    },

    fsetattr: (handleId, change) => {
      const desc = descOf(handleId);
      const inode = desc.inode;
      const attrs = change;
      const syscall = 'mode' in attrs ? 'fchmod' : 'uid' in attrs ? 'fchown' : 'futimes';
      // The file it opened: through its description, wherever or whether a name leads to it; without one, by the name that still does.
      const described = desc.description ?? anchorOf(inode);
      if (described === undefined && !named(inode)) throw fsError('ESTALE', syscall, desc.path);
      judgeAttrs(entryOf(inode), attrs, syscall, desc.path);
      const op = attrOp(attrs, host.now());
      host.drain();
      admitOps(inode, [op], syscall, desc.path);
      host.count(inode.key);
      loggedOn([fold(inode, op, described)], { type: 'setattr', path: inode.key, attrs, ...(described === undefined ? {} : { description: described }) });
      fit(inode);
    },

    abandon: (handleId) => {
      delete descOf(handleId).description;
      provisional.close(handleId);
    },

    close: (handleId) => {
      const desc = descOf(handleId);
      descs.delete(handleId);
      for (const other of descs.values()) if (other === desc) return;
      const inode = desc.inode;
      inode.descs--;
      // Its description outlives it while another descriptor of the file stays open with none of its own (the file's anchor); the last closes it.
      if (desc.description !== undefined) {
        if (inode.descs > 0 && inode.retained.length === 0 && anchorOf(inode) === undefined) inode.retained = [desc.description];
        else logged({ type: 'call', call: { call: 'close', path: inode.key, description: desc.description } }, () => {});
      }
      if (inode.descs === 0) {
        const retained = inode.retained;
        inode.retained = NO_RETAINED;
        for (const description of retained) {
          sessions.delete(description);
          logged({ type: 'call', call: { call: 'close', path: inode.key, description } }, () => {});
        }
      }
      if (desc.description !== undefined && !inode.retained.includes(desc.description)) sessions.delete(desc.description);
      // A grant's file that lost its name goes with its last descriptor (POSIX: its last close).
      if (inode.descs === 0 && inode.cell?.detached !== undefined) delete inode.cell;
      release(inode);
    },

    dup: (handleId) => {
      const desc = descOf(handleId);
      const id = host.nextHandle();
      descs.set(id, desc);
      return { id, path: desc.path } as RuntimeFileHandle;
    },

    reopen: (handleId, flags) => {
      const desc = descOf(handleId);
      const inode = desc.inode;
      if (flags.append) return undefined;
      if (flags.create && flags.exclusive) throw fsError('EEXIST', 'open', desc.path);
      if (inode.state === null && !named(inode)) throw fsError('ESTALE', 'open', desc.path);
      const read = flags.read === true;
      const write = flags.write === true;
      if (!modeAllows(entryOf(inode), (read ? 4 : 0) | (write || flags.truncate ? 2 : 0), host.cred)) throw fsError('EACCES', 'open', desc.path);
      // Its truncate, judged and made before the descriptor exists.
      let description: string | undefined;
      if (write || flags.truncate) {
        if (!named(inode)) throw fsError('ESTALE', 'open', desc.path);
        description = descriptionId();
        const open: ProcessFsOp = { type: 'call', call: { call: 'open', path: inode.key, mode: entryOf(inode).mode & 0o7777, ...(flags.truncate ? { truncate: true as const } : {}), access: read ? 'readwrite' : 'write', description } };
        const records = flags.truncate ? [{ kind: 'truncate', size: 0, at: host.now() } as InodeOp] : [];
        host.drain();
        const credit = openCredit(inode, inode.key);
        admitOps(inode, records, 'open', desc.path, credit);
        inode.credit += credit;
        const made = records.map((op) => fold(inode, op, description));
        logged(open, openAnswered(inode, inode.key, description, credit, made, false, read));
        fit(inode);
      }
      const handle = descriptor(inode, desc.path, { ...flags, read }, description);
      descOf(handle.id).write = write;
      return { ...handle, position: 0, closed: false, flags: { read, write, append: false, create: !!flags.create, exclusive: !!flags.exclusive, directory: false, truncate: !!flags.truncate, followSymlinks: true } };
    },

    inodeOf: (handleId) => {
      const desc = descs.get(handleId);
      if (desc === undefined || !named(desc.inode)) return undefined;
      // The view's name and row: the bytes its records fold over.
      return { key: desc.inode.origin, entry: desc.inode.row };
    },

    keyOf: (handleId) => descOf(handleId).inode.key,

    mkdir: (key, path, mode, row, mask) => {
      if (row === undefined || (mode & 0o7000) !== 0) return false;
      if (row !== null) throw fsError('EEXIST', 'mkdir', path);
      const parent = writableParent(key, path, 'mkdir');
      if (parent === undefined) return false;
      const umask = mask ?? host.umask();
      const perm = (mode & 0o777 & ~umask) | (ownership(parent).setgid ? 0o2000 : 0);
      host.drain();
      admit(madeCost(key) + nameCost([key]), 'mkdir', path);
      const inode = made(key, 'directory', 0o40000 | perm, parent);
      loggedName({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, umask } }, [key], nameCost([key]), () => {
        place(key, inode);
        added.set(key, added.get(key) ?? new Map());
      });
      return true;
    },

    unlink: (key, path, row) => {
      if (row === undefined) return false;
      if (row === null) throw fsError('ENOENT', 'unlink', path);
      if (row.type === 'directory') return false;
      if (writableParent(key, path, 'unlink') === undefined) return false;
      // Its descriptors keep what it holds: its bytes, where only the view has them, admitted for their lifetime first.
      host.drain();
      keepForDescriptors(inodeAtNumber(row.dev, row.ino), nameCost([key]), 'unlink', path);
      loggedName({ type: 'call', call: { call: 'unlink', path: key } }, [key], nameCost([key]), () => place(key, null));
      return true;
    },

    rmdir: (key, path, row) => {
      if (row === undefined) return false;
      if (row === null) throw fsError('ENOENT', 'rmdir', path);
      if (row.type !== 'directory') throw fsError('ENOTDIR', 'rmdir', path);
      const listed = provisional.children(key, host.children(key));
      if (listed === undefined) return false;
      if (listed.length > 0) throw fsError('ENOTEMPTY', 'rmdir', path);
      if (writableParent(key, path, 'rmdir') === undefined) return false;
      host.drain();
      admit(nameCost([key]), 'rmdir', path);
      loggedName({ type: 'call', call: { call: 'rmdir', path: key } }, [key], nameCost([key]), () => {
        place(key, null);
        added.delete(key);
        removed.delete(key);
      });
      return true;
    },

    symlink: (key, path, target, row) => {
      if (row === undefined) return false;
      if (row !== null) throw fsError('EEXIST', 'symlink', path);
      const parent = writableParent(key, path, 'symlink');
      if (parent === undefined) return false;
      host.drain();
      admit(madeCost(key, target) + nameCost([key]), 'symlink', path);
      const inode = made(key, 'symlink', 0o120777, parent, target);
      loggedName({ type: 'call', call: { call: 'symlink', path: key, target } }, [key], nameCost([key]), () => place(key, inode));
      return true;
    },

    rename: (from, to, path, source, target) => {
      if (source === undefined || target === undefined) return false;
      if (source === null) throw fsError('ENOENT', 'rename', path);
      if (source.type === 'directory' && (target !== null || within(to, from))) return false;
      if (target !== null && (target.type === 'directory' || source.type === 'directory')) return false;
      if (from === to) return true;
      if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined) return false;
      // A file it replaces keeps, for its descriptors, what it holds: admitted first, with the record and the Inode it moves.
      host.drain();
      const known = layer.get(from) ?? inodeAtNumber(source.dev, source.ino);
      const moves = known === undefined ? INODE_COST + 2 * stringCost(from) + 2 * stringCost(to) : 2 * stringCost(to);
      keepForDescriptors(target === null ? undefined : inodeAtNumber(target.dev, target.ino), nameCost([from, to]) + moves, 'rename', path);
      const moving = known ?? inodeAt(from, source);
      moving.reserved += moves;
      loggedName({ type: 'rename', from, to }, [from, to], nameCost([from, to]), () => {
        // What is beneath the source moves with it: names, never records.
        for (const [key, value] of [...layer]) {
          if (key === from || !within(key, from)) continue;
          layer.delete(key);
          const moved = to + key.slice(from.length);
          layer.set(moved, value);
          if (value !== null) value.key = moved;
        }
        for (const map of [added, removed] as Map<string, unknown>[]) {
          for (const [key, value] of [...map]) if (within(key, from)) { map.delete(key); map.set(to + key.slice(from.length), value); }
        }
        place(from, null);
        place(to, moving);
      }, undefined, () => {
        // The view has it moved: what was beneath the source starts beneath the destination.
        for (const inode of everyInode()) if (within(inode.origin, from)) inode.origin = to + inode.origin.slice(from.length);
      });
      fit(moving);
      return true;
    },

    setattr: (key, path, attrs, row) => {
      if (row === undefined) return false;
      const syscall = 'mode' in attrs ? 'chmod' : 'uid' in attrs ? 'chown' : 'utime';
      if (row === null) throw fsError('ENOENT', syscall, path);
      judgeAttrs(row, attrs, syscall, path);
      host.drain();
      const inode = layer.get(key) ?? inodeAt(key, row);
      const op = attrOp(attrs, host.now());
      try {
        admitOps(inode, [op], syscall, path);
      } catch (error) {
        release(inode);
        throw error;
      }
      host.count(key);
      loggedOn([fold(inode, op)], { type: 'setattr', path: key, attrs });
      fit(inode);
      return true;
    },

    copyFile: (to, path, source, bytes, target, keepMode) => {
      // The source as the session's copy reads it: a file it may read, no set-id bit (the session's to judge).
      if (source.type !== 'file' || (source.mode & 0o7000) !== 0 || !modeAllows(source, 4, host.cred)) return false;
      if (target !== null && target.type !== 'file') return false;
      const own = inodeAtNumber(source.dev, source.ino);
      const held = own === undefined ? undefined : bytesOf(own, 'copyfile', path);
      const data = held !== undefined ? owned(held.bytes, held.size) : bytes;
      if (data === undefined) return false;
      const umask = host.umask();
      const asked = copiedPermissions(source.mode, false);
      const opened = target === null ? asked & ~umask : target.mode & 0o7777;
      const mode = keepMode ? copyfileMode(source.mode, data.byteLength, host.cred.uid) : opened;
      return openToWrite(to, path, { write: true, create: true, truncate: true, mode: asked, umask }, target, data, true, keepMode ? mode : undefined) !== undefined;
    },

    content: (entry) => {
      if (touched.size === 0) return undefined;
      const inode = inodeAtNumber(entry.dev, entry.ino);
      if (inode === undefined || inode.state === null || inode.state.bytes === null) return undefined;
      return owned(inode.state.bytes, inode.state.size);
    },

    barrierBegun: () => ++barriers,

    retire: (begun) => {
      // A name record answered before the barrier began is the view's now; one under a held subtree waits for it to be given back.
      const kept = nameRecords.filter((record) => {
        if (!record.answered || record.answeredAt >= begun) return true;
        record.retired?.();
        host.release(record.cost);
        return false;
      });
      if (kept.length < nameRecords.length) {
        nameRecords.splice(0, nameRecords.length, ...kept);
        replay();
      }
      for (const inode of [...everyInode()]) {
        // A grant's decides it; one given back stands until a barrier begun after its decisions were answered.
        if (inode.cell !== undefined) continue;
        if (inode.heldAt !== undefined) {
          if (inode.heldAt >= begun) continue;
          delete inode.heldAt;
        }
        // Its records answered before the barrier began are the view's now: it is the view's version with the rest folded over it.
        // One made here and never numbered (its creating open refused, or not answered yet) the view has nothing of: as a file no name leads to.
        const retired = inode.records.filter((record) => record.answered && record.answeredAt < begun);
        if (retired.length === 0 && inode.records.length > 0) continue;
        const seen = viewed(inode);
        if (seen === undefined) {
          // No name leads to it in the view: what it holds is what retired made of it, where its baseline's bytes can say so
          // (else they stay records while a descriptor may still read them).
          if (inode.descs > 0 && inode.base !== null && inode.base.bytes === null && retired.some((record) => payloadOf(record.op) > 0)) continue;
          dropRecords(inode, new Set(retired));
          if (inode.base !== null) for (const record of retired) inode.base = applyOp(inode.base, record.op);
          if (inode.records.length === 0 && inode.descs === 0) {
            inode.base = null;
            inode.state = null;
          }
        } else if (inode.records.length === retired.length) {
          dropRecords(inode, new Set(retired));
          inode.row = seen.row;
          inode.base = null;
          inode.state = null;
        } else {
          dropRecords(inode, new Set(retired));
          inode.base = baseline(inode);
        }
        if (inode.state === null) {
          touched.delete(inode);
        } else {
          refold(inode);
        }
        fit(inode);
        release(inode);
      }
      activity();
    },
  };
  return provisional;
}
