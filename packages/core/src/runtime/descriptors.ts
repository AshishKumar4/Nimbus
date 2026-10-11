/**
 * A process's open file descriptions and the descriptors that name them:
 * one numbering per process (DescriptorScope), shared by its synchronous
 * and asynchronous faces, whatever filesystem each description is on. A
 * description on SQLite is the engine's (SqliteVFS.openDescription); one on
 * a mount is the namespace's (vfs/mounted-description.ts), and answers by
 * awaiting when its mount does (`awaits`): the synchronous face refuses
 * that one as it refuses its mount, before anything is done.
 */

import { andThen, isPromise, type Awaitable } from '../vfs/vfs.js';
import type { VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import { fsError } from '../vfs/vfs-error.js';
import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from './os-contracts.js';

/** The engine's description of a file on SQLite (SqliteVFS.openDescription): every answer at once. */
export type EngineDescription = VfsOpenDescription & { readonly mounted?: undefined; readonly awaits?: undefined };

/**
 * A mounted file's description (vfs/mounted-description.ts): its answers
 * await where its mount does (`awaits`), and its stat is the mount's, which
 * never moves the SQLite clock.
 */
export interface MountedFileDescription {
  readonly mounted: true;
  /** Its operations are an asynchronous mount's: only a caller that can wait reaches them. */
  readonly awaits: boolean;
  readonly ino: number;
  path(): string;
  /** Which file it is (HeldFile.key): what its held writes overlay. */
  key(): string;
  stat(): Awaitable<RuntimeVfsStat>;
  read(offset: number, length: number): Awaitable<Uint8Array>;
  /** `admit`: the current operation's own admission, run right before its backend is asked. */
  write(offset: number, bytes: Uint8Array, admit?: () => void): Awaitable<number>;
  /** An O_APPEND write: at the end of the file as it is then; answers that end after it. */
  append(bytes: Uint8Array, admit?: () => void): Awaitable<number>;
  truncate(size: number, admit?: () => void): Awaitable<void>;
  readdir(): Awaitable<RuntimeVfsDirEntry[]>;
  chmod(mode: number, admit?: () => void): Awaitable<void>;
  chown(uid: number, gid: number, admit?: () => void): Awaitable<void>;
  utimes(atime: number, mtime: number, admit?: () => void): Awaitable<void>;
  /** Writes what it holds; throws what that, or an earlier settle of it, failed with. */
  flush(): Awaitable<void>;
  /** Writes what it holds, unasked (settleHeld): a failure is kept for its next fsync or close. */
  settle(): void;
  close(): Awaitable<void>;
  /**
   * A description whose mount cannot write in place holds its writes until a
   * flush (fsync, the last close, the process's release, or a later change
   * of the same file the process makes, settleHeld): `pendingBytes` is what a
   * process killed now would lose, and `applyPending` lays them over `file`,
   * as the flush will.
   */
  pendingBytes(): number;
  applyPending(file: Uint8Array): Uint8Array;
}

/** An open file description: what a process's descriptors (dups included) share. */
export type Description = EngineDescription | MountedFileDescription;

interface Opened {
  handle: RuntimeFileHandle;
  node: Description;
  refs: number;
}

export interface DescriptorScope {
  nextId: number;
  handles: Map<number, Opened>;
  /** The descriptions that hold writes now (a mount that cannot write in place): settled before the process changes anything else. */
  held: Set<MountedFileDescription>;
  /** The process's open descriptions its waves name (W7Call description), by the id it chose: descriptors of its own. */
  waveDescriptions: Map<string, number>;
  closed: boolean;
  /** Aborted when the scope closes; cancels in-flight stream commits. */
  abort: AbortController;
  subscriptions: Set<() => void>;
  /** The exclusive leases the process took itself (not delegations), by owner: each one's release, among the subscriptions. */
  leases: Map<string, () => void>;
}

/** An open's flags as its descriptor keeps them: neither access asked is O_RDONLY. */
export function openFlags(flags: RuntimeOpenFlags): RuntimeFileHandle['flags'] {
  return {
    read: !!flags.read || !flags.write,
    write: !!flags.write,
    append: !!flags.append,
    create: !!flags.create,
    exclusive: !!flags.exclusive,
    directory: !!flags.directory,
    truncate: !!flags.truncate,
    followSymlinks: flags.followSymlinks !== false,
    expectedRevision: flags.expectedRevision,
  };
}

/** A description on an asynchronous mount, asked of a caller that cannot wait: its mount's refusal (isAsyncMountRefusal). */
export function awaitsRefusal(path: string): Error {
  return Object.assign(fsError('EAGAIN', 'fd', path, undefined, { detail: 'a descriptor on an asynchronous mount; this caller cannot wait for it' }), { asyncMount: true as const });
}

export function createDescriptorScope(): DescriptorScope {
  return { nextId: 1, handles: new Map(), held: new Set(), waveDescriptions: new Map(), closed: false, abort: new AbortController(), subscriptions: new Set(), leases: new Map() };
}

/**
 * A description's last close: a buffered mount handle's flush. A flush that
 * fails loses the writes it held, and says so: close's error for the file,
 * the failure as its cause (EIO where it carries no code: an abort, a dropped
 * call). Node's close reports a deferred write's failure the same way.
 */
function lastClose(node: Description): Awaitable<void> {
  const lost = (error: unknown): never => {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'EIO';
    const reason = error instanceof Error ? error.message : String(error);
    throw fsError(code, 'close', node.path(), undefined, { detail: `its buffered writes are lost (${reason})`, cause: error });
  };
  try {
    const closed = node.close();
    return isPromise(closed) ? closed.catch(lost) : closed;
  } catch (error) {
    return lost(error);
  }
}

/**
 * Every write this process holds, settled: before the process changes
 * anything else (its namespace's check, ProcessFiles), so a later truncate,
 * rename or write of the same file is ordered after them, as the page cache
 * orders them. A description holds writes only where its mount answers at
 * once, so this is done in the caller's turn. One that fails keeps its
 * failure for its next fsync or close, and the change goes on.
 */
export function settleHeld(scope: DescriptorScope): void {
  for (const node of scope.held) node.settle();
}

/**
 * Closes every description `scope` holds, each whatever another's flush
 * answers, and empties it. The flushes that failed (lastClose's errors) are
 * returned, for the caller to report once the rest of its teardown is done
 * (reportLost): a teardown that stopped at the first one would keep the
 * scope, and everything it revokes, open.
 */
export function closeDescriptions(scope: DescriptorScope): unknown[] {
  const lost: unknown[] = [];
  for (const opened of scope.handles.values()) {
    if (--opened.refs !== 0) continue;
    opened.handle.closed = true;
    try {
      const closed = lastClose(opened.node);
      // An awaiting description holds nothing (its writes land as they are made): its backend's close is all that waits.
      if (isPromise(closed)) closed.catch((error: unknown) => { lost.push(error); });
    } catch (error) {
      lost.push(error);
    }
  }
  scope.handles.clear();
  scope.held.clear();
  scope.waveDescriptions.clear();
  return lost;
}

/** Reports closeDescriptions' failures: the one, or EIO over them all. */
export function reportLost(lost: readonly unknown[]): void {
  if (lost.length === 1) throw lost[0];
  if (lost.length > 1) {
    throw Object.assign(new AggregateError(lost, `EIO: the buffered writes of ${lost.length} descriptors are lost`), { code: 'EIO' });
  }
}

/** A file as a path read finds it (PinnedName), or as a description holds it (HeldFile): which file, and its content. */
interface Viewed {
  key(): Awaitable<string | null>;
  readAll(): Awaitable<Uint8Array>;
}

/**
 * A mounted file as this process sees it while it holds writes to it
 * (VFS-PF-001 viewAs, page-cache semantics): `file`'s content with each of
 * this process's descriptions of that same file (HeldFile.key) applied, in
 * open order. Undefined when it holds none for it: then the file's own
 * content is the answer. Another process's held writes are never in it, nor
 * a file that only shares its name. `file` is asked only once some
 * description holds writes.
 */
export function processView(scope: DescriptorScope, file: () => Awaitable<Viewed>): Awaitable<Uint8Array | undefined> {
  if (scope.held.size === 0) return undefined;
  const holding = [...scope.held];
  return andThen(file(), (viewed) => andThen(viewed.key(), (key) => {
    const mine = holding.filter((node) => node.key() === key);
    if (mine.length === 0) return undefined;
    return andThen(viewed.readAll(), (base) => mine.reduce((view, node) => node.applyPending(view), base));
  }));
}

/** The descriptor operations, over a scope: answered in the caller's turn unless the description awaits. */
export class Descriptors {
  constructor(
    private readonly scope: DescriptorScope,
    /** The SQLite clock: the revision an fstat of a description on SQLite reports. */
    private readonly clock: () => number,
    /** A synchronous face's: a description that awaits refuses its operations (awaitsRefusal), as its mount does; every other answers at once. */
    private readonly synchronous = false,
  ) {}

  /** A descriptor for `node`, new, at `position`. */
  issue(node: Description, flags: RuntimeFileHandle['flags'], position = 0): RuntimeFileHandle {
    const handle: RuntimeFileHandle = { id: this.scope.nextId++, path: node.path(), flags: Object.freeze(flags), position, closed: false };
    this.scope.handles.set(handle.id, { handle, node, refs: 1 });
    return { ...handle };
  }

  /** The description `id` names, to answer from (EBADF when none, or once the scope is closed). */
  description(id: number): Description {
    return this.answering(id).node;
  }

  private opened(id: number): Opened {
    const opened = this.scope.handles.get(id);
    if (!opened || this.scope.closed) throw fsError('EBADF', 'fd', String(id));
    return opened;
  }

  /** Descriptor `id`, for an operation that answers: refused on a synchronous face where its description awaits. */
  private answering(id: number): Opened {
    const opened = this.opened(id);
    if (this.synchronous && opened.node.awaits === true) throw awaitsRefusal(opened.node.path());
    return opened;
  }

  // A descriptor's reads and writes answer in the caller's turn without a
  // callback where the description does (andThen allocates one per call).
  // An explicit offset is where they are, never a negative one (EINVAL, as
  // pread(2) answers it); null is the descriptor's own.
  read(id: number, offset: number | null, length: number): Awaitable<Uint8Array> {
    const { handle, node } = this.answering(id);
    if (!handle.flags.read) throw fsError('EBADF', 'read', handle.path);
    if (offset != null && offset < 0) throw fsError('EINVAL', 'read', handle.path);
    const start = offset ?? handle.position;
    const out = node.read(start, Math.max(0, length));
    if (offset != null) return out;
    if (isPromise(out)) return out.then((bytes) => read(handle, start, bytes));
    return read(handle, start, out);
  }

  write(id: number, offset: number | null, bytes: Uint8Array): Awaitable<number> {
    const { handle, node } = this.answering(id);
    if (!handle.flags.write) throw fsError('EBADF', 'write', handle.path);
    if (offset != null && offset < 0) throw fsError('EINVAL', 'write', handle.path);
    if (handle.flags.append && node.mounted) {
      const end = node.append(bytes);
      if (isPromise(end)) return end.then((at) => moved(handle, at, bytes));
      return moved(handle, end, bytes);
    }
    // The engine's O_APPEND: at the end it keeps (VfsOpenDescription.end).
    const start = handle.flags.append && !node.mounted ? node.end?.() ?? node.stat().size : offset ?? handle.position;
    return this.writeAt(handle, node, start, offset, bytes);
  }

  private writeAt(handle: RuntimeFileHandle, node: Description, at: number, offset: number | null, bytes: Uint8Array): Awaitable<number> {
    const written = node.write(at, bytes);
    if (offset != null && !handle.flags.append) return isPromise(written) ? written.then(() => bytes.byteLength) : bytes.byteLength;
    if (isPromise(written)) return written.then(() => moved(handle, at + bytes.byteLength, bytes));
    return moved(handle, at + bytes.byteLength, bytes);
  }

  close(id: number): void {
    const opened = this.opened(id);
    this.scope.handles.delete(id);
    if (--opened.refs === 0) { opened.handle.closed = true; lastClose(opened.node); }
  }

  /**
   * Writes what the description's file has held: a buffered mount handle's
   * writes, the appends SqliteVFS holds (appendThrough). Any other write was
   * in the store before its call returned.
   */
  fsync(id?: number): Awaitable<void> {
    if (id !== undefined) return this.answering(id).node.flush?.();
  }

  /** The absolute path a descriptor was opened at. */
  path(id: number): string {
    return this.opened(id).node.path();
  }

  fstat(id: number): Awaitable<RuntimeVfsStat> {
    const node = this.answering(id).node;
    return node.mounted ? node.stat() : { ...node.stat(), revision: this.clock() };
  }

  dup(id: number): RuntimeFileHandle {
    const opened = this.opened(id);
    const dup = this.scope.nextId++;
    opened.refs++;
    this.scope.handles.set(dup, opened);
    return { ...opened.handle, id: dup };
  }

  seek(id: number, offset: number, whence: 'set' | 'current' | 'end'): Awaitable<number> {
    const handle = this.answering(id).handle;
    const base = whence === 'set' ? 0 : whence === 'current' ? handle.position : whence === 'end' ? andThen(this.fstat(id), (stat) => stat.size) : NaN;
    return andThen(base, (from) => {
      const position = from + offset;
      if (!Number.isSafeInteger(position) || position < 0) throw fsError('EINVAL', 'seek', handle.path);
      handle.position = position;
      return position;
    });
  }

  setStatus(id: number, status: { append?: boolean }): void {
    const handle = this.opened(id).handle;
    if (status.append !== undefined) handle.flags = Object.freeze({ ...handle.flags, append: status.append });
  }

  readdir(id: number): Awaitable<RuntimeVfsDirEntry[]> { return this.answering(id).node.readdir(); }

  /** ftruncate(2) of a descriptor not open for writing is EINVAL, as Linux answers it. */
  ftruncate(id: number, size: number): Awaitable<void> {
    const { handle, node } = this.answering(id);
    if (!handle.flags.write) throw fsError('EINVAL', 'ftruncate', handle.path);
    return node.truncate(size);
  }

  fchmod(id: number, mode: number): Awaitable<void> { return this.answering(id).node.chmod(mode); }
  fchown(id: number, uid: number, gid: number): Awaitable<void> { return this.answering(id).node.chown(uid, gid); }
  futimes(id: number, atime: number, mtime: number): Awaitable<void> { return this.answering(id).node.utimes(atime, mtime); }
}

/** A read at the descriptor's offset: the offset moved past what it read. */
function read(handle: RuntimeFileHandle, start: number, bytes: Uint8Array): Uint8Array {
  handle.position = start + bytes.byteLength;
  return bytes;
}

/** A write at the descriptor's offset (or its end): the offset left at `end`. */
function moved(handle: RuntimeFileHandle, end: number, bytes: Uint8Array): number {
  handle.position = end;
  return bytes.byteLength;
}
