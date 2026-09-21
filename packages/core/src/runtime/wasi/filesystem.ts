import type { Awaitable, RuntimeFileHandle, RuntimeFsBridge, RuntimeFsPath, RuntimeSynchronousFs, RuntimeVfsStat } from '../os-contracts.js';
import type { SyscallResult, Errno, WasiImports } from './types.js';

/** WASI encoding only. Paths, permissions, inode identity and storage belong to fs. */
export interface AuthorityFd {
  kind: 'authority';
  handle: RuntimeFileHandle;
  type: 'file' | 'directory' | 'symlink';
  rights: bigint;
  rightsInheriting: bigint;
  fdflags: number;
  entries?: { name: string; type: string }[];
}
/**
 * A read-only open of a regular file, answered from this isolate: the bytes
 * are the file's content at its stat revision, so every read, seek and stat on
 * the descriptor is local. Nothing on the authority side is held for it.
 */
export interface ResidentFd {
  kind: 'resident';
  stat: RuntimeVfsStat;
  bytes: Uint8Array;
  position: number;
  rights: bigint;
  rightsInheriting: bigint;
  fdflags: number;
}
export interface AuthorityPreopen {
  kind: 'preopen';
  vfsPath: string;
  wasiPath: string;
  rights?: bigint;
  rightsInheriting?: bigint;
}
export type FilesystemFd = AuthorityFd | ResidentFd | AuthorityPreopen | { kind: 'stdin' | 'stdout' | 'stderr' | 'file' | 'dir' | 'socket' | 'listener' | 'pipe' };
export type FilesystemImports = Pick<WasiImports,
  | 'path_open'
  | 'path_filestat_get'
  | 'fd_filestat_get'
  | 'fd_read'
  | 'fd_pread'
  | 'fd_write'
  | 'fd_pwrite'
  | 'fd_close'
  | 'fd_renumber'
  | 'fd_seek'
  | 'fd_tell'
  | 'fd_fdstat_get'
  | 'fd_fdstat_set_flags'
  | 'fd_fdstat_set_rights'
  | 'fd_filestat_set_size'
  | 'fd_sync'
  | 'fd_datasync'
  | 'fd_allocate'
  | 'fd_advise'
  | 'fd_readdir'
  | 'path_create_directory'
  | 'path_remove_directory'
  | 'path_unlink_file'
  | 'path_rename'
  | 'path_symlink'
  | 'path_readlink'
  | 'path_link'
  | 'fd_filestat_set_times'
  | 'path_filestat_set_times'
>;
/**
 * Synthetic paths that name a socket rather than a file, and the one place
 * their spelling lives — the codec recognises them to hand them back, the host
 * recognises them to open them, and a second literal would let the two drift.
 *
 * No filesystem holds any of them, so a path_open naming one belongs to the
 * host's own socket bodies.
 */
/** Dial: mirrors bash's /dev/tcp/<host>/<port> redirection convention. */
export const WASI_TCP_PATH_PREFIX = '/dev/tcp/';
/**
 * Listen, as a descriptor. Reading it is accept(2): the read suspends until a
 * connection is queued and yields that connection's id, so a server's accept
 * loop is an ordinary blocking read with no cooperative pump behind it.
 */
export const WASI_LISTEN_PATH_PREFIX = '/dev/nimbus/listen/';
/**
 * The accept half of the dial: binds a connection the kernel has already
 * accepted to a descriptor. It goes through path_open like the dial half
 * because guests layered over wasi-vfs (ruby.wasm) resolve descriptors through
 * their own fd table, so one handed to them out of band is unusable.
 */
export const WASI_ACCEPTED_PATH_PREFIX = '/dev/nimbus/socket/';
const socketPathPrefixes: readonly string[] = [WASI_TCP_PATH_PREFIX, WASI_LISTEN_PATH_PREFIX, WASI_ACCEPTED_PATH_PREFIX];
type Fs = RuntimeFsBridge | RuntimeSynchronousFs;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const errno: Record<string, Errno> = {
  EACCES: 2, EAGAIN: 6, EBADF: 8, EBUSY: 10, EEXIST: 20, EFAULT: 21,
  EFBIG: 22, EINTR: 27, EINVAL: 28, EIO: 29, EISDIR: 31, ELOOP: 32,
  EMFILE: 33, ENAMETOOLONG: 37, ENFILE: 41, ENOENT: 44, ENOMEM: 48,
  ENOSPC: 51, ENOSYS: 52, ENOTDIR: 54, ENOTEMPTY: 55, ENOTSUP: 58,
  EPERM: 63, EPIPE: 64, EROFS: 69, ESPIPE: 70, ESTALE: 72, EXDEV: 75,
  ENOTCAPABLE: 76,
};
export function filesystemErrno(error: unknown): Errno {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return errno[error.code] ?? errno.EIO;
  if (error instanceof RangeError) return errno.EFAULT;
  return errno.EIO;
}
export function after<T, R>(value: Awaitable<T>, next: (value: T) => Awaitable<R>): Awaitable<R> {
  return value instanceof Promise ? value.then(next) : next(value);
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const ft = (type: string) => type === 'directory' ? 3 : type === 'symlink' ? 7 : 4;
const num = (value: number | bigint): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) fail('EINVAL');
  return n;
};

export interface AuthorityFilesystemOptions {
  fs(): RuntimeFsBridge | null;
  memory(): WebAssembly.Memory;
  fds: Map<number, FilesystemFd>;
  allocateFd(): number;
  abi?: 'preview0' | 'preview1';
  synchronous: boolean;
  /** The guest's live umask when its process can move it after boot (bash's `umask` builtin). */
  umask?(): number;
  /**
   * Largest regular file a read-only open answers from a resident copy. A
   * guest that reopens the same file for every module (CPython's zipimport,
   * a shell's scripts) then pays one stat per open and one read per revision,
   * rather than a round trip per descriptor call. Content is keyed by inode
   * and validated against the stat revision, so a file rewritten by anyone
   * is fetched again on its next open. Zero keeps every open on the authority.
   */
  residentBytes?: number;
}

/** Installs the same filesystem codec in the generic WASI and Bash fd domains. */
export function installAuthorityFilesystem(imports: Partial<FilesystemImports>, options: AuthorityFilesystemOptions): asserts imports is FilesystemImports {
  const fds = options.fds;
  // Captured before the codec replaces it: closing a pipe, a socket or a
  // stdio fd is the host's business, and fd_renumber over one has to go
  // through its semantics rather than dropping the entry.
  const hostClose = imports.fd_close;
  const memory = () => new Uint8Array(options.memory().buffer);
  const view = () => new DataView(options.memory().buffer);
  const u32 = (ptr: number, value: number) => view().setUint32(ptr, value, true);
  const u64 = (ptr: number, value: bigint | number) => view().setBigUint64(ptr, BigInt(value), true);
  const path = (ptr: number, length: number): string => {
    if (ptr < 0 || length < 0 || ptr + length > memory().length) fail('EFAULT');
    const p = decoder.decode(memory().subarray(ptr, ptr + length));
    if (p.includes('\0')) fail('EINVAL');
    return p;
  };
  const fs = (): Fs => {
    const authority = options.fs();
    if (!authority) fail('ENOSYS');
    if (options.synchronous) {
      if (!authority.synchronous) fail('ENOTSUP');
      return authority.synchronous;
    }
    return authority;
  };
  const entry = (fd: number): AuthorityFd | ResidentFd => {
    const e = fds.get(fd);
    if (!e || (e.kind !== 'authority' && e.kind !== 'resident')) fail('EBADF');
    return e;
  };
  // The ops that need a live descriptor on the authority. A resident copy has
  // none, and a read-only open never asked for the rights they check.
  const handle = (fd: number): AuthorityFd => {
    const e = entry(fd);
    if (e.kind !== 'authority') fail('ENOTCAPABLE');
    return e;
  };
  // Content by inode, valid while the stat revision matches the one it was read at.
  const resident = new Map<string, { revision: number; bytes: Uint8Array }>();
  const residentBytes = options.residentBytes ?? 0;
  const residentContent = (fs: Fs, target: RuntimeFsPath, st: RuntimeVfsStat): Awaitable<Uint8Array> => {
    const key = `${st.dev}:${st.ino}`;
    const cached = resident.get(key);
    if (cached && cached.revision === st.revision) return cached.bytes;
    return after(fs.readFile(target), bytes => {
      if (bytes === null) fail('ENOENT');
      resident.set(key, { revision: st.revision, bytes });
      return bytes;
    });
  };
  const preopen = (fd: number): AuthorityPreopen | null => {
    const e = fds.get(fd);
    return e?.kind === 'preopen' ? e : null;
  };
  // wasi-libc resolves a path against its longest matching preopen and passes
  // only the remainder, so deciding whether the guest named a socket means
  // rebuilding the absolute path exactly as the host's path_open does.
  const socketPath = (fd: number, ptr: number, length: number): boolean => {
    let guest: string;
    // A path this codec cannot decode is its own to reject, with the errno its
    // body would have produced.
    try { guest = path(ptr, length); } catch { return false; }
    const base = fds.get(fd);
    if (!guest.startsWith('/') && base?.kind === 'preopen') {
      guest = base.wasiPath.endsWith('/') ? base.wasiPath + guest : base.wasiPath + '/' + guest;
    }
    return socketPathPrefixes.some(prefix => guest.startsWith(prefix));
  };
  const at = (fd: number, p: string): RuntimeFsPath => {
    if (p.startsWith('/')) fail('ENOTCAPABLE');
    const e = fds.get(fd);
    if (e?.kind === 'preopen') return { root: e.vfsPath, path: underPreopen(e, p), beneath: true };
    const opened = entry(fd);
    if (opened.kind !== 'authority' || opened.type !== 'directory') fail('ENOTDIR');
    return { directory: opened.handle.id, path: p, beneath: true };
  };
  // A compiled program's `/` is the shell's cwd, so wasi-libc hands an
  // absolute guest path back as `home/user/x` against that preopen: the
  // program meant the same file the shell calls /home/user/x, not the
  // subtree home/user/home/user. The re-stated root is stripped at a segment
  // boundary; `home/userfoo` is a different directory and is left alone.
  const underPreopen = (e: AuthorityPreopen, p: string): string => {
    const root = e.vfsPath;
    if (root.length === 0) return p;
    if (p === root) return '';
    return p.startsWith(root) && p.charCodeAt(root.length) === 47 ? p.slice(root.length + 1) : p;
  };
  const right = (fd: number, bit: number) => {
    const e = entry(fd);
    if (!(e.rights & (1n << BigInt(bit)))) fail('ENOTCAPABLE');
    return e;
  };
  const creationMode = (base: number): number | undefined => options.umask ? base & ~options.umask() : undefined;
  const pathRight = (fd: number, bit: number) => {
    const e = preopen(fd) ?? entry(fd);
    if (!((e.rights ?? 0x1fffffffn) & (1n << BigInt(bit)))) fail('ENOTCAPABLE');
    return e;
  };
  const stat = (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number): Awaitable<RuntimeVfsStat> => {
    const p = preopen(fd);
    if (p) return after(fs.stat(p.vfsPath), value => value ?? fail('ENOENT'));
    const e = entry(fd);
    return e.kind === 'resident' ? e.stat : fs.fstat(e.handle.id);
  };
  const writeStat = (ptr: number, st: RuntimeVfsStat): Errno => {
    const dv = view(); const old = options.abi === 'preview0';
    memory().fill(0, ptr, ptr + (old ? 56 : 64));
    u64(ptr, st.dev); u64(ptr + 8, st.ino); dv.setUint8(ptr + 16, ft(st.type));
    if (old) u32(ptr + 20, Number(st.nlink)); else u64(ptr + 24, st.nlink);
    const base = old ? 24 : 32;
    u64(ptr + base, st.size);
    u64(ptr + base + 8, BigInt(Math.trunc(st.atime)) * 1000000n);
    u64(ptr + base + 16, BigInt(Math.trunc(st.mtime)) * 1000000n);
    u64(ptr + base + 24, BigInt(Math.trunc(st.ctime)) * 1000000n);
    return 0;
  };
  const guard = <A extends (number | bigint)[]>(
    previous: ((...args: A) => SyscallResult) | undefined,
    body: (fs: RuntimeFsBridge | RuntimeSynchronousFs, ...args: A) => SyscallResult,
    owns?: (args: A) => boolean,
  ): ((...args: A) => SyscallResult) => (...args) => {
    if (!options.fs() || (owns && !owns(args))) return previous ? previous(...args) : 52;
    try {
      const result = body(fs(), ...args);
      if (result instanceof Promise) {
        if (options.synchronous) throw new Error('Filesystem synchronous contract returned a Promise');
        return result.catch(filesystemErrno);
      }
      return result;
    } catch (error) { return filesystemErrno(error); }
  };
  const owns = (args: readonly (number | bigint)[]) => {
    const e = fds.get(Number(args[0])); return e?.kind === 'authority' || e?.kind === 'resident' || e?.kind === 'preopen';
  };
  const iovs = (ptr: number, count: number) => {
    if (ptr < 0 || count < 0 || count > Math.floor((memory().length - ptr) / 8)) fail('EFAULT');
    const result: { ptr: number; length: number }[] = []; let total = 0;
    for (let i = 0; i < count; i++) {
      const p = view().getUint32(ptr + i * 8, true), length = view().getUint32(ptr + i * 8 + 4, true);
      if (p + length > memory().length) fail('EFAULT');
      result.push({ ptr: p, length }); total += length;
    }
    return { result, total };
  };
  const scatter = (data: Uint8Array, vectors: { ptr: number; length: number }[]): number => {
    let used = 0;
    for (const v of vectors) { const n = Math.min(v.length, data.length - used); if (n <= 0) break; memory().set(data.subarray(used, used + n), v.ptr); used += n; }
    return used;
  };
  const read = (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, ptr: number, count: number, offset: number | null, written: number): SyscallResult => {
    // A directory has no byte stream: POSIX and the host body this took over
    // from both answer EISDIR, and they answer it before any rights check.
    const target = fds.get(fd);
    if (target?.kind === 'preopen' || (target?.kind === 'authority' && target.type === 'directory')) fail('EISDIR');
    const e = right(fd, 1), vectors = iovs(ptr, count);
    if (e.kind === 'resident') {
      const start = Math.min(offset ?? e.position, e.bytes.length);
      const used = scatter(e.bytes.subarray(start, Math.min(e.bytes.length, start + vectors.total)), vectors.result);
      if (offset === null) e.position = start + used;
      u32(written, used); return 0;
    }
    return after(fs.read(e.handle.id, offset, vectors.total), data => { u32(written, scatter(data, vectors.result)); return 0; });
  };
  const write = (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, ptr: number, count: number, offset: number | null, written: number): SyscallResult => {
    const e = right(fd, 6), vectors = iovs(ptr, count), data = new Uint8Array(vectors.total); let used = 0;
    if (e.kind === 'resident') fail('ENOTCAPABLE');
    for (const v of vectors.result) { data.set(memory().subarray(v.ptr, v.ptr + v.length), used); used += v.length; }
    return after(fs.write(e.handle.id, offset, data), n => { u32(written, n); return 0; });
  };
  imports.path_open = guard(imports.path_open, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, lookup: number, p: number, n: number, flags: number, rights: bigint, inherit: bigint, status: number, out: number) => {
    if (status & ~5) fail('ENOTSUP');
    pathRight(fd, 13);
    if (flags & 1) pathRight(fd, 10);
    if (flags & 8) pathRight(fd, 19);
    const target = at(fd, path(p, n));
    const parent = preopen(fd) ?? entry(fd);
    const requested = BigInt(rights), childRights = BigInt(inherit);
    const allowed = parent.rightsInheriting;
    if (allowed !== undefined && ((requested | childRights) & ~allowed)) fail('ENOTCAPABLE');
    const followSymlinks = !!(lookup & 1);
    // Rights that change the file keep the open on the authority: fd_write,
    // fd_allocate, fd_filestat_set_size. wasi-libc asks for sync and status
    // rights on every open, and a resident copy answers those itself.
    const readOnly = !(requested & ((1n << 6n) | (1n << 8n) | (1n << 22n))) && !(flags & 15) && !(status & 1);
    const open = (): SyscallResult => after(fs.open(target, { read: !!(requested & 2n), write: !!(requested & 64n), append: !!(status & 1),
      create: !!(flags & 1), directory: !!(flags & 2), exclusive: !!(flags & 4), truncate: !!(flags & 8), followSymlinks,
      mode: creationMode(0o666) }), handle =>
      after(fs.fstat(handle.id), st => {
        const id = options.allocateFd();
        fds.set(id, { kind: 'authority', handle, type: st.type, rights: requested, rightsInheriting: childRights, fdflags: status });
        u32(out, id); return 0;
      }));
    if (!readOnly || residentBytes === 0) return open();
    return after(fs.stat(target, { followSymlinks }), st => {
      if (st === null) fail('ENOENT');
      if (st.type !== 'file' || st.size > residentBytes) return open();
      // A hit needs no permission check of its own: the copy was read under
      // this credential, and a chmod or chown since would have moved the
      // revision along with any rewrite.
      return after(residentContent(fs, target, st), bytes => {
        const id = options.allocateFd();
        fds.set(id, { kind: 'resident', stat: st, bytes, position: 0, rights: requested, rightsInheriting: childRights, fdflags: status });
        u32(out, id); return 0;
      });
    });
  }, args => !socketPath(args[0], args[2], args[3]));
  imports.path_filestat_get = guard(imports.path_filestat_get, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, flags: number, p: number, n: number, out: number) =>
    { pathRight(fd, 18); return after(fs.stat(at(fd, path(p, n)), { followSymlinks: !!(flags & 1) }), st => writeStat(out, st ?? fail('ENOENT'))); });
  imports.fd_filestat_get = guard(imports.fd_filestat_get, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, out: number) => { pathRight(fd, 21); return after(stat(fs, fd), st => writeStat(out, st)); }, owns);
  imports.fd_read = guard(imports.fd_read, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number, out: number) => read(fs, fd, p, n, null, out), owns);
  imports.fd_pread = guard(imports.fd_pread, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number, off: bigint, out: number) => read(fs, fd, p, n, num(off), out), owns);
  imports.fd_write = guard(imports.fd_write, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number, out: number) => write(fs, fd, p, n, null, out), owns);
  imports.fd_pwrite = guard(imports.fd_pwrite, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number, off: bigint, out: number) => write(fs, fd, p, n, num(off), out), owns);
  imports.fd_close = guard(imports.fd_close, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number) => {
    // A preopen is the root every path resolves against. Dropping it leaves
    // the guest nothing to open, so it survives the close, as in the host body.
    if (preopen(fd)) return 0;
    const e = entry(fd);
    if (e.kind === 'resident') { fds.delete(fd); return 0; }
    return after(fs.close(e.handle.id), () => { fds.delete(fd); return 0; });
  }, owns);
  imports.fd_renumber = guard(imports.fd_renumber, (fs: RuntimeFsBridge | RuntimeSynchronousFs, from: number, to: number) => {
    const source = fds.get(from);
    if (!source) fail('EBADF');
    if (from === to) return 0;
    const target = fds.get(to);
    if (target?.kind === 'preopen') fail('ENOTCAPABLE');
    // dup2 closes what it lands on, and only the owner of that fd knows how:
    // a socket's stream and a pipe's writer count are the host's to release.
    const released = !target || target.kind === 'resident' ? undefined
      : target.kind === 'authority' ? fs.close(target.handle.id)
      : hostClose?.(to);
    return after(released, () => {
      fds.delete(from);
      fds.set(to, source);
      return 0;
    });
  }, args => owns(args) || owns([args[1]]));
  imports.fd_seek = guard(imports.fd_seek, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, offset: bigint, whence: number, out: number) => {
    const kind = options.abi === 'preview0' ? (whence === 2 ? 'set' : whence === 0 ? 'current' : whence === 1 ? 'end' : null)
      : whence === 0 ? 'set' : whence === 1 ? 'current' : whence === 2 ? 'end' : null;
    if (kind === null) fail('EINVAL');
    const e = right(fd, 2);
    if (e.kind === 'resident') {
      const base = kind === 'set' ? 0 : kind === 'current' ? e.position : e.bytes.length;
      const pos = base + num(offset);
      if (pos < 0) fail('EINVAL');
      e.position = pos; u64(out, pos); return 0;
    }
    return after(fs.seek(e.handle.id, num(offset), kind), pos => { u64(out, pos); return 0; });
  }, owns);
  imports.fd_tell = guard(imports.fd_tell, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, out: number) => {
    const e = right(fd, 5);
    if (e.kind === 'resident') { u64(out, e.position); return 0; }
    return after(fs.seek(e.handle.id, 0, 'current'), pos => { u64(out, pos); return 0; });
  }, owns);
  imports.fd_fdstat_get = guard(imports.fd_fdstat_get, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, out: number) => {
    const e = preopen(fd) ?? entry(fd);
    memory().fill(0, out, out + 24); view().setUint8(out, e.kind === 'preopen' ? 3 : e.kind === 'resident' ? 4 : ft(e.type));
    view().setUint16(out + 2, e.kind === 'preopen' ? 0 : e.fdflags, true);
    u64(out + 8, e.rights ?? 0x1fffffffn); u64(out + 16, e.rightsInheriting ?? 0x1fffffffn); return 0;
  }, owns);
  imports.fd_fdstat_set_flags = guard(imports.fd_fdstat_set_flags, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, flags: number) => {
    if (flags & ~5) fail('ENOTSUP'); const e = right(fd, 3);
    if (e.kind === 'resident') { e.fdflags = flags; return 0; }
    return after(fs.setStatus(e.handle.id, { append: !!(flags & 1) }), () => { e.fdflags = flags; return 0; });
  }, owns);
  imports.fd_fdstat_set_rights = guard(imports.fd_fdstat_set_rights, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, rights: bigint, inheriting: bigint) => {
    const e = entry(fd); if ((rights & ~e.rights) || (inheriting & ~e.rightsInheriting)) fail('ENOTCAPABLE');
    e.rights = rights; e.rightsInheriting = inheriting; return 0;
  }, owns);
  imports.fd_filestat_set_size = guard(imports.fd_filestat_set_size, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, size: bigint) => { right(fd, 22); return after(fs.ftruncate(handle(fd).handle.id, num(size)), () => 0); }, owns);
  imports.fd_sync = guard(imports.fd_sync, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number) => { const e = right(fd, 4); return e.kind === 'resident' ? 0 : after(fs.fsync(e.handle.id), () => 0); }, owns);
  imports.fd_datasync = guard(imports.fd_datasync, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number) => { const e = right(fd, 0); return e.kind === 'resident' ? 0 : after(fs.fsync(e.handle.id), () => 0); }, owns);
  // posix_fallocate(3): the file holds at least [offset, offset + len).
  imports.fd_allocate = guard(imports.fd_allocate, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, offset: bigint, len: bigint) => {
    right(fd, 8); const e = handle(fd), end = num(offset) + num(len);
    return after(fs.fstat(e.handle.id), st => st.size >= end ? 0 : after(fs.ftruncate(e.handle.id, end), () => 0));
  }, owns);
  // Advisory only; there is no cache here to steer.
  imports.fd_advise = guard(imports.fd_advise, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number) => { right(fd, 7); return 0; }, owns);
  imports.fd_readdir = guard(imports.fd_readdir, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, buf: number, size: number, cookie: bigint, used: number) => { pathRight(fd, 14); 
    const e = preopen(fd) ?? entry(fd);
    if (e.kind === 'resident') fail('ENOTDIR');
    const list = e.kind === 'preopen' ? fs.readdir(e.vfsPath) : e.entries ?? fs.readdirHandle(e.handle.id);
    return after(list, entries => {
      if (e.kind === 'authority') e.entries = entries;
      const all = [{ name: '.', type: 'directory' }, { name: '..', type: 'directory' }, ...entries];
      let written = 0;
      for (let i = num(cookie); i < all.length && written < size; i++) {
        const name = encoder.encode(all[i].name), record = new Uint8Array(24 + name.length), dv = new DataView(record.buffer);
        dv.setBigUint64(0, BigInt(i + 1), true); dv.setUint32(16, name.length, true); dv.setUint8(20, ft(all[i].type)); record.set(name, 24);
        const n = Math.min(record.length, size - written); memory().set(record.subarray(0, n), buf + written); written += n;
      }
      u32(used, written); return 0;
    });
  }, owns);
  imports.path_create_directory = guard(imports.path_create_directory, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number) => { pathRight(fd, 9); return after(fs.mkdir(at(fd, path(p, n)), { recursive: false, mode: creationMode(0o777) }), () => 0); });
  imports.path_remove_directory = guard(imports.path_remove_directory, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number) => { pathRight(fd, 25); return after(fs.rmdir(at(fd, path(p, n))), () => 0); });
  imports.path_unlink_file = guard(imports.path_unlink_file, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number) => { pathRight(fd, 26); return after(fs.unlink(at(fd, path(p, n))), () => 0); });
  imports.path_rename = guard(imports.path_rename, (fs: RuntimeFsBridge | RuntimeSynchronousFs, from: number, p: number, n: number, to: number, q: number, m: number) => { pathRight(from, 16); pathRight(to, 17); return after(fs.rename(at(from, path(p, n)), at(to, path(q, m))), () => 0); });
  imports.path_symlink = guard(imports.path_symlink, (fs: RuntimeFsBridge | RuntimeSynchronousFs, p: number, n: number, fd: number, q: number, m: number) => { pathRight(fd, 24); return after(fs.symlink(path(p, n), at(fd, path(q, m))), () => 0); });
  imports.path_readlink = guard(imports.path_readlink, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, p: number, n: number, buf: number, cap: number, used: number) => { pathRight(fd, 15); return after(fs.readlink(at(fd, path(p, n))), value => {
    if (value === null) fail('EINVAL'); const data = encoder.encode(value), count = Math.min(cap, data.length);
    memory().set(data.subarray(0, count), buf); u32(used, count); return 0;
  }); });
  // The filesystem has no hard links; link(2) degrades to a second file with
  // the same bytes, as it always has here.
  imports.path_link = guard(imports.path_link, (fs: RuntimeFsBridge | RuntimeSynchronousFs, from: number, flags: number, p: number, n: number, to: number, q: number, m: number) => {
    pathRight(from, 11); pathRight(to, 12);
    const source = at(from, path(p, n)), target = at(to, path(q, m));
    return after(fs.stat(source, { followSymlinks: !!(flags & 1) }), st => {
      if (st === null) fail('ENOENT');
      if (st.type === 'directory') fail('EPERM');
      return after(fs.stat(target, { followSymlinks: false }), existing => {
        if (existing !== null) fail('EEXIST');
        return after(fs.copyFile(source, target), () => 0);
      });
    });
  });
  const times = (st: RuntimeVfsStat, a: bigint, m: bigint, flags: number): [number, number] => {
    if ((flags & 3) === 3 || (flags & 12) === 12 || flags & ~15) fail('EINVAL');
    return [flags & 2 ? Date.now() : flags & 1 ? Number(a / 1000000n) : st.atime,
      flags & 8 ? Date.now() : flags & 4 ? Number(m / 1000000n) : st.mtime];
  };
  imports.fd_filestat_set_times = guard(imports.fd_filestat_set_times, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, a: bigint, m: bigint, flags: number) => { right(fd, 23); return after(stat(fs, fd), st =>
    after(fs.futimes(handle(fd).handle.id, ...times(st, a, m, flags)), () => 0)); }, owns);
  imports.path_filestat_set_times = guard(imports.path_filestat_set_times, (fs: RuntimeFsBridge | RuntimeSynchronousFs, fd: number, lookup: number, p: number, n: number, a: bigint, m: bigint, flags: number) => { pathRight(fd, 20); 
    const target = at(fd, path(p, n)), followSymlinks = !!(lookup & 1);
    return after(fs.stat(target, { followSymlinks }), st => after(fs.utimes(target, ...times(st ?? fail('ENOENT'), a, m, flags), { followSymlinks }), () => 0));
  });
}
