/**
 * A process's open file descriptions and the descriptors that name them:
 * one numbering per process (DescriptorScope), shared by its synchronous
 * and asynchronous faces, whatever filesystem each description is on. A
 * description on SQLite is the engine's (SqliteVFS.openDescription); one on
 * a mount is the namespace's (vfs/mounted-description.ts), and answers by
 * awaiting when its mount does (`awaits`): the synchronous face refuses
 * that one as it refuses its mount, before anything is done.
 */

import { then, type Awaitable } from '../vfs/vfs.js';
import type { VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import { fsError } from '../vfs/vfs-error.js';
import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from './os-contracts.js';

type Answering<F> = F extends (...args: infer A) => infer R ? (...args: A) => Awaitable<R> : F;

/** An open file description: what a process's descriptors (dups included) share. */
export type Description = { [K in keyof VfsOpenDescription]: Answering<VfsOpenDescription[K]> } & {
  /** Its operations are an asynchronous mount's: only a caller that can wait reaches them. */
  readonly awaits?: true;
  /** A mounted file's: its stat is the mount's, which never moves the SQLite clock. */
  readonly mounted?: true;
  /** An O_APPEND write: at the end of the file as it is then; answers that end after it. */
  append?(bytes: Uint8Array): Awaitable<number>;
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
 * it (VFS-PF-001 viewAs, page-cache semantics): the mount's file with each
 * of this process's descriptions of it applied, in open order. Undefined
 * when it holds none pending: then the mount's own file is the answer.
 * Another process's pending writes are never in it.
 */
export function processView(scope: DescriptorScope, read: () => Uint8Array | null, name: string): Uint8Array | undefined {
  let file: Uint8Array | undefined;
  const seen = new Set<Description>();
  for (const opened of scope.handles.values()) {
    const node = opened.node;
    if (seen.has(node) || node.applyPending === undefined || node.path() !== name || (node.pendingBytes?.() ?? 0) === 0) continue;
    seen.add(node);
    file ??= read() ?? new Uint8Array(0);
    file = node.applyPending(file);
  }
  return file;
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

  read(id: number, offset: number | null, length: number): Awaitable<Uint8Array> {
    const { handle, node } = this.opened(id);
    if (!handle.flags.read) throw fsError('EBADF', 'read', handle.path);
    const start = offset == null ? handle.position : Math.max(0, offset);
    return then(node.read(start, Math.max(0, length)), (out) => {
      if (offset == null) handle.position = start + out.byteLength;
      return out;
    });
  }

  write(id: number, offset: number | null, bytes: Uint8Array): Awaitable<number> {
    const { handle, node } = this.opened(id);
    if (!handle.flags.write) throw fsError('EBADF', 'write', handle.path);
    if (handle.flags.append && node.append) {
      return then(node.append(bytes), (end) => {
        handle.position = end;
        return bytes.byteLength;
      });
    }
    const start = handle.flags.append
      ? node.end?.() ?? then(node.stat(), (stat) => stat.size)
      : offset == null ? handle.position : Math.max(0, offset);
    return then(start, (at) => then(node.write(at, bytes), () => {
      if (offset == null || handle.flags.append) handle.position = at + bytes.byteLength;
      return bytes.byteLength;
    }));
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
    return then(node.stat(), (stat) => (node.mounted ? stat as RuntimeVfsStat : { ...stat, revision: this.clock() }));
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
    const base = whence === 'set' ? 0 : whence === 'current' ? handle.position : whence === 'end' ? then(this.fstat(id), (stat) => stat.size) : NaN;
    return then(base, (from) => {
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
