import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import realm from 'node:process';
import type { NodeFilesystem as VFS, NodeWatch } from './filesystem.js';

import type { RuntimeOpenFlags, RuntimeVfsStat as VfsStat } from '../../../runtime/os-contracts.js';
import type { VfsEvent } from '../../../vfs/events.js';
import { resolve, basename } from '../utils/path.js';
import { encode, decode } from '../utils/encoding.js';
import { errnoCodeOf, fsError, isVfsError, type FsError } from '../../../vfs/vfs-error.js';
import { DIRENT_TYPES, direntTypeOfStat } from '../../../vfs/dirent-type.js';
import { S_IFMT } from '../../../vfs/vfs.js';
import { nameDec } from '../../../_shared/bytes.js';
import { invalidArgType, invalidArgValue, nodeError, nodeSystemError } from '../../../_shared/node-error.js';
import { fileURLToPath } from 'node:url';
import {
  O_ACCMODE, O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_SYNC, O_TRUNC, O_WRONLY, nodeOwnerId, parseFileMode, stringToFlags,
  validateInt32,
} from '../../../_shared/node-arguments.js';

export interface FSWatcher extends EventEmitter {
  close(): void;
  ref(): this;
  unref(): this;
}

interface WatchOptions {
  persistent?: boolean;
  recursive?: boolean;
  encoding?: string;
}

type WatchListener = (eventType: string, filename: string | Buffer) => void;

// ─── Dirent ───

interface Dirent {
  name: string;
  path: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
}

// ─── Stat conversion ───

interface NodeStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
}

/**
 * Node's Stats for a filesystem stat: its identity, links, owner, mode and
 * times as the filesystem has them (no birth time is kept: ctime stands in),
 * the mode with its type's format bits where the filesystem's has none.
 */
function toNodeStat(stat: VfsStat): NodeStat {
  const type = DIRENT_TYPES[direntTypeOfStat(stat)];
  const holds = type.node;
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & S_IFMT ? stat.mode : type.format | stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    gid: stat.gid,
    rdev: 0,
    size: stat.size,
    blksize: 4096,
    blocks: Math.ceil(stat.size / 512),
    atimeMs: stat.atime,
    mtimeMs: stat.mtime,
    ctimeMs: stat.ctime,
    birthtimeMs: stat.ctime,
    atime: new Date(stat.atime),
    mtime: new Date(stat.mtime),
    ctime: new Date(stat.ctime),
    birthtime: new Date(stat.ctime),
    isFile: () => holds === 'isFile',
    isDirectory: () => holds === 'isDirectory',
    isSymbolicLink: () => holds === 'isSymbolicLink',
    isBlockDevice: () => holds === 'isBlockDevice',
    isCharacterDevice: () => holds === 'isCharacterDevice',
    isFIFO: () => holds === 'isFIFO',
    isSocket: () => holds === 'isSocket',
  };
}

// Errors are Node's (vfs-error.ts fsError): what the filesystem throws
// already is, and what this module raises itself is made the same way.
type NodeError = FsError;

type Callback<T> = (err: NodeError | null, result?: T) => void;
type ReadCallback = (err: NodeError | null, bytesRead?: number, buffer?: Uint8Array) => void;
type WriteCallback = (err: NodeError | null, written?: number, data?: Uint8Array | string) => void;

/** What Node's ReadStream and WriteStream take; `fs` is the filesystem they open, read, write and close through. */
interface StreamOptions {
  fs?: object;
  flags?: string;
  encoding?: string;
  fd?: number;
  mode?: number;
  start?: number;
  end?: number;
  highWaterMark?: number;
  autoClose?: boolean;
  emitClose?: boolean;
  /** A WriteStream's: fsync before it closes. */
  flush?: boolean;
}

/** A path argument as Node takes one: a string, a Buffer's text, or a file: URL's path (decoded; another scheme is ERR_INVALID_URL_SCHEME). */
function pathText(p: string | URL | Uint8Array): string {
  if (typeof p === 'string') return p;
  // By shape, not by class: a program's URL or Buffer may be another realm's.
  if (ArrayBuffer.isView(p)) return nameDec.decode(p);
  if (p.protocol !== 'file:') throw nodeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
  return fileURLToPath(p.href);
}

function resolvePath(cwd: string, p: string | URL | Uint8Array): string {
  return resolve(cwd, pathText(p));
}

/** A truncate length as Node takes one (validateInteger, a safe integer), a negative one 0; none is 0. */
function lengthOf(len: number | null | undefined): number {
  return len === undefined ? 0 : Math.max(0, validateInt32(len, 'len', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
}

/** Node's callback check (makeCallback): a callback that is not a function is ERR_INVALID_ARG_TYPE, thrown before any work. */
function callbackOf<T>(cb: Callback<T> | string | URL | Uint8Array | { encoding?: string | null } | number | null | undefined): Callback<T> {
  if (typeof cb !== 'function') throw invalidArgType('cb', 'function', cb);
  return cb;
}

// ─── Open flags ───

/** An open's flags, as Node takes them (a string or bits), for the process's open: the decisions are its. */
function openFlagsOf(flags: unknown, mode: unknown): RuntimeOpenFlags {
  const bits = stringToFlags(flags);
  // Node's open: none (undefined or null) is 0o666.
  const parsedMode = parseFileMode(mode, 'mode', 0o666);
  const access = bits & O_ACCMODE;
  return {
    read: access !== O_WRONLY,
    write: access !== O_RDONLY,
    append: (bits & O_APPEND) !== 0,
    create: (bits & O_CREAT) !== 0,
    exclusive: (bits & O_EXCL) !== 0,
    truncate: (bits & O_TRUNC) !== 0,
    directory: (bits & O_DIRECTORY) !== 0,
    followSymlinks: (bits & O_NOFOLLOW) === 0,
    ...((bits & O_SYNC) === O_SYNC ? { sync: true } : {}),
    mode: parsedMode,
  };
}

/** A position as Node takes it: null or -1 is the descriptor's own offset. */
function positionOf(position: number | null | undefined): number | null {
  return position === undefined || position === null || position === -1 ? null : position;
}

/** The paths that name fd 0. */
const STDIN_PATHS: Record<string, true> = { '/dev/stdin': true, '/dev/fd/0': true, '/proc/self/fd/0': true };

/**
 * `stdin` reads fd 0 to its end, blocking until it ends, as a synchronous
 * read of it does in Node; what it returned is all fd 0 holds, so a second
 * read finds it at its end.
 */
export function createFs(vfs: VFS, cwd: string, stdin?: () => Uint8Array, reachStreams?: () => void) {
  let stdinRead = false;
  const readStdin = (): Uint8Array => {
    if (stdinRead) return new Uint8Array(0);
    stdinRead = true;
    return stdin ? stdin() : new Uint8Array(0);
  };
  // ─── File descriptors ───
  // A descriptor is the process's own (NodeFilesystem.open): its file,
  // offset, rights and O_APPEND are the process's descriptor table's, shared
  // with fs/promises and anything else the process opens. Node's 0, 1 and 2
  // are its standard streams, so a descriptor numbers the process's 1 as 3.

  const STDIO = 3;

  /** `fd`'s call `syscall` on the process's descriptor: EBADF as Node says it, for no descriptor or one without the right. */
  function onDescriptor<T>(fd: number, syscall: string, run: (id: number) => T): T {
    if (!Number.isSafeInteger(fd) || fd < STDIO) throw fsError('EBADF', syscall);
    try {
      return run(fd - STDIO + 1);
    } catch (error) {
      if (errnoCodeOf(error) === 'EBADF') throw fsError('EBADF', syscall);
      throw error;
    }
  }

  // ─── Sync API ───

  function readFileSync(path: string | URL | number, options?: string | { encoding?: string; flag?: string }): string | Uint8Array {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (path === 0 || (typeof path === 'string' && Object.hasOwn(STDIN_PATHS, path))) {
      const bytes = readStdin();
      return encoding ? new TextDecoder().decode(bytes) : Buffer.from(bytes);
    }
    if (typeof path === 'number') {
      // From the descriptor's offset to the end, as Node reads a descriptor.
      const parts: Uint8Array[] = [];
      for (let part = readDescriptor(path, null, 65536); part.byteLength > 0; part = readDescriptor(path, null, 65536)) parts.push(part);
      const bytes = Buffer.concat(parts);
      return encoding ? new TextDecoder().decode(bytes) : bytes;
    }
    const abs = resolvePath(cwd, path);
    try {
      if (encoding) {
        return vfs.readFileString(abs);
      }
      // Return Buffer (not raw Uint8Array) so .toString() yields UTF-8 text.
      // Many packages do JSON.parse(fs.readFileSync('package.json')) without
      // encoding, expecting Buffer.toString() to return the file contents.
      const raw = vfs.readFile(abs);
      return Buffer.from(raw);
    } catch (e) {
      // Node opens a directory, then fails to read it: the error is read's,
      // on the descriptor, with no path.
      if ((e as NodeError).code === 'EISDIR') throw fsError('EISDIR', 'read');
      throw e;
    }
  }

  function writeFileSync(path: string | URL, data: string | Uint8Array, _options?: string | { encoding?: string }): void {
    const abs = resolvePath(cwd, path);
    vfs.writeFile(abs, data);
  }

  function appendFileSync(path: string | URL, data: string | Uint8Array): void {
    const abs = resolvePath(cwd, path);
    vfs.appendFile(abs, data);
  }

  function existsSync(path: string | URL): boolean {
    const abs = resolvePath(cwd, path);
    return vfs.exists(abs);
  }

  function statSync(path: string | URL): NodeStat {
    const abs = resolvePath(cwd, path);
    return toNodeStat(vfs.stat(abs));
  }

  function lstatSync(path: string | URL): NodeStat {
    return toNodeStat(vfs.lstat(resolvePath(cwd, path)));
  }

  function mkdirSync(path: string | URL, options?: { recursive?: boolean; mode?: number | string | null } | number | string | null): void {
    const abs = resolvePath(cwd, path);
    // Node's: a mode in options is checked as given (null is refused), none is 0o777.
    const opts = typeof options === 'object' && options !== null ? options : null;
    const mode = opts === null ? parseFileMode(options, 'mode', 0o777) : opts.mode === undefined ? 0o777 : parseFileMode(opts.mode, 'options.mode');
    vfs.mkdir(abs, { recursive: opts?.recursive, mode });
  }

  function readdirSync(path: string | URL, options?: { encoding?: string; withFileTypes?: boolean }): string[] | Dirent[] {
    const abs = resolvePath(cwd, path);
    const entries = vfs.readdir(abs);
    if (options?.withFileTypes) {
      // d_type, or where the backend cannot say, lstat's.
      return entries.map((e) => {
        const holds = DIRENT_TYPES[e.type === 'unknown' ? direntTypeOfStat(vfs.lstat(resolvePath(abs, e.name))) : e.type].node;
        return {
          name: e.name,
          path: abs,
          isFile: () => holds === 'isFile',
          isDirectory: () => holds === 'isDirectory',
          isSymbolicLink: () => holds === 'isSymbolicLink',
          isBlockDevice: () => holds === 'isBlockDevice',
          isCharacterDevice: () => holds === 'isCharacterDevice',
          isFIFO: () => holds === 'isFIFO',
          isSocket: () => holds === 'isSocket',
        };
      });
    }
    return entries.map((e) => e.name);
  }

  function unlinkSync(path: string | URL): void {
    const abs = resolvePath(cwd, path);
    vfs.unlink(abs);
  }

  /**
   * fs.rmSync, as Node's: the name itself (lstat), never what a link names;
   * a directory only with `recursive` (ERR_FS_EISDIR); with `force`, a name
   * that is not there is no error.
   */
  function rmSync(path: string | URL, options?: { recursive?: boolean; force?: boolean }): void {
    const abs = resolvePath(cwd, path);
    // With force, a name gone by the look or by the removal is no error, as in Node's rimraf.
    const gone = (e: unknown) => options?.force === true && isVfsError(e) && e.code === 'ENOENT';
    let stat: NodeStat;
    try {
      stat = lstatSync(abs);
    } catch (e) {
      if (gone(e)) return;
      throw e;
    }
    if (stat.isDirectory() && !options?.recursive) {
      throw nodeSystemError('ERR_FS_EISDIR', 'Path is a directory', { code: 'EISDIR', message: 'is a directory', path: String(path), syscall: 'rm', errno: 21 });
    }
    try {
      if (stat.isDirectory()) vfs.rmdirRecursive(abs);
      else vfs.unlink(abs);
    } catch (e) {
      if (!gone(e)) throw e;
    }
  }

  function rmdirSync(path: string | URL, options?: { recursive?: boolean }): void {
    const abs = resolvePath(cwd, path);
    if (options?.recursive) {
      vfs.rmdirRecursive(abs);
    } else {
      vfs.rmdir(abs);
    }
  }

  function renameSync(oldPath: string | URL, newPath: string | URL): void {
    const abs1 = resolvePath(cwd, oldPath);
    const abs2 = resolvePath(cwd, newPath);
    vfs.rename(abs1, abs2);
  }

  function copyFileSync(src: string | URL, dest: string | URL): void {
    const abs1 = resolvePath(cwd, src);
    const abs2 = resolvePath(cwd, dest);
    vfs.copyFile(abs1, abs2);
  }

  function chmodSync(path: string | URL, mode: number | string): void {
    vfs.chmod(resolvePath(cwd, path), parseFileMode(mode, 'mode'));
  }

  // chown(2) and lchown(2): a side Node's -1 names keeps the file's, in the same change.
  function chownSync(path: string | URL, uid: number, gid: number): void {
    const abs = resolvePath(cwd, path);
    vfs.chown(abs, nodeOwnerId(uid, 'uid'), nodeOwnerId(gid, 'gid'), true);
  }

  function lchownSync(path: string | URL, uid: number, gid: number): void {
    const abs = resolvePath(cwd, path);
    vfs.chown(abs, nodeOwnerId(uid, 'uid'), nodeOwnerId(gid, 'gid'), false);
  }

  function accessSync(path: string | URL, _mode?: number): void {
    const abs = resolvePath(cwd, path);
    if (!vfs.exists(abs)) {
      throw fsError('ENOENT', 'access', abs);
    }
  }

  const realpathSync = Object.assign(
    function realpathSync(path: string | URL): string {
      const abs = resolvePath(cwd, path);
      // Node's realpathSync lstats the path's components: a missing one is lstat's.
      if (!vfs.exists(abs)) {
        throw fsError('ENOENT', 'lstat', abs);
      }
      return vfs.realpath(abs);
    },
    {
      native: function realpathSyncNative(path: string | URL): string {
        const abs = resolvePath(cwd, path);
        if (!vfs.exists(abs)) {
          throw fsError('ENOENT', 'realpath', abs);
        }
        return vfs.realpath(abs);
      },
    },
  );

  /**
   * truncate(2) as Node makes it: the file opened for writing (its errors
   * name open), cut or zero-extended to `len` (a negative one is 0), closed.
   * The length is checked once the file is open, as Node's ftruncate checks it.
   * A descriptor in place of the path is ftruncate's (Node's DEP0081).
   */
  function truncateSync(path: string | URL | Uint8Array | number, len?: number | null): void {
    if (typeof path === 'number') {
      ftruncateSync(path, len);
      return;
    }
    const fd = vfs.open(resolvePath(cwd, path), openFlagsOf('r+', undefined));
    try {
      vfs.ftruncate(fd, lengthOf(len));
    } finally {
      vfs.close(fd);
    }
  }

  // ─── File descriptor sync API ───

  function openSync(path: string | URL, flags?: string | number | null, mode?: number): number {
    return vfs.open(resolvePath(cwd, path), openFlagsOf(flags, mode)) - 1 + STDIO;
  }

  function closeSync(fd: number): void {
    onDescriptor(fd, 'close', (id) => vfs.close(id));
  }

  function readDescriptor(fd: number, position: number | null, length: number): Uint8Array {
    return onDescriptor(fd, 'read', (id) => vfs.read(id, position, length));
  }

  function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null): number {
    const bytes = readDescriptor(fd, positionOf(position), length);
    buffer.set(bytes, offset);
    return bytes.byteLength;
  }

  function writeSync(fd: number, bufferOrString: Uint8Array | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | string, position?: number | null): number {
    let data: Uint8Array;
    let at: number | null;
    if (typeof bufferOrString === 'string') {
      data = encode(bufferOrString);
      at = positionOf(offsetOrPosition);
    } else {
      const offset = offsetOrPosition ?? 0;
      const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : bufferOrString.length - offset;
      data = bufferOrString.subarray(offset, offset + length);
      at = positionOf(position);
    }
    return onDescriptor(fd, 'write', (id) => vfs.write(id, at, data));
  }

  function fstatSync(fd: number): NodeStat {
    return toNodeStat(onDescriptor(fd, 'fstat', (id) => vfs.fstat(id)));
  }

  function ftruncateSync(fd: number, len?: number | null): void {
    const length = lengthOf(len);
    onDescriptor(fd, 'ftruncate', (id) => vfs.ftruncate(id, length));
  }

  function fchownSync(fd: number, uid: number, gid: number): void {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    onDescriptor(fd, 'fchown', (id) => vfs.fchown(id, owner, group));
  }

  function fsyncSync(fd: number): void {
    onDescriptor(fd, 'fsync', (id) => vfs.fsync(id));
  }

  function fdatasyncSync(fd: number): void {
    onDescriptor(fd, 'fdatasync', (id) => vfs.fsync(id));
  }

  // ─── Links ───

  /** symlink(2): the link at `path` holds `target` as given (a relative target stays relative, read from the link's directory). */
  function symlinkSync(target: string | URL | Uint8Array, path: string | URL | Uint8Array, _type?: string | null): void {
    vfs.symlink(pathText(target), resolvePath(cwd, path));
  }

  /**
   * link(2), refused (ENOSYS) as the hosted node refuses it: the filesystem
   * has no hard links, and a copy would claim an inode the names do not share.
   */
  function linkSync(existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array): void {
    throw fsError('ENOSYS', 'link', pathText(existingPath), pathText(newPath));
  }

  /** readlink(2): the link's text in `encoding` (UTF-8 by default), or its bytes with `encoding: 'buffer'`. */
  function readlinkSync(path: string | URL | Uint8Array, options?: string | { encoding?: string | null } | null): string | Buffer {
    // No encoding, or an empty one, is UTF-8, as Node takes it.
    const encoding = (typeof options === 'string' ? options : options?.encoding) || 'utf8';
    if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) throw invalidArgValue('encoding', encoding, 'is invalid encoding');
    const text = vfs.readlink(resolvePath(cwd, path));
    if (encoding === 'buffer') return Buffer.from(text);
    return encoding === 'utf8' ? text : Buffer.from(text).toString(encoding);
  }

  // ─── Callback API ───

  function wrapCallback<T>(syncFn: () => T, cb: Callback<T>): void {
    queueMicrotask(() => {
      try {
        const result = syncFn();
        cb(null, result);
      } catch (e) {
        // The filesystem's errors and this module's are Node's already.
        if (isVfsError(e) || (e as NodeError).code) {
          cb(e as NodeError);
        } else {
          throw e;
        }
      }
    });
  }
  // Their ids are checked at once, as Node's are: a bad one throws, never calls back.
  function chown(path: string | URL, uid: number, gid: number, cb: Callback<void>): void {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    wrapCallback(() => vfs.chown(resolvePath(cwd, path), owner, group, true), cb);
  }

  function lchown(path: string | URL, uid: number, gid: number, cb: Callback<void>): void {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    wrapCallback(() => vfs.chown(resolvePath(cwd, path), owner, group, false), cb);
  }

  function fchown(fd: number, uid: number, gid: number, cb: Callback<void>): void {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    wrapCallback(() => onDescriptor(fd, 'fchown', (id) => vfs.fchown(id, owner, group)), cb);
  }


  function readFile(path: string | URL, optionsOrCb: string | { encoding?: string } | Callback<string | Uint8Array>, cb?: Callback<string | Uint8Array>): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    wrapCallback(() => readFileSync(path, options), callback);
  }

  function writeFile(path: string | URL, data: string | Uint8Array, optionsOrCb: string | { encoding?: string } | Callback<void>, cb?: Callback<void>): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    wrapCallback(() => writeFileSync(path, data), callback);
  }

  function stat(path: string | URL, cb: Callback<NodeStat>): void {
    wrapCallback(() => statSync(path), cb);
  }

  function lstat(path: string | URL, cb: Callback<NodeStat>): void {
    wrapCallback(() => lstatSync(path), cb);
  }

  function mkdir(path: string | URL, optionsOrCb: { recursive?: boolean } | Callback<void>, cb?: Callback<void>): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    wrapCallback(() => mkdirSync(path, options), callback);
  }

  function readdir(path: string | URL, optionsOrCb: { encoding?: string; withFileTypes?: boolean } | Callback<string[] | Dirent[]>, cb?: Callback<string[] | Dirent[]>): void {
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    wrapCallback(() => readdirSync(path, options), callback);
  }

  function rm(path: string | URL, optionsOrCb: { recursive?: boolean; force?: boolean } | Callback<void>, cb?: Callback<void>): void {
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    const done = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    if (done) wrapCallback(() => rmSync(path, options), done);
  }

  function unlink(path: string | URL, cb: Callback<void>): void {
    wrapCallback(() => unlinkSync(path), cb);
  }

  function rename(oldPath: string | URL, newPath: string | URL, cb: Callback<void>): void {
    wrapCallback(() => renameSync(oldPath, newPath), cb);
  }

  function access(path: string | URL, modeOrCb: number | Callback<void>, cb?: Callback<void>): void {
    const callback = typeof modeOrCb === 'function' ? modeOrCb : cb!;
    const mode = typeof modeOrCb === 'function' ? undefined : modeOrCb;
    wrapCallback(() => accessSync(path, mode), callback);
  }

  /** Its callback is its last argument, as Node's symlink takes it. */
  function symlink(target: string | URL | Uint8Array, path: string | URL | Uint8Array, ...rest: Array<string | null | undefined | Callback<void>>): void {
    const callback = callbackOf<void>(rest.length === 0 ? path : rest[rest.length - 1]);
    wrapCallback(() => symlinkSync(target, path), callback);
  }

  function readlink(path: string | URL | Uint8Array, optionsOrCb: string | { encoding?: string | null } | null | undefined | Callback<string | Buffer>, cb?: Callback<string | Buffer>): void {
    const callback = callbackOf<string | Buffer>(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    wrapCallback(() => readlinkSync(path, options), callback);
  }

  function link(existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array, cb?: Callback<void>): void {
    const callback = callbackOf<void>(cb);
    const from = pathText(existingPath);
    const to = pathText(newPath);
    wrapCallback(() => linkSync(from, to), callback);
  }

  /** Its length and callback are checked before anything is done, as Node's are. */
  function truncate(path: string | URL | Uint8Array | number, lenOrCb?: number | null | Callback<void>, cb?: Callback<void>): void {
    if (typeof path === 'number') {
      ftruncate(path, lenOrCb, cb);
      return;
    }
    const length = lengthOf(typeof lenOrCb === 'function' ? undefined : lenOrCb);
    const callback = callbackOf<void>(typeof lenOrCb === 'function' ? lenOrCb : cb);
    wrapCallback(() => truncateSync(path, length), callback);
  }

  function ftruncate(fd: number, lenOrCb?: number | null | Callback<void>, cb?: Callback<void>): void {
    const length = lengthOf(typeof lenOrCb === 'function' ? undefined : lenOrCb);
    const callback = callbackOf<void>(typeof lenOrCb === 'function' ? lenOrCb : cb);
    wrapCallback(() => ftruncateSync(fd, length), callback);
  }

  function exists(path: string | URL, cb: (exists: boolean) => void): void {
    queueMicrotask(() => {
      cb(existsSync(path));
    });
  }

  function open(path: string | URL, flagsOrCb: string | number | Callback<number>, modeOrCb?: number | Callback<number>, cb?: Callback<number>): void {
    let callback: Callback<number>;
    let flags: string | number;
    let mode: number | undefined;

    if (typeof flagsOrCb === 'function') {
      callback = flagsOrCb;
      flags = 'r';
    } else if (typeof modeOrCb === 'function') {
      callback = modeOrCb;
      flags = flagsOrCb;
    } else {
      callback = cb!;
      flags = flagsOrCb;
      mode = modeOrCb;
    }

    wrapCallback(() => openSync(path, flags, mode), callback);
  }

  function close(fd: number, cb: Callback<void>): void {
    wrapCallback(() => closeSync(fd), cb);
  }

  /** Node's fs.read: its callback is given the bytes read and the buffer. */
  function read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: ReadCallback): void {
    wrapCallback(() => readSync(fd, buffer, offset, length, position), (err, bytesRead) => cb(err, bytesRead, buffer));
  }

  /**
   * Node's fs.write, (fd, buffer, offset?, length?, position?, callback) or
   * (fd, string, position?, encoding?, callback): its callback is given the
   * bytes written and what was written.
   */
  function write(fd: number, data: Uint8Array | string, ...rest: (number | string | null | undefined | WriteCallback)[]): void {
    const callback = rest.pop();
    if (typeof callback !== 'function') throw invalidArgType('cb', 'function', callback);
    const [first, second, third] = rest.map((arg) => (typeof arg === 'function' ? undefined : arg));
    const at = (arg: typeof first): number | null | undefined => (typeof arg === 'string' ? undefined : arg);
    wrapCallback(() => (typeof data === 'string'
      ? writeSync(fd, data, at(first), typeof second === 'string' ? second : undefined)
      : writeSync(fd, data, at(first), typeof second === 'number' ? second : undefined, at(third))), (err, written) => callback(err, written, data));
  }

  function fsync(fd: number, cb: Callback<void>): void {
    wrapCallback(() => fsyncSync(fd), cb);
  }

  function fstat(fd: number, cb: Callback<NodeStat>): void {
    wrapCallback(() => fstatSync(fd), cb);
  }

  const realpath = Object.assign(
    function realpath(path: string | URL, optOrCb: unknown, cb?: Callback<string>): void {
      const callback = typeof optOrCb === 'function' ? optOrCb as Callback<string> : cb!;
      wrapCallback(() => realpathSync(path), callback);
    },
    {
      native: function realpathNative(path: string | URL, optOrCb: unknown, cb?: Callback<string>): void {
        const callback = typeof optOrCb === 'function' ? optOrCb as Callback<string> : cb!;
        wrapCallback(() => realpathSync(path), callback);
      },
    },
  );

  // ─── Stream API ───

  // The engine's own read and write streams, over this filesystem: Node's
  // ReadStream and WriteStream read and write through the `fs` they are given.
  const engineFs = realm.getBuiltinModule('node:fs');
  const streamFs = { open, read, write, close, fsync };
  const streamPath = (path: string | URL | null | undefined): string | undefined => (path === null || path === undefined ? undefined : resolvePath(cwd, path));
  // A stream given no fs of its own (none, undefined or null, which Node's
  // `options.fs || fs` reads as its default) goes through this filesystem,
  // its descriptors this filesystem's: never the engine's own.
  const streamOptions = (options: string | StreamOptions | undefined): StreamOptions => {
    const given = typeof options === 'string' ? { encoding: options } : options ?? {};
    return { ...given, fs: given.fs || streamFs };
  };
  class ReadStream extends engineFs.ReadStream {
    constructor(path: string | URL | null | undefined, options?: string | StreamOptions) {
      reachStreams?.();
      super(streamPath(path), streamOptions(options));
    }
  }
  class WriteStream extends engineFs.WriteStream {
    constructor(path: string | URL | null | undefined, options?: string | StreamOptions) {
      reachStreams?.();
      super(streamPath(path), streamOptions(options));
    }
  }
  const createReadStream = (path: string | URL, options?: string | StreamOptions): ReadStream => new ReadStream(path, options);
  const createWriteStream = (path: string | URL, options?: string | StreamOptions): WriteStream => new WriteStream(path, options);


  // ─── Watch API ───

  /**
   * Node's fs.watch: 'rename' when an entry appears or goes, 'change' when
   * one changes, named from the watched directory (its direct entries,
   * any depth when recursive), or as the watched file itself.
   */
  function watch(filename: string | URL, optionsOrListener?: WatchOptions | string | WatchListener, listener?: WatchListener): FSWatcher {
    // A copy, as Node takes: what the caller does to its options after is not the watch's.
    const options: WatchOptions = typeof optionsOrListener === 'string' ? { encoding: optionsOrListener }
      : typeof optionsOrListener === 'object' && optionsOrListener !== null ? { ...optionsOrListener } : {};
    // Node checks the encoding first, whatever the path.
    if (options.encoding && options.encoding !== 'buffer' && !Buffer.isEncoding(options.encoding)) {
      throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'encoding' is invalid encoding. Received '${options.encoding}'`);
    }
    const given = pathText(filename);
    let abs: string;
    try {
      if (given === '') throw fsError('ENOENT', 'watch', given);
      abs = realpathSync(filename);
    } catch (error) {
      if (errnoCodeOf(error) === 'ENOENT') throw fsError('ENOENT', 'watch', given);
      throw error;
    }
    const directory = vfs.isDirectory(abs);
    const base = basename(given);
    const cb = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
    let closed = false;
    let persistent = options.persistent !== false;
    let handle: NodeWatch;

    const watcher = new class extends EventEmitter implements FSWatcher {
      close(): void {
        if (closed) return;
        closed = true;
        handle.close();
        queueMicrotask(() => this.emit('close'));
      }
      ref(): this {
        if (!closed) { persistent = true; handle.ref(); }
        return this;
      }
      unref(): this {
        if (!closed) { persistent = false; handle.unref(); }
        return this;
      }
    }();
    if (cb) watcher.on('change', (eventType, name) => cb(String(eventType), name instanceof Buffer ? name : String(name)));
    const inside = (path: string): boolean => path === abs || (directory && path.startsWith(abs === '/' ? '/' : `${abs}/`));
    const told = (path: string, eventType: 'rename' | 'change'): void => {
      if (closed || !inside(path)) return;
      const name = path === abs ? base : path.slice(abs === '/' ? 1 : abs.length + 1);
      if (path !== abs && options.recursive !== true && name.includes('/')) return;
      const bytes = Buffer.from(name);
      watcher.emit('change', eventType, options.encoding === 'buffer' ? bytes : bytes.toString(options.encoding));
    };
    const changed = (event: VfsEvent): void => {
      if (closed) return;
      // The target itself moved (or a directory above it): the namespace's watch follows it, and so do its names.
      if (event.type === 'rename' && event.oldPath === abs) {
        told(abs, 'rename');
        abs = event.path;
        return;
      }
      if (event.type === 'change') { told(event.path, 'change'); return; }
      if (event.oldPath !== undefined) told(event.oldPath, 'rename');
      told(event.path, 'rename');
    };
    handle = vfs.watch(abs, changed, { persistent });

    return watcher;
  }

  // ─── Promises API ───

  const promises = {
    readFile: async (path: string | URL, options?: string | { encoding?: string }) => readFileSync(path, options),
    writeFile: async (path: string | URL, data: string | Uint8Array) => writeFileSync(path, data),
    appendFile: async (path: string | URL, data: string | Uint8Array) => appendFileSync(path, data),
    stat: async (path: string | URL) => statSync(path),
    lstat: async (path: string | URL) => lstatSync(path),
    mkdir: async (path: string | URL, options?: { recursive?: boolean }) => { mkdirSync(path, options); },
    readdir: async (path: string | URL, options?: { encoding?: string; withFileTypes?: boolean }) => readdirSync(path, options),
    unlink: async (path: string | URL) => unlinkSync(path),
    rmdir: async (path: string | URL, options?: { recursive?: boolean }) => rmdirSync(path, options),
    rename: async (oldPath: string | URL, newPath: string | URL) => renameSync(oldPath, newPath),
    copyFile: async (src: string | URL, dest: string | URL) => copyFileSync(src, dest),
    access: async (path: string | URL, mode?: number) => accessSync(path, mode),
    realpath: async (path: string | URL) => realpathSync(path),
    // A path only: a descriptor is its FileHandle's truncate.
    truncate: async (path: string | URL | Uint8Array, len?: number | null) => {
      if (typeof path === 'number') throw invalidArgType('path', ['string', 'Buffer', 'URL'], path);
      truncateSync(path, len);
    },
    symlink: async (target: string | URL | Uint8Array, path: string | URL | Uint8Array, type?: string | null) => symlinkSync(target, path, type),
    link: async (existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array) => linkSync(existingPath, newPath),
    readlink: async (path: string | URL | Uint8Array, options?: string | { encoding?: string | null } | null) => readlinkSync(path, options),
    chmod: async (path: string | URL, mode: number | string) => chmodSync(path, mode),
    chown: async (path: string | URL, uid: number, gid: number) => chownSync(path, uid, gid),
    lchown: async (path: string | URL, uid: number, gid: number) => lchownSync(path, uid, gid),
    open: async (path: string | URL, flags?: string | number, mode?: number) => {
      const fd = openSync(path, flags, mode);
      return {
        fd,
        close: async () => closeSync(fd),
        read: async (buffer: Uint8Array, offset: number, length: number, position: number | null) => ({
          bytesRead: readSync(fd, buffer, offset, length, position),
          buffer,
        }),
        write: async (data: Uint8Array | string) => ({
          bytesWritten: writeSync(fd, data),
        }),
        stat: async () => fstatSync(fd),
        chown: async (uid: number, gid: number) => fchownSync(fd, uid, gid),
        truncate: async (len?: number | null) => ftruncateSync(fd, len),
      };
    },
    rm: async (path: string | URL, options?: { recursive?: boolean; force?: boolean }) => rmSync(path, options),
  };

  // ─── Constants ───

  const constants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    O_RDONLY,
    O_WRONLY,
    O_RDWR,
    O_CREAT,
    O_EXCL,
    O_TRUNC,
    O_APPEND,
    O_DIRECTORY,
    O_NOFOLLOW,
    O_SYNC,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
  };

  return {
    // Sync
    readFileSync,
    writeFileSync,
    appendFileSync,
    existsSync,
    statSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    unlinkSync,
    rmSync,
    rmdirSync,
    renameSync,
    copyFileSync,
    chmodSync,
    chownSync,
    lchownSync,
    fchownSync,
    accessSync,
    realpathSync,
    truncateSync,
    openSync,
    closeSync,
    readSync,
    writeSync,
    fstatSync,
    ftruncateSync,
    fsyncSync,
    fdatasyncSync,
    symlinkSync,
    linkSync,
    readlinkSync,
    // Callback
    readFile,
    writeFile,
    stat,
    lstat,
    mkdir,
    readdir,
    unlink,
    rm,
    rename,
    access,
    exists,
    symlink,
    link,
    readlink,
    truncate,
    ftruncate,
    open,
    close,
    read,
    write,
    fsync,
    fstat,
    chown,
    lchown,
    fchown,
    realpath,
    // Streams
    ReadStream,
    WriteStream,
    createReadStream,
    createWriteStream,
    // Watch
    watch,
    // Promises
    promises,
    // Constants
    constants,
  };
}
