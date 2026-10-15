import type { RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../runtime/os-contracts.js';
import type { VfsEvent } from '../../../vfs/events.js';
import { syscallError } from '../../../vfs/vfs-error.js';

export interface NodeWatch {
  close(): void;
  ref(): void;
  unref(): void;
}

/** The synchronous filesystem the in-process Node interpreter's `fs` and `require` read. */
export interface NodeFilesystem {
  readFile(path: string): Uint8Array;
  readFileString(path: string): string;
  writeFile(path: string, data: string | Uint8Array): void;
  appendFile(path: string, data: string | Uint8Array): void;
  exists(path: string): boolean;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  stat(path: string): RuntimeVfsStat;
  /** stat(2) of `path` itself where it names a link (lstat); ENOENT when nothing is there. */
  lstat(path: string): RuntimeVfsStat;
  /** Canonical VFS path, following links; native module caches key by it. */
  realpath(path: string): string;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  readdir(path: string): RuntimeVfsDirEntry[];
  unlink(path: string): void;
  rmdir(path: string): void;
  rmdirRecursive(path: string): void;
  rename(from: string, to: string): void;
  copyFile(from: string, to: string): void;
  chmod(path: string, mode: number): void;
  /** chown(2), or lchown(2) when not `follow`: a null side keeps the file's, in the same change. */
  chown(path: string, uid: number | null, gid: number | null, follow: boolean): void;
  /** open(2): the process's descriptor (its DescriptorScope's), whatever filesystem the file is on. */
  open(path: string, flags: RuntimeOpenFlags): number;
  /** read(2), at `position`, or at the descriptor's offset (null), which then moves. */
  read(fd: number, position: number | null, length: number): Uint8Array;
  /** write(2), at `position`, or at the descriptor's offset (null), which then moves; an O_APPEND descriptor's at the end. */
  write(fd: number, position: number | null, data: Uint8Array): number;
  fstat(fd: number): RuntimeVfsStat;
  /** fchown(2): a null side keeps the file's. */
  fchown(fd: number, uid: number | null, gid: number | null): void;
  ftruncate(fd: number, size: number): void;
  fsync(fd: number): void;
  close(fd: number): void;
  /**
   * Each change at `path` or under it the process's namespace shows
   * (RuntimeFsBridge.subscribe), its paths absolute. `persistent` (default
   * true): a guest stays while the watch is open and ref'd, as Node's does.
   */
  watch(path: string, listener: (event: VfsEvent) => void, options?: { persistent?: boolean }): NodeWatch;
}

/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one. What it
 * creates is made with `umask()`, the program's own mask (process.umask).
 */
export function synchronousFilesystem(view: { process: RuntimeFsBridge }, umask: () => number): () => NodeFilesystem {
  let opened: NodeFilesystem | null = null;
  return () => {
    opened ??= bridgeFilesystem(view.process, umask);
    return opened;
  };
}

function bridgeFilesystem(bridge: RuntimeFsBridge, umask: () => number): NodeFilesystem {
  const fs = bridge.synchronous;
  if (!fs) throw new Error('This Node interpreter requires a synchronous filesystem capability; asynchronous hosts use the resident Node runtime');
  const read = (path: string): Uint8Array => {
    const data = fs.readFile(path);
    if (data === null) throw syscallError('ENOENT', 'open', path);
    return data;
  };
  return {
    readFile: read,
    readFileString: path => new TextDecoder().decode(read(path)),
    writeFile(path, data) { fs.writeFile(path, data, { umask: umask() }); },
    appendFile(path, data) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const handle = fs.open(path, { write: true, append: true, create: true, umask: umask() });
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.write(handle.id, null, bytes.subarray(offset));
          if (count <= 0 || count > bytes.length - offset) throw new Error('EIO: invalid append write length');
          offset += count;
        }
      } finally { fs.close(handle.id); }
    },
    exists: path => fs.stat(path) !== null,
    isFile: path => fs.stat(path)?.type === 'file',
    isDirectory: path => fs.stat(path)?.type === 'directory',
    stat(path) {
      const stat = fs.stat(path);
      if (!stat) throw syscallError('ENOENT', 'stat', path);
      return stat;
    },
    lstat(path) {
      const stat = fs.stat(path, { followSymlinks: false });
      if (!stat) throw syscallError('ENOENT', 'lstat', path);
      return stat;
    },
    realpath: path => fs.realpath(path),
    mkdir: (path, options) => fs.mkdir(path, { ...options, umask: umask() }),
    readdir: path => fs.readdir(path) as RuntimeVfsDirEntry[],
    unlink: path => fs.unlink(path),
    rmdir: path => fs.rmdir(path),
    rmdirRecursive: path => fs.remove(path, { recursive: true }),
    rename: (from, to) => fs.rename(from, to),
    copyFile: (from, to) => fs.copyFile(from, to),
    chmod: (path, mode) => fs.chmod(path, mode),
    chown: (path, uid, gid, follow) => { fs.chown(path, uid, gid, { followSymlinks: follow }); },
    open: (path, flags) => fs.open(path, { ...flags, umask: umask() }).id,
    read: (fd, position, length) => fs.read(fd, position, length),
    write: (fd, position, data) => fs.write(fd, position, data),
    fstat: (fd) => fs.fstat(fd),
    fchown: (fd, uid, gid) => fs.fchown(fd, uid, gid),
    ftruncate: (fd, size) => fs.ftruncate(fd, size),
    fsync: (fd) => fs.fsync(fd),
    close: (fd) => fs.close(fd),
    watch(path, listener) {
      // A Node watch is of its target, as an inode's is: it follows it across renames.
      const stop = bridge.subscribe?.(path, (event) => listener(event.oldPath === undefined
        ? { ...event, path: `/${event.path}` }
        : { ...event, path: `/${event.path}`, oldPath: `/${event.oldPath}` }), { follow: true });
      return { close: () => stop?.(), ref() {}, unref() {} };
    },
  };
}
