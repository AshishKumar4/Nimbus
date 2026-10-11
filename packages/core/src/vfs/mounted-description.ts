/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. Its operations go through
 * `files`, the namespace as the caller sees it: its synchronous face
 * (CompositeVFS.sync), which refuses an asynchronous mount at the first
 * lookup, before anything has changed; or the namespace itself.
 */

import { processView, type Description, type DescriptorScope } from '../runtime/descriptors.js';
import type { RuntimeFileHandle, RuntimeVfsStat } from '../runtime/os-contracts.js';
import { runtimeStatOf } from './composite.js';
import { andThen, isPromise, readRangeOrWhole, type Awaitable, type VFS, type VfsDirentType, type VfsStat } from './vfs.js';
import { isVfsError } from './vfs-error.js';

/** What one description holds unwritten before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export const BUFFERED_WRITE_BYTES = 8 * 1024 * 1024;

/** How the caller names a refusal: `code`, for its call `syscall` (open, write, ftruncate, …). */
export type Refuse = (code: string, syscall: string) => Error;

export interface MountedOpen {
  files: VFS;
  /** The name opened, in the namespace. */
  name: string;
  flags: RuntimeFileHandle['flags'];
  refuse: Refuse;
  /** The mode a file this open makes is made with. */
  mode?: number;
}

/**
 * open(2) of `name`, one rule for every caller, Linux's where Linux and
 * POSIX differ: O_CREAT|O_EXCL is EEXIST on the name itself, a link
 * included; O_NOFOLLOW of a link is ELOOP; an absent name without O_CREAT is
 * ENOENT, and with O_DIRECTORY EINVAL; O_DIRECTORY of anything else is
 * ENOTDIR; a directory refuses O_TRUNC and O_APPEND (EISDIR); and only
 * then is the file made, or truncated. Answers the file's stat. Who may
 * open a file for what is the mount's own policy, as for every operation on
 * it: a backend that takes a caller's credential (VFS.as) enforces modes; a
 * backend of one identity has none. `describes`: whether the open keeps a description, whose
 * write rights a directory may carry (a WASI guest asks a capability set);
 * an open that keeps none (a wave's) is an open to write, which a directory
 * refuses. `settled` runs right before the answer, or the change.
 */
export function openOnMount(open: MountedOpen, describes: boolean, settled?: () => Awaitable<void>): Awaitable<VfsStat> {
  const { files, name, flags, refuse } = open;
  return andThen(files.stat(name, { follow: false }), (named) => {
    if (named !== null && flags.create && flags.exclusive) throw refuse('EEXIST', 'open');
    if (named?.type === 'symlink' && !flags.followSymlinks) throw refuse('ELOOP', 'open');
    return andThen(named?.type === 'symlink' ? files.stat(name) : named, (there) => {
      if (there === null) {
        if (!flags.create) throw refuse('ENOENT', 'open');
        if (flags.directory) throw refuse('EINVAL', 'open');
      } else {
        if (flags.directory && there.type !== 'directory') throw refuse('ENOTDIR', 'open');
        if (there.type === 'directory' && (flags.truncate || flags.append || (flags.write && !describes))) throw refuse('EISDIR', 'open');
      }
      return andThen(settled?.(), () => {
        if (there !== null && !flags.truncate) return there;
        if (there !== null) {
          // A description needs only the file's inode, which truncating keeps; a wave answers the stat after.
          const truncated = need(files.truncate, refuse, 'open').call(files, name, 0);
          return describes ? andThen(truncated, () => there) : andThen(truncated, () => statAfter(open));
        }
        return andThen(files.writeFile(name, new Uint8Array(0), open.mode === undefined ? undefined : { mode: open.mode }), () => statAfter(open));
      });
    });
  });
}

function statAfter({ files, name, refuse }: MountedOpen): Awaitable<VfsStat> {
  return andThen(files.stat(name), (after) => {
    if (after === null) throw refuse('ENOENT', 'open');
    return after;
  });
}

export interface MountedDescriptionOptions extends MountedOpen {
  /** The descriptors' scope: whose pending writes this process reads (processView). */
  scope: DescriptorScope;
  /** Where the opened name leads, every link resolved: the file the description holds, wherever its name is repointed. */
  realpath(name: string): Awaitable<string>;
  /** `files` answers only by awaiting (the namespace itself, for an asynchronous mount). */
  awaits: boolean;
  /** O_SYNC: each write in the mount before it returns. */
  sync: boolean;
  /** What a description holds unwritten before a write is EFBIG. */
  bufferedWriteBytes: number;
}

/** open(2) of a mounted file, and the description its descriptors share. */
export function openMounted(options: MountedDescriptionOptions): Awaitable<Description> {
  return andThen(openOnMount(options, true), (stat) => andThen(options.realpath(options.name), (file) => new MountedDescription({ ...options, name: file }, stat)));
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
  private readonly files: VFS;
  private readonly name: string;
  private readonly immediate: boolean;
  private inPlace = true;
  private pending: Held[] = [];
  private held = 0;

  constructor(private readonly options: MountedDescriptionOptions, stat: VfsStat) {
    this.ino = stat.ino ?? 0;
    if (options.awaits) this.awaits = true;
    this.files = options.files;
    this.name = options.name;
    this.immediate = options.sync || options.awaits;
  }

  path(): string { return this.name; }

  stat(): Awaitable<RuntimeVfsStat> {
    return andThen(this.files.stat(this.name), (there) => {
      if (there === null) throw this.options.refuse('ENOENT', 'fstat');
      const now = runtimeStatOf(there);
      const view = this.viewed();
      return view ? { ...now, size: view.byteLength } : now;
    });
  }

  read(offset: number, length: number): Awaitable<Uint8Array> {
    const view = this.viewed();
    return view ? view.slice(offset, offset + length) : readRangeOrWhole(this.files, this.name, offset, length);
  }

  write(offset: number, bytes: Uint8Array): Awaitable<number> {
    return andThen(this.inPlaceOr(offset, bytes, () => this.hold(offset, bytes)), () => bytes.byteLength);
  }

  /** At the end as it is then; a held one goes at the end as it stands at the flush. */
  append(bytes: Uint8Array): Awaitable<number> {
    const held = (): Awaitable<number> => andThen(this.hold(null, bytes), () => andThen(this.stat(), (now) => now.size));
    return this.inPlace ? andThen(this.files.stat(this.name), (there) => this.inPlaceOr(there?.size ?? 0, bytes, held)) : held();
  }

  truncate(size: number): Awaitable<void> { return need(this.files.truncate, this.options.refuse, 'ftruncate').call(this.files, this.name, size); }
  readdir(): Awaitable<{ name: string; type: VfsDirentType }[]> {
    return andThen(this.files.readdir(this.name), (entries) => entries.map((entry) => ({ name: entry.name, type: entry.type })));
  }
  chmod(mode: number): Awaitable<void> { return need(this.files.chmod, this.options.refuse, 'fchmod').call(this.files, this.name, mode); }
  chown(uid: number, gid: number): Awaitable<void> { return need(this.files.chown, this.options.refuse, 'fchown').call(this.files, this.name, uid, gid); }
  utimes(atime: number, mtime: number): Awaitable<void> { return need(this.files.utimes, this.options.refuse, 'futimes').call(this.files, this.name, atime, mtime); }

  /** A flush that fails loses what it held (lastClose says so): taken before it reads. */
  flush(): Awaitable<void> {
    if (this.pending.length === 0) return;
    const writes = this.pending;
    this.pending = [];
    this.held = 0;
    return andThen(this.whole(), (file) => this.files.writeFile(this.name, apply(writes, file)));
  }

  close(): Awaitable<void> { return this.flush(); }
  pendingBytes(): number { return this.held; }
  applyPending(file: Uint8Array): Uint8Array { return apply(this.pending, file); }

  private whole(): Awaitable<Uint8Array> {
    return andThen(this.files.stat(this.name), (there) => (there === null ? new Uint8Array(0) : this.files.readFile(this.name)));
  }

  private hold(offset: number | null, bytes: Uint8Array): Awaitable<number> {
    if (this.held + bytes.byteLength > this.options.bufferedWriteBytes) throw this.options.refuse('EFBIG', 'write');
    this.pending.push({ offset, bytes: bytes.slice() });
    this.held += bytes.byteLength;
    return this.immediate ? andThen(this.flush(), () => bytes.byteLength) : bytes.byteLength;
  }

  /** This process's view of the file while it holds writes to it, by any of its descriptions (processView). */
  private viewed(): Uint8Array | undefined {
    if (this.immediate) return undefined;
    return processView(this.options.scope, () => {
      const file = this.whole();
      return isPromise(file) ? null : file;
    }, this.name);
  }

  /** In place when the mount can (writeRange); from its first refusal (none, or ENOTSUP), `otherwise`. Answers the end written. */
  private inPlaceOr(offset: number, bytes: Uint8Array, otherwise: () => Awaitable<number>): Awaitable<number> {
    const writeRange = this.files.writeRange;
    if (!this.inPlace || writeRange === undefined) {
      this.inPlace = false;
      return otherwise();
    }
    const cannot = (error: unknown): Awaitable<number> => {
      if (!isVfsError(error, 'ENOTSUP')) throw error;
      this.inPlace = false;
      return otherwise();
    };
    let written: Awaitable<void>;
    try {
      written = writeRange.call(this.files, this.name, offset, bytes);
    } catch (error) {
      return cannot(error);
    }
    return isPromise(written) ? written.then(() => offset + bytes.byteLength, cannot) : offset + bytes.byteLength;
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
