/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. The open is decided on the
 * name its lookup found (CompositeVFS.pin, PinnedName), and the description
 * holds the file there (PinnedName.hold, HeldFile).
 *
 * What a mount does not give, a description on it does not promise: an
 * O_APPEND write is the end as it is read, then a write there (two writers
 * on an awaiting mount can meet at one end); O_CREAT|O_EXCL is a stat, then a
 * create (two awaiting opens can both create). A file on a backend that
 * keeps no open files (VFS.openFile) is held by its name, and a description
 * of it refuses (ESTALE) once that name holds another file. The writes a
 * description holds are its process's: written before that process cuts
 * their file (settleHeld), never before another process's change.
 */

import { processView, settleHeld, type DescriptorScope, type MountedFileDescription } from '../runtime/descriptors.js';
import type { FsTime, RuntimeFileHandle, RuntimeVfsDirEntry, RuntimeVfsStat } from '../runtime/os-contracts.js';
import { runtimeStatOf, type HeldFile, type PinnedName } from './composite.js';
import { andThen, isPromise, type Awaitable, type VfsStat } from './vfs.js';
import { isVfsError, type VfsErrorCode } from './vfs-error.js';

/** What one description holds unwritten before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export const BUFFERED_WRITE_BYTES = 8 * 1024 * 1024;

/** How the caller names a refusal: `code`, for its call `syscall` (open, write, ftruncate, …). */
export type Refuse = (code: VfsErrorCode, syscall: string) => Error;

export interface MountedOpen {
  flags: RuntimeFileHandle['flags'];
  refuse: Refuse;
  /** The mode a file this open makes is made with. */
  mode?: number;
}

/**
 * Where an open looks its name up (CompositeVFS.pin): through a link at it,
 * unless it declines to (O_NOFOLLOW) or answers for the name itself
 * (O_CREAT|O_EXCL).
 */
export function openFollows(flags: RuntimeFileHandle['flags']): boolean {
  return flags.followSymlinks && !(flags.create && flags.exclusive);
}

/**
 * The refusals open(2) makes of its flags alone, before any name is looked
 * up: O_CREAT|O_DIRECTORY is EINVAL (Linux's build_open_flags). Null when
 * there is none. Every open asks it first, on SQLite as on a mount.
 */
export function flagsRefusal(flags: RuntimeFileHandle['flags']): VfsErrorCode | null {
  return flags.create && flags.directory ? 'EINVAL' : null;
}

/**
 * The access an open asks of a file that is there (VFS.access's mode), as
 * Linux's open asks it: read for reading, write for writing or O_TRUNC
 * (whatever rights the descriptor itself has). A description's write rights
 * on a directory are a capability, not an access (a WASI guest asks a
 * capability set); a wave's open is to write.
 */
export function openAccess(flags: RuntimeFileHandle['flags'], directory: boolean, describes = true): number {
  const writes = (flags.write && !(describes && directory)) || flags.truncate;
  return (flags.read ? 4 : 0) | (writes ? 2 : 0);
}

/**
 * open(2) of the name `file` found (pinned where the lookup landed,
 * openFollows), one rule for every caller, Linux's (do_open) where Linux and
 * POSIX differ, in its order:
 * - O_CREAT|O_EXCL of a name that is there, a link included: EEXIST;
 * - O_DIRECTORY of a link not followed: ENOTDIR; O_NOFOLLOW of a link: ELOOP;
 * - an absent name without O_CREAT: ENOENT;
 * - O_CREAT of a directory: EISDIR; O_DIRECTORY of anything else: ENOTDIR;
 * - a directory refuses O_TRUNC and O_APPEND (EISDIR), and an open that
 *   keeps no description (`describes` false, a wave's open to write) any write;
 * - the access asked (openAccess), by the backend's own policy (VFS.access):
 *   a backend that takes a caller's credential enforces modes, one of one
 *   identity has none;
 * - only then is the file made, or truncated, there.
 * Answers the file's stat. `admit` runs right before the backend is asked to
 * change anything, after every await.
 */
export function openOnMount(file: PinnedName, open: MountedOpen, describes: boolean, admit?: () => void): Awaitable<VfsStat> {
  const { flags, refuse } = open;
  const flagged = flagsRefusal(flags);
  if (flagged !== null) throw refuse(flagged, 'open');
  const statAfter = (): Awaitable<VfsStat> => andThen(file.stat(), (after) => {
    if (after === null) throw refuse('ENOENT', 'open');
    return after;
  });
  return andThen(file.lstat(), (named) => {
    if (named !== null && flags.create && flags.exclusive) throw refuse('EEXIST', 'open');
    if (named?.type === 'symlink' && !flags.followSymlinks) throw refuse(flags.directory ? 'ENOTDIR' : 'ELOOP', 'open');
    // A link a backend resolves itself (MountOptions.resolvesPaths) is followed by that backend.
    return andThen(named?.type === 'symlink' ? file.stat() : named, (there) => {
      if (there === null) {
        if (!flags.create) throw refuse('ENOENT', 'open');
      } else {
        const directory = there.type === 'directory';
        if (directory && flags.create) throw refuse('EISDIR', 'open');
        if (flags.directory && !directory) throw refuse('ENOTDIR', 'open');
        if (directory && (flags.truncate || flags.append || (flags.write && !describes))) throw refuse('EISDIR', 'open');
      }
      const access = there === null ? undefined : file.access(openAccess(flags, there.type === 'directory', describes));
      return andThen(access, () => {
        if (there !== null && !flags.truncate) return there;
        if (there !== null) {
          // A description needs only the file's inode, which truncating keeps; a wave answers the stat after.
          const truncated = file.truncate(0, admit);
          return describes ? andThen(truncated, () => there) : andThen(truncated, statAfter);
        }
        return andThen(file.create(open.mode, admit), statAfter);
      });
    });
  });
}

/** What a mounted description is held with, whatever opened it. */
export interface MountedDescriptionContext {
  /** The descriptors' scope: its held writes are this process's (processView, settleHeld). */
  scope: DescriptorScope;
  /** Its opener's own abort (a caller's signal): the description's calls are refused once it comes, its buffered writes lost. */
  signal?: AbortSignal;
  refuse: Refuse;
  /** O_SYNC: each write in the mount before it returns. */
  sync: boolean;
  /** What a description holds unwritten before a write is EFBIG. */
  bufferedWriteBytes: number;
}

export interface MountedDescriptionOptions extends MountedOpen, MountedDescriptionContext {
  /** The name opened, in the namespace. */
  name: string;
  /** The name `name` leads to now (CompositeVFS.pin): what the open decides on, and its description holds. */
  pin(name: string, follow: boolean): Awaitable<PinnedName>;
}

/** open(2) of a mounted file, and the description its descriptors share: one pin, for both. */
export function openMounted(options: MountedDescriptionOptions): Awaitable<MountedFileDescription> {
  // An O_TRUNC open cuts the file after the writes the process holds on it (settleHeld): those are only on a mount that answers at once.
  const settle = (name: PinnedName) => (): void => {
    const key = name.key();
    if (!isPromise(key)) settleHeld(options.scope, key);
  };
  return andThen(options.pin(options.name, openFollows(options.flags)), (name) => andThen(openOnMount(name, options, true, settle(name)), (stat) => (
    andThen(name.hold({ read: options.flags.read, write: options.flags.write }, stat.ino ?? 0), (file) => describeMounted(options, file, stat.ino ?? 0)))));
}

/**
 * A new description of the file `description` is on (Linux's open of
 * /proc/self/fd/N), on its mount: the file at the name it is held by, so
 * long as that name still holds it (ESTALE once it holds another, as a
 * description held by its name refuses), with `options.flags`' access and an
 * offset of its own. O_TRUNC cuts it only once it is known to be that file.
 */
export function reopenMounted(description: MountedFileDescription, options: Omit<MountedDescriptionOptions, 'name'>): Awaitable<MountedFileDescription> {
  const flags = Object.freeze({ ...options.flags, create: false, exclusive: false, truncate: false });
  return andThen(openMounted({ ...options, name: description.path(), flags }), (reopened) => {
    if (reopened.ino !== description.ino) return andThen(reopened.close(), () => { throw options.refuse('ESTALE', 'open'); });
    return options.flags.truncate ? andThen(reopened.truncate(0), () => reopened) : reopened;
  });
}

/** The description of `file`, opened already (openOnMount), its number `ino`: what its descriptors share. */
export function describeMounted(context: MountedDescriptionContext, file: HeldFile, ino: number): MountedFileDescription {
  return new MountedDescription(context, file, ino);
}

type Held = { offset: number | null; bytes: Uint8Array };

/**
 * The description of a file on a mount. A write goes in place; on a mount
 * that cannot (ENOTSUP), the description holds its writes, at most
 * `bufferedWriteBytes` (EFBIG past it, nothing held), and a flush (fsync,
 * the last close, the process's release, or a cut of that file the process
 * makes, settleHeld) reads the file, applies them in order and writes it
 * back; this process reads the file with them applied. Writes made by awaiting, or under O_SYNC, are
 * flushed as each is made, so a write's answer is what the mount did.
 */
/** Descriptions opened so far: the next one's order (MountedFileDescription.order). */
let opened = 0;

class MountedDescription implements MountedFileDescription {
  readonly ino: number;
  readonly mounted = true;
  readonly awaits: boolean;
  readonly order = ++opened;
  private readonly immediate: boolean;
  private inPlace = true;
  private pending: Held[] = [];
  private held = 0;
  /** What a settle of its writes it did not ask for failed with (settleHeld): its next fsync or close says so. */
  private failed: unknown = null;

  constructor(private readonly options: MountedDescriptionContext, private readonly file: HeldFile, ino: number) {
    this.ino = ino;
    this.awaits = file.awaits;
    this.immediate = options.sync || file.awaits;
  }

  /** The namespace's name for it, when it was opened. */
  path(): string { return this.file.name; }
  key(): string { return this.file.key; }

  stat(admit?: () => void): Awaitable<RuntimeVfsStat> {
    return andThen(this.file.stat(this.admitted('fstat', admit)), (there) => {
      const now = runtimeStatOf(there);
      return andThen(this.viewed(admit), (view) => (view ? { ...now, size: view.byteLength } : now));
    });
  }

  read(offset: number, length: number, admit?: () => void): Awaitable<Uint8Array> {
    const view = this.viewed(admit);
    if (view === undefined) return this.file.read(offset, length, this.admitted('read', admit));
    return andThen(view, (bytes) => (bytes ? bytes.slice(offset, offset + length) : this.file.read(offset, length, this.admitted('read', admit))));
  }

  write(offset: number, bytes: Uint8Array, admit?: () => void): Awaitable<number> {
    const written = this.inPlaceAt(offset, bytes, admit);
    if (written === undefined) return this.hold({ offset, bytes: bytes.slice() }, bytes.byteLength, admit);
    return isPromise(written) ? written.then((end) => (end === undefined ? this.hold({ offset, bytes: bytes.slice() }, bytes.byteLength, admit) : bytes.byteLength)) : bytes.byteLength;
  }

  /** At the end as it is then (answers that end); a held one goes at the end as it stands at the flush. */
  append(bytes: Uint8Array, admit?: () => void): Awaitable<number> {
    if (!this.inPlace) return this.heldAppend(bytes, admit);
    return andThen(this.file.stat(this.admitted('write', admit)), (there) => {
      const written = this.inPlaceAt(there.size, bytes, admit);
      if (written === undefined) return this.heldAppend(bytes, admit);
      return isPromise(written) ? written.then((end) => end ?? this.heldAppend(bytes, admit)) : written;
    });
  }

  /** After the writes the process holds on its file, its own among them (settleHeld): none of them comes back after it. */
  truncate(size: number, admit?: () => void): Awaitable<void> {
    settleHeld(this.options.scope, this.file.key);
    return this.file.truncate(size, this.admitted('ftruncate', admit));
  }

  readdir(admit?: () => void): Awaitable<RuntimeVfsDirEntry[]> {
    return andThen(this.file.readdir(this.admitted('scandir', admit)), (entries) => entries.map((entry) => ({ name: entry.name, type: entry.type })));
  }

  chmod(mode: number, admit?: () => void): Awaitable<void> { return this.file.chmod(mode, this.admitted('fchmod', admit)); }
  chown(uid: number | null, gid: number | null, admit?: () => void): Awaitable<void> { return this.file.chown(uid, gid, this.admitted('fchown', admit)); }
  utimes(atime: FsTime, mtime: FsTime, admit?: () => void): Awaitable<void> { return this.file.utimes(atime, mtime, this.admitted('futimes', admit)); }

  /** A flush that fails loses what it held (lastClose says so): taken before it reads. */
  flush(admit?: () => void): Awaitable<void> {
    const failed = this.failed;
    if (failed !== null) {
      this.failed = null;
      throw failed;
    }
    if (this.pending.length === 0) return;
    const writes = this.pending;
    this.pending = [];
    this.held = 0;
    this.options.scope.held.delete(this);
    return andThen(this.file.readAll(this.admitted('write', admit)), (base) => this.file.replace(apply(writes, base), this.admitted('write', admit)));
  }

  /** A settle it did not ask for (settleHeld): what it fails with is kept for its next fsync or close. */
  settle(): void {
    try {
      const flushed = this.flush();
      if (isPromise(flushed)) flushed.catch((error: unknown) => { this.failed = error; });
    } catch (error) {
      this.failed = error;
    }
  }

  /** Its file closed whatever the flush answers: the flush's failure, else the close's, is its answer. */
  close(admit?: () => void): Awaitable<void> {
    let flushed: Awaitable<void>;
    try {
      flushed = this.flush(admit);
    } catch (error) {
      return this.closeAfter(error);
    }
    return isPromise(flushed) ? flushed.then(() => this.file.close(), (error: unknown) => this.closeAfter(error)) : this.file.close();
  }

  private closeAfter(failed: unknown): Awaitable<never> {
    const rethrow = (): never => { throw failed; };
    try {
      const closed = this.file.close();
      return isPromise(closed) ? closed.then(rethrow, rethrow) : rethrow();
    } catch {
      return rethrow();
    }
  }

  discard(): Awaitable<void> {
    this.pending = [];
    this.held = 0;
    this.options.scope.held.delete(this);
    return this.file.close();
  }

  pendingBytes(): number { return this.held; }
  applyPending(base: Uint8Array): Uint8Array { return apply(this.pending, base); }

  private hold(write: Held, bytes: number, admit?: () => void): Awaitable<number> {
    if (this.held + bytes > this.options.bufferedWriteBytes) throw this.options.refuse('EFBIG', 'write');
    this.pending.push(write);
    this.held += bytes;
    this.options.scope.held.add(this);
    return this.immediate ? andThen(this.flush(admit), () => bytes) : bytes;
  }

  /**
   * This process's view of the file while it holds writes to it, by any of
   * its descriptions (processView): this one's own O_SYNC governs only its
   * writes.
   */
  private viewed(admit: (() => void) | undefined): Awaitable<Uint8Array | undefined> {
    const { file } = this;
    return processView(this.options.scope, () => ({ key: () => file.key, readAll: () => file.readAll(this.admitted('read', admit)) }));
  }

  private heldAppend(bytes: Uint8Array, admit?: () => void): Awaitable<number> {
    return andThen(this.hold({ offset: null, bytes: bytes.slice() }, bytes.byteLength, admit), () => andThen(this.stat(admit), (now) => now.size));
  }

  /**
   * `bytes` written in place at `offset`: the end written. Undefined from
   * the mount's first refusal (ENOTSUP): the description holds its writes
   * from then on.
   */
  private inPlaceAt(offset: number, bytes: Uint8Array, admit?: () => void): Awaitable<number | undefined> {
    if (!this.inPlace) return undefined;
    let written: Awaitable<void>;
    try {
      written = this.file.write(offset, bytes, this.admitted('write', admit));
    } catch (error) {
      return this.cannot(error);
    }
    const end = offset + bytes.byteLength;
    return isPromise(written) ? written.then(() => end, (error: unknown) => this.cannot(error)) : end;
  }

  /**
   * `admit` (the operation's own admission: its caller's Authority, the
   * wave's), after the description's own: its process's descriptors still
   * open (EBADF once its scope is closed), the opener's own abort not come.
   * Run right before the mount is asked, after every await.
   */
  private admitted(syscall: string, admit: (() => void) | undefined): () => void {
    const { scope, refuse, signal } = this.options;
    return () => {
      if (scope.closed) throw refuse('EBADF', syscall);
      signal?.throwIfAborted();
      admit?.();
    };
  }

  private cannot(error: unknown): undefined {
    if (!isVfsError(error, 'ENOTSUP')) throw error;
    this.inPlace = false;
    return undefined;
  }
}

/** `base` with `writes` applied in order (an append at the end as it then is): what a flush writes, and what a process reads. */
function apply(writes: readonly Held[], base: Uint8Array): Uint8Array {
  // A copy: a backend may hand out its own buffer, which must not change before the flush.
  let file = base.slice();
  for (const write of writes) {
    const at = write.offset ?? file.byteLength;
    if (at + write.bytes.byteLength > file.byteLength) {
      const grown = new Uint8Array(at + write.bytes.byteLength);
      grown.set(file);
      file = grown;
    }
    file.set(write.bytes, at);
  }
  return file;
}
