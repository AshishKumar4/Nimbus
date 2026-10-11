/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. The open is decided through
 * `files`, the namespace as the caller sees it: its synchronous face
 * (CompositeVFS.sync), which refuses an asynchronous mount at the first
 * lookup, before anything has changed; or the namespace itself. The
 * description holds the file where that lookup landed (CompositeVFS.pin).
 */

import { processView, type Description, type DescriptorScope } from '../runtime/descriptors.js';
import type { RuntimeFileHandle, RuntimeVfsStat } from '../runtime/os-contracts.js';
import { runtimeStatOf, type PinnedFile, type PinnedFiles } from './composite.js';
import { andThen, isPromise, readRangeOrWhole, type Awaitable, type VfsDirentType, type VfsStat } from './vfs.js';
import { isVfsError } from './vfs-error.js';

/** What one description holds unwritten before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export const BUFFERED_WRITE_BYTES = 8 * 1024 * 1024;

/** How the caller names a refusal: `code`, for its call `syscall` (open, write, ftruncate, …). */
export type Refuse = (code: string, syscall: string) => Error;

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
 * open(2) of `file` (pinned where its name was looked up, openFollows), one
 * rule for every caller, Linux's where Linux and POSIX differ: O_CREAT|O_EXCL
 * is EEXIST on the name itself, a link included; O_NOFOLLOW of a link is
 * ELOOP; an absent name without O_CREAT is ENOENT, and with O_DIRECTORY
 * EINVAL; O_DIRECTORY of anything else is ENOTDIR; a directory refuses
 * O_TRUNC and O_APPEND (EISDIR); and only then is the file made, or
 * truncated, there. Answers the file's stat. Who may open a file for what is
 * its mount's own policy, as for every operation on it (VFS.access, asked of
 * a file that is there before anything changes): a backend that takes a
 * caller's credential enforces modes; a backend of one identity has none.
 * `describes`: whether the open keeps a description, whose write rights a
 * directory may carry (a WASI guest asks a capability set); an open that
 * keeps none (a wave's) is an open to write, which a directory refuses.
 * `settled` runs right before the answer, or the change.
 */
export function openOnMount(file: PinnedFile, open: MountedOpen, describes: boolean, settled?: () => Awaitable<void>): Awaitable<VfsStat> {
  const { files, path } = file;
  const { flags, refuse } = open;
  const statAfter = (): Awaitable<VfsStat> => andThen(files.stat(path), (after) => {
    if (after === null) throw refuse('ENOENT', 'open');
    return after;
  });
  return andThen(files.stat(path, { follow: false }), (named) => {
    if (named !== null && flags.create && flags.exclusive) throw refuse('EEXIST', 'open');
    if (named?.type === 'symlink' && !flags.followSymlinks) throw refuse('ELOOP', 'open');
    // A link a backend resolves itself (MountOptions.resolvesPaths) is followed by that backend.
    return andThen(named?.type === 'symlink' ? files.stat(path) : named, (there) => {
      if (there === null) {
        if (!flags.create) throw refuse('ENOENT', 'open');
        if (flags.directory) throw refuse('EINVAL', 'open');
      } else {
        if (flags.directory && there.type !== 'directory') throw refuse('ENOTDIR', 'open');
        if (there.type === 'directory' && (flags.truncate || flags.append || (flags.write && !describes))) throw refuse('EISDIR', 'open');
      }
      const access = there === null ? undefined : files.access?.(path, openAccess(flags, there, describes));
      return andThen(access, () => andThen(settled?.(), () => {
        if (there !== null && !flags.truncate) return there;
        if (there !== null) {
          // A description needs only the file's inode, which truncating keeps; a wave answers the stat after.
          const truncated = need(files.truncate, refuse, 'open').call(files, path, 0);
          return describes ? andThen(truncated, () => there) : andThen(truncated, statAfter);
        }
        return andThen(files.writeFile(path, new Uint8Array(0), open.mode === undefined ? undefined : { mode: open.mode }), statAfter);
      }));
    });
  });
}

/**
 * The access an open asks of a file that is there (VFS.access's mode). A
 * description's write rights on a directory are a capability, not an
 * access; a wave's open is to write.
 */
function openAccess(flags: RuntimeFileHandle['flags'], there: VfsStat, describes: boolean): number {
  return (flags.read ? 4 : 0) | (flags.write && (!describes || there.type !== 'directory') ? 2 : 0);
}

export interface MountedDescriptionOptions extends MountedOpen {
  /** The name opened, in the namespace. */
  name: string;
  /** The descriptors' scope: whose pending writes this process reads (processView). */
  scope: DescriptorScope;
  /** The file `name` leads to now (CompositeVFS.pin): what the open and its description hold, whatever later moves at the name. */
  pin(name: string, follow: boolean): Awaitable<PinnedFile>;
  /** O_SYNC: each write in the mount before it returns. */
  sync: boolean;
  /** What a description holds unwritten before a write is EFBIG. */
  bufferedWriteBytes: number;
}

/** open(2) of a mounted file, and the description its descriptors share: one pin, for both. */
export function openMounted(options: MountedDescriptionOptions): Awaitable<Description> {
  return andThen(options.pin(options.name, openFollows(options.flags)), (file) => andThen(openOnMount(file, options, true), (stat) => new MountedDescription(options, file, stat)));
}

type Held = { offset: number | null; bytes: Uint8Array };

/**
 * The description of `name` on a mount. A write goes in place (writeRange);
 * on a mount that cannot (none, or ENOTSUP), the description holds its
 * writes, at most `bufferedWriteBytes` (EFBIG past it, nothing held), and a
 * flush (fsync, the last close, the process's release) reads the file,
 * applies them in order and writes it back; this process reads the file
 * with them applied. Writes made by awaiting, or under O_SYNC, are flushed
 * as each is made, so a write's answer is what the mount did.
 */
class MountedDescription implements Description {
  readonly ino: number;
  readonly mounted = true as const;
  declare readonly awaits?: true;
  /** The file's backend operations, where the open's lookup landed (CompositeVFS.pin). */
  private readonly files: PinnedFiles;
  /** The path they are handed. */
  private readonly at: string;
  private readonly immediate: boolean;
  private inPlace = true;
  private pending: Held[] = [];
  private held = 0;

  constructor(private readonly options: MountedDescriptionOptions, private readonly pinned: PinnedFile, stat: VfsStat) {
    this.ino = stat.ino ?? 0;
    if (pinned.awaits) this.awaits = true;
    this.files = pinned.files;
    this.at = pinned.path;
    this.immediate = options.sync || pinned.awaits;
  }

  /** The namespace's name for it, when it was opened. */
  path(): string { return this.pinned.name; }
  /** Which file it is (PinnedFile.key): whose held writes this process's reads of it overlay (processView). */
  key(): string { return this.pinned.key; }

  stat(): Awaitable<RuntimeVfsStat> {
    return andThen(this.files.stat(this.at), (there) => {
      if (there === null) throw this.options.refuse('ENOENT', 'fstat');
      const now = runtimeStatOf(there);
      return andThen(this.viewed(), (view) => (view ? { ...now, size: view.byteLength } : now));
    });
  }

  read(offset: number, length: number): Awaitable<Uint8Array> {
    const view = this.viewed();
    if (view === undefined) return readRangeOrWhole(this.files, this.at, offset, length);
    return andThen(view, (bytes) => (bytes ? bytes.slice(offset, offset + length) : readRangeOrWhole(this.files, this.at, offset, length)));
  }

  write(offset: number, bytes: Uint8Array): Awaitable<number> {
    const written = this.inPlaceAt(offset, bytes);
    if (written === undefined) return this.hold(offset, bytes);
    return isPromise(written) ? written.then((end) => (end === undefined ? this.hold(offset, bytes) : bytes.byteLength)) : bytes.byteLength;
  }

  /** At the end as it is then (answers that end); a held one goes at the end as it stands at the flush. */
  append(bytes: Uint8Array): Awaitable<number> {
    if (!this.inPlace) return this.heldAppend(bytes);
    return andThen(this.files.stat(this.at), (there) => {
      const written = this.inPlaceAt(there?.size ?? 0, bytes);
      if (written === undefined) return this.heldAppend(bytes);
      return isPromise(written) ? written.then((end) => end ?? this.heldAppend(bytes)) : written;
    });
  }

  truncate(size: number): Awaitable<void> { return need(this.files.truncate, this.options.refuse, 'ftruncate').call(this.files, this.at, size); }
  readdir(): Awaitable<{ name: string; type: VfsDirentType }[]> {
    return andThen(this.files.readdir(this.at), (entries) => entries.map((entry) => ({ name: entry.name, type: entry.type })));
  }
  chmod(mode: number): Awaitable<void> { return need(this.files.chmod, this.options.refuse, 'fchmod').call(this.files, this.at, mode); }
  chown(uid: number, gid: number): Awaitable<void> { return need(this.files.chown, this.options.refuse, 'fchown').call(this.files, this.at, uid, gid); }
  utimes(atime: number, mtime: number): Awaitable<void> { return need(this.files.utimes, this.options.refuse, 'futimes').call(this.files, this.at, atime, mtime); }

  /** A flush that fails loses what it held (lastClose says so): taken before it reads. */
  flush(): Awaitable<void> {
    if (this.pending.length === 0) return;
    const writes = this.pending;
    this.pending = [];
    this.held = 0;
    return andThen(this.whole(), (file) => this.files.writeFile(this.at, apply(writes, file)));
  }

  close(): Awaitable<void> { return this.flush(); }
  pendingBytes(): number { return this.held; }
  applyPending(file: Uint8Array): Uint8Array { return apply(this.pending, file); }

  private whole(): Awaitable<Uint8Array> {
    return andThen(this.files.stat(this.at), (there) => (there === null ? new Uint8Array(0) : this.files.readFile(this.at)));
  }

  private hold(offset: number | null, bytes: Uint8Array): Awaitable<number> {
    if (this.held + bytes.byteLength > this.options.bufferedWriteBytes) throw this.options.refuse('EFBIG', 'write');
    this.pending.push({ offset, bytes: bytes.slice() });
    this.held += bytes.byteLength;
    return this.immediate ? andThen(this.flush(), () => bytes.byteLength) : bytes.byteLength;
  }

  /**
   * This process's view of the file while it holds writes to it, by any of
   * its descriptions (processView): this one's own O_SYNC governs only its
   * writes.
   */
  private viewed(): Awaitable<Uint8Array | undefined> {
    return processView(this.options.scope, this.pinned);
  }

  private heldAppend(bytes: Uint8Array): Awaitable<number> {
    return andThen(this.hold(null, bytes), () => andThen(this.stat(), (now) => now.size));
  }

  /**
   * `bytes` written in place at `offset` when the mount can (writeRange):
   * the end written. Undefined from its first refusal (none, or ENOTSUP):
   * the description holds its writes from then on.
   */
  private inPlaceAt(offset: number, bytes: Uint8Array): Awaitable<number | undefined> {
    const writeRange = this.files.writeRange;
    if (!this.inPlace || writeRange === undefined) {
      this.inPlace = false;
      return undefined;
    }
    let written: Awaitable<void>;
    try {
      written = writeRange.call(this.files, this.at, offset, bytes);
    } catch (error) {
      return this.cannot(error);
    }
    const end = offset + bytes.byteLength;
    return isPromise(written) ? written.then(() => end, (error: unknown) => this.cannot(error)) : end;
  }

  private cannot(error: unknown): undefined {
    if (!isVfsError(error, 'ENOTSUP')) throw error;
    this.inPlace = false;
    return undefined;
  }
}

/** `file` with `writes` applied in order (an append at the end as it then is): what a flush writes, and what a process reads. */
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

/** A mount's optional operation, or ENOTSUP when it has none. */
function need<F>(fn: F | undefined, refuse: Refuse, syscall: string): F {
  if (typeof fn !== 'function') throw refuse('ENOTSUP', syscall);
  return fn;
}
