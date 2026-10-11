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

type Answering<F> = F extends (...args: infer A) => infer R ? (...args: A) => Awaitable<R> : F;
type EngineDescription = Omit<VfsOpenDescription, 'path'>;

/** An open file description: what a process's descriptors (dups included) share. Its name is known at once. */
export type Description = { [K in keyof EngineDescription]: Answering<EngineDescription[K]> } & {
  path(): string;
  /** Its operations are an asynchronous mount's: only a caller that can wait reaches them. */
  readonly awaits?: true;
  /** A mounted file's: its stat is the mount's, which never moves the SQLite clock. */
  readonly mounted?: true;
  /** An O_APPEND write: at the end of the file as it is then; answers that end after it. */
  append?(bytes: Uint8Array): Awaitable<number>;
  /** Which file it is, wherever it is named (PinnedFile.key): what its held writes overlay. */
  key?(): string;
  /**
   * A description whose mount cannot write in place holds its writes until a
   * flush (fsync, the last close, the process's release): `pendingBytes` is
   * what a process killed now would lose, and `applyPending` lays them over
   * `file`, as the flush will.
   */
  pendingBytes?(): number;
  applyPending?(file: Uint8Array): Uint8Array;
};

interface Opened {
  handle: RuntimeFileHandle;
  node: Description;
  refs: number;
}

export interface DescriptorScope {
  nextId: number;
  handles: Map<number, Opened>;
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
  return { nextId: 1, handles: new Map(), waveDescriptions: new Map(), closed: false, abort: new AbortController(), subscriptions: new Set(), leases: new Map() };
}

/**
 * A description's last close: a buffered mount handle's flush. A flush that
 * fails loses the writes it held, and says so: close's error for the file,
 * the failure as its cause (EIO where it carries no code: an abort, a dropped
 * call). Node's close reports a deferred write's failure the same way.
 */
function lastClose(node: Description): void {
  try {
    // An awaiting description holds nothing at its close (its writes land as they are made).
    void node.close();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'EIO';
    const reason = error instanceof Error ? error.message : String(error);
    throw fsError(code, 'close', node.path(), undefined, { detail: `its buffered writes are lost (${reason})`, cause: error });
  }
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
      lastClose(opened.node);
    } catch (error) {
      lost.push(error);
    }
  }
  scope.handles.clear();
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

/**
 * A mounted file as this process sees it while it holds buffered writes to
 * it (VFS-PF-001 viewAs, page-cache semantics): the file `file` names
 * (PinnedFile.key) with each of this process's descriptions of it applied,
 * in open order. Undefined when it holds none pending: then the mount's own
 * file is the answer. Another process's pending writes are never in it, nor
 * a file that only shares its name. `file` is asked only once some
 * description holds writes.
 */
export function processView(scope: DescriptorScope, read: () => Uint8Array | null, file: string | (() => string)): Uint8Array | undefined {
  let view: Uint8Array | undefined;
  let key: string | undefined;
  const seen = new Set<Description>();
  for (const opened of scope.handles.values()) {
    const node = opened.node;
    if (seen.has(node) || node.applyPending === undefined || (node.pendingBytes?.() ?? 0) === 0) continue;
    key ??= typeof file === 'string' ? file : file();
    if (node.key?.() !== key) continue;
    seen.add(node);
    view ??= read() ?? new Uint8Array(0);
    view = node.applyPending(view);
  }
  return view;
}

/** The descriptor operations, over a scope: answered in the caller's turn unless the description awaits. */
export class Descriptors {
  constructor(
    private readonly scope: DescriptorScope,
    /** The SQLite clock: the revision an fstat of a description on SQLite reports. */
    private readonly clock: () => number,
  ) {}

  /** A descriptor for `node`, new, at `position`. */
  issue(node: Description, flags: RuntimeFileHandle['flags'], position = 0): RuntimeFileHandle {
    const handle: RuntimeFileHandle = { id: this.scope.nextId++, path: node.path(), flags: Object.freeze(flags), position, closed: false };
    this.scope.handles.set(handle.id, { handle, node, refs: 1 });
    return { ...handle };
  }

  /** The description `id` names (EBADF when none, or once the scope is closed). */
  description(id: number): Description {
    return this.opened(id).node;
  }

  private opened(id: number): Opened {
    const opened = this.scope.handles.get(id);
    if (!opened || this.scope.closed) throw fsError('EBADF', 'fd', String(id));
    return opened;
  }

  // A descriptor's reads and writes answer in the caller's turn without a
  // callback where the description does (andThen allocates one per call).
  read(id: number, offset: number | null, length: number): Awaitable<Uint8Array> {
    const { handle, node } = this.opened(id);
    if (!handle.flags.read) throw fsError('EBADF', 'read', handle.path);
    const start = offset == null ? handle.position : Math.max(0, offset);
    const out = node.read(start, Math.max(0, length));
    if (offset != null) return out;
    if (isPromise(out)) return out.then((bytes) => read(handle, start, bytes));
    return read(handle, start, out);
  }

  write(id: number, offset: number | null, bytes: Uint8Array): Awaitable<number> {
    const { handle, node } = this.opened(id);
    if (!handle.flags.write) throw fsError('EBADF', 'write', handle.path);
    if (handle.flags.append && node.append) {
      const end = node.append(bytes);
      if (isPromise(end)) return end.then((at) => moved(handle, at, bytes));
      return moved(handle, end, bytes);
    }
    const start = handle.flags.append
      ? node.end?.() ?? andThen(node.stat(), (stat) => stat.size)
      : offset == null ? handle.position : Math.max(0, offset);
    if (isPromise(start)) return start.then((at) => this.writeAt(handle, node, at, offset, bytes));
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
    if (id !== undefined) return this.opened(id).node.flush?.();
  }

  /** The absolute path a descriptor was opened at. */
  path(id: number): string {
    return this.opened(id).node.path();
  }

  fstat(id: number): Awaitable<RuntimeVfsStat> {
    const node = this.opened(id).node;
    return andThen(node.stat(), (stat) => (node.mounted ? stat as RuntimeVfsStat : { ...stat, revision: this.clock() }));
  }

  dup(id: number): RuntimeFileHandle {
    const opened = this.opened(id);
    const dup = this.scope.nextId++;
    opened.refs++;
    this.scope.handles.set(dup, opened);
    return { ...opened.handle, id: dup };
  }

  seek(id: number, offset: number, whence: 'set' | 'current' | 'end'): Awaitable<number> {
    const handle = this.opened(id).handle;
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

  readdir(id: number): Awaitable<RuntimeVfsDirEntry[]> { return this.opened(id).node.readdir(); }

  /** ftruncate(2) of a descriptor not open for writing is EINVAL, as Linux answers it. */
  ftruncate(id: number, size: number): Awaitable<void> {
    const { handle, node } = this.opened(id);
    if (!handle.flags.write) throw fsError('EINVAL', 'ftruncate', handle.path);
    return node.truncate(size);
  }

  fchmod(id: number, mode: number): Awaitable<void> { return this.opened(id).node.chmod(mode); }
  fchown(id: number, uid: number, gid: number): Awaitable<void> { return this.opened(id).node.chown(uid, gid); }
  futimes(id: number, atime: number, mtime: number): Awaitable<void> { return this.opened(id).node.utimes(atime, mtime); }
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
