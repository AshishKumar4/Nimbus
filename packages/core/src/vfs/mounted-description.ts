/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. Its operations go through
 * `files`, the namespace as the caller sees it: its synchronous face
 * (CompositeVFS.sync), which refuses an asynchronous mount at the first
 * lookup, before anything has changed; or the namespace itself.
 */

import { modeAllows } from '../runtime/beneath-walk.js';
import { processView, type Description, type DescriptorScope } from '../runtime/descriptors.js';
import type { RuntimeFileHandle, RuntimeVfsStat, VfsCred } from '../runtime/os-contracts.js';
import { runtimeStatOf } from './composite.js';
import { isPromise, readRangeOrWhole, then, type Awaitable, type VFS, type VfsStat } from './vfs.js';
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
  cred: VfsCred;
  refuse: Refuse;
  /** The mode a file this open makes is made with. */
  mode?: number;
}

/**
 * open(2) of `name`, one rule for every caller, Linux's where Linux and
 * POSIX differ: O_CREAT|O_EXCL is EEXIST on the name itself, a link
 * included; O_NOFOLLOW of a link is ELOOP; an absent name without O_CREAT is
 * ENOENT, and with O_DIRECTORY EINVAL; O_DIRECTORY of anything else is
 * ENOTDIR; a directory refuses O_TRUNC and O_APPEND (EISDIR); the access
 * asked is checked against the file's mode (EACCES); and only then is the
 * file made (whatever its mode, as creat(2) makes it) or truncated. Answers
 * the file's stat. `describes`: whether the open keeps a description, whose
 * write rights a directory may carry (a WASI guest asks a capability set);
 * an open that keeps none (a wave's) is an open to write, which a directory
 * refuses. `settled` runs right before the answer, or the change.
 */
export function openOnMount(open: MountedOpen, describes: boolean, settled?: () => Awaitable<void>): Awaitable<VfsStat> {
  const { files, name, flags, refuse } = open;
  return then(files.stat(name, { follow: false }), (named) => {
    if (named !== null && flags.create && flags.exclusive) throw refuse('EEXIST', 'open');
    if (named?.type === 'symlink' && !flags.followSymlinks) throw refuse('ELOOP', 'open');
    return then(named?.type === 'symlink' ? files.stat(name) : named, (there) => {
      if (there === null) {
        if (!flags.create) throw refuse('ENOENT', 'open');
        if (flags.directory) throw refuse('EINVAL', 'open');
      } else {
        if (flags.directory && there.type !== 'directory') throw refuse('ENOTDIR', 'open');
        if (there.type === 'directory' && (flags.truncate || flags.append || (flags.write && !describes))) throw refuse('EISDIR', 'open');
        if (!modeAllows(there, (flags.read ? 4 : 0) | (flags.write && there.type !== 'directory' ? 2 : 0), open.cred)) throw refuse('EACCES', 'open');
      }
      return then(settled?.(), () => {
        if (there !== null && !flags.truncate) return there;
        const changed = there === null
          ? files.writeFile(name, new Uint8Array(0), open.mode === undefined ? undefined : { mode: open.mode })
          : need(files.truncate, refuse, 'open').call(files, name, 0);
        return then(changed, () => then(files.stat(name), (after) => {
          if (after === null) throw refuse('ENOENT', 'open');
          return after;
        }));
      });
    });
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
  return then(openOnMount(options, true), (stat) => then(options.realpath(options.name), (file) => mountedDescription({ ...options, name: file }, stat)));
}

/**
 * The description of `name` on a mount. A write goes in place (writeRange);
 * on a mount that cannot (none, or ENOTSUP), the description holds its
 * writes, at most `bufferedWriteBytes` (EFBIG past it, nothing held), and a
 * flush (fsync, the last close, the process's release) reads the file,
 * applies them in order and writes it back; this process reads the file
 * with them applied. Writes made by awaiting, or under O_SYNC, are flushed
 * as each is made, so a write's answer is what the mount did.
 */
function mountedDescription(options: MountedDescriptionOptions, stat: VfsStat): Description {
  const { files, name, refuse, scope } = options;
  const immediate = options.sync || options.awaits;
  let inPlace = true;
  let pending: { offset: number | null; bytes: Uint8Array }[] = [];
  let held = 0;
  const whole = (): Awaitable<Uint8Array> => then(files.stat(name), (there) => (there === null ? new Uint8Array(0) : files.readFile(name)));
  // `file` with the pending writes applied in order (an append at the end
  // as it then is): what a flush writes, and what this process reads.
  const applyPending = (base: Uint8Array): Uint8Array => {
    // A copy: a backend may hand out its own buffer, which must not change before the flush.
    let file = base.slice();
    for (const write of pending) {
      const at = write.offset ?? file.byteLength;
      if (at + write.bytes.byteLength > file.byteLength) {
        const grown = new Uint8Array(at + write.bytes.byteLength);
        grown.set(file);
        file = grown;
      }
      file.set(write.bytes, at);
    }
    return file;
  };
  const flush = (): Awaitable<void> => {
    if (pending.length === 0) return;
    return then(whole(), (file) => {
      const next = applyPending(file);
      pending = [];
      held = 0;
      return files.writeFile(name, next);
    });
  };
  const hold = (offset: number | null, bytes: Uint8Array): Awaitable<number> => {
    if (held + bytes.byteLength > options.bufferedWriteBytes) throw refuse('EFBIG', 'write');
    pending.push({ offset, bytes: bytes.slice() });
    held += bytes.byteLength;
    return immediate ? then(flush(), () => bytes.byteLength) : bytes.byteLength;
  };
  // This process's view of the file while it holds writes to it (processView).
  const viewed = (): Uint8Array | undefined => (inPlace || immediate ? undefined : processView(scope, () => {
    const file = whole();
    return isPromise(file) ? null : file;
  }, name));
  const write = (offset: number, bytes: Uint8Array): Awaitable<number> => {
    if (!inPlace || files.writeRange === undefined) {
      inPlace = false;
      return hold(offset, bytes);
    }
    const cannot = (error: unknown): Awaitable<number> => {
      if (!isVfsError(error, 'ENOTSUP')) throw error;
      inPlace = false;
      return hold(offset, bytes);
    };
    let written: Awaitable<void>;
    try {
      written = files.writeRange(name, offset, bytes);
    } catch (error) {
      return cannot(error);
    }
    return isPromise(written) ? written.then(() => bytes.byteLength, cannot) : bytes.byteLength;
  };
  const statNow = (): Awaitable<RuntimeVfsStat> => then(files.stat(name), (there) => {
    if (there === null) throw refuse('ENOENT', 'fstat');
    const now = runtimeStatOf(there);
    const view = viewed();
    return view ? { ...now, size: view.byteLength } : now;
  });
  const op = <A extends unknown[]>(fn: ((path: string, ...args: A) => Awaitable<void>) | undefined, syscall: string) =>
    (...args: A): Awaitable<void> => need(fn, refuse, syscall).call(files, name, ...args);
  return {
    ino: stat.ino ?? 0,
    mounted: true,
    ...(options.awaits ? { awaits: true as const } : {}),
    path: () => name,
    stat: statNow,
    read: (offset, length) => {
      const view = viewed();
      return view ? view.slice(offset, offset + length) : readRangeOrWhole(files, name, offset, length);
    },
    write,
    // At the end as it is then: a held append goes at the end as it stands at the flush.
    append: (bytes) => then(inPlace ? then(files.stat(name), (there) => write(there?.size ?? 0, bytes)) : hold(null, bytes), () => then(statNow(), (now) => now.size)),
    truncate: op(files.truncate, 'ftruncate'),
    readdir: () => then(files.readdir(name), (entries) => entries.map((entry) => ({ name: entry.name, type: entry.type }))),
    chmod: op(files.chmod, 'fchmod'),
    chown: op(files.chown, 'fchown'),
    utimes: op(files.utimes, 'futimes'),
    flush,
    close: flush,
    pendingBytes: () => held,
    applyPending,
  };
}

/** A mount's optional operation, or ENOTSUP when it has none. */
function need<F>(fn: F | undefined, refuse: Refuse, syscall: string): F {
  if (typeof fn !== 'function') throw refuse('ENOTSUP', syscall);
  return fn;
}
