/**
 * Node's `fs`, written once over the file faces (Kinu ask 67): each
 * operation is a generator (node-compat/drive.ts) whose body holds its
 * argument checks, paths, encodings and the shaping of Stats, Dirents and
 * errors, and yields each file call as a step. Its `*Sync` form answers
 * from the synchronous face; its callbacks and `fs.promises` from the
 * asynchronous one, or the synchronous one where there is no other. lifo's
 * Node runs it over its synchronous filesystem; a session client's
 * (createNodeCompat) over the session's asynchronous calls.
 */
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import realm from 'node:process';
import { fileURLToPath } from 'node:url';
import type { RuntimeOpenFlags, RuntimeVfsStat as VfsStat } from '../runtime/os-contracts.js';
import type { VfsEvent } from '../vfs/events.js';
import { operandPath, basename } from '../substrate/lifo/utils/path.js';
import { encode } from '../substrate/lifo/utils/encoding.js';
import { errnoCodeOf, fsError, isVfsError } from '../vfs/vfs-error.js';
import { DIRENT_TYPES, direntTypeOfStat } from '../vfs/dirent-type.js';
import { S_IFMT } from '../vfs/vfs.js';
import { nameDec } from '../_shared/bytes.js';
import { invalidArgType, invalidArgValue, nodeError, nodeSystemError } from '../_shared/node-error.js';
import {
  O_ACCMODE, O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_SYNC, O_TRUNC, O_WRONLY, nodeOwnerId, parseFileMode, stringToFlags,
  validateInt32,
} from '../_shared/node-arguments.js';
import type { NodeFaces, NodeWatch } from './faces.js';
import { lacks, runAsync, runSync, step, type Op } from './drive.js';

export interface FSWatcher extends EventEmitter {
  close(): void;
  ref(): this;
  unref(): this;
}

export interface WatchOptions {
  persistent?: boolean;
  recursive?: boolean;
  encoding?: string;
}

type WatchListener = (eventType: string, filename: string | Buffer) => void;

// ─── Dirent ───

export interface Dirent {
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

export interface NodeStat {
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
type Callback<T> = (err: Error | null, result?: T) => void;
type ReadCallback = (err: Error | null, bytesRead?: number, buffer?: Uint8Array) => void;
type WriteCallback = (err: Error | null, written?: number, data?: Uint8Array | string) => void;

/** A failure a callback is given: the filesystem's, or one this module made, either with its code. */
function codedError(error: unknown): error is Error {
  return isVfsError(error) || (error instanceof Error && Reflect.get(error, 'code') !== undefined);
}

/** What Node's ReadStream and WriteStream take; `fs` is the filesystem they open, read, write and close through. */
export interface StreamOptions {
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
  return operandPath(cwd, pathText(p));
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

export interface NodeFsOptions {
  cwd: string;
  /**
   * fd 0 to its end, blocking until it ends, as a synchronous read of it
   * does in Node; what it returned is all fd 0 holds, so a second read finds
   * it at its end. Absent, fd 0 reads as empty.
   */
  stdin?: () => Uint8Array;
  /** Told when the program first reaches the engine's stream classes. */
  reachStreams?: () => void;
}

export function createNodeFs(faces: NodeFaces, { cwd, stdin, reachStreams }: NodeFsOptions) {
  let stdinRead = false;
  const readStdin = (): Uint8Array => {
    if (stdinRead) return new Uint8Array(0);
    stdinRead = true;
    return stdin ? stdin() : new Uint8Array(0);
  };

  // ─── Drivers ───

  /** `op`, the `name` form's, answered at once. */
  const sync = <T>(name: string, op: Op<T>): T => runSync(faces, name, op);

  /**
   * `op` for a callback, never called back in its caller's turn. Where the
   * synchronous face answers, it is answered in the next microtask, as it
   * always has been. A failure with a code is the callback's; any other is
   * thrown, as a callback's own throw is.
   */
  function callback<T>(op: () => Op<T>, cb: Callback<T>): void {
    queueMicrotask(() => {
      if (faces.async === undefined) {
        try {
          const result = runSync(faces, 'callback', op());
          cb(null, result);
        } catch (e) {
          if (codedError(e)) cb(e);
          else throw e;
        }
        return;
      }
      runAsync(faces, op()).then((result) => ({ result }), (error: unknown) => ({ error })).then((outcome) => {
        if (!('error' in outcome)) {
          cb(null, outcome.result);
          return;
        }
        if (!codedError(outcome.error)) throw outcome.error;
        cb(outcome.error);
      }).catch((error: unknown) => queueMicrotask(() => { throw error; }));
    });
  }

  /** `op` for `fs.promises`. */
  const promised = <T>(op: () => Op<T>): Promise<T> => runAsync(faces, op());

  // ─── File descriptors ───
  // A descriptor is the process's own (NodeFilesystem.open): its file,
  // offset, rights and O_APPEND are the process's descriptor table's, shared
  // with fs/promises and anything else the process opens. Node's 0, 1 and 2
  // are its standard streams, so a descriptor numbers the process's 1 as 3.

  const STDIO = 3;

  /** `fd`'s call `syscall` on the process's descriptor: EBADF as Node says it, for no descriptor or one without the right. */
  function* onDescriptor<T>(fd: number, syscall: string, run: (id: number) => Op<T>): Op<T> {
    if (!Number.isSafeInteger(fd) || fd < STDIO) throw fsError('EBADF', syscall);
    try {
      return yield* run(fd - STDIO + 1);
    } catch (error) {
      if (errnoCodeOf(error) === 'EBADF') throw fsError('EBADF', syscall);
      throw error;
    }
  }

  // ─── Operations ───

  function* readDescriptor(fd: number, position: number | null, length: number): Op<Uint8Array> {
    return yield* onDescriptor(fd, 'read', (id) => step('read', undefined, (f) => {
      if (f.read === undefined) throw lacks('read');
      return f.read(id, position, length);
    }));
  }

  function* readFileOp(path: string | URL | number, options?: string | { encoding?: string; flag?: string }): Op<string | Uint8Array> {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (path === 0 || (typeof path === 'string' && Object.hasOwn(STDIN_PATHS, path))) {
      const bytes = readStdin();
      return encoding ? new TextDecoder().decode(bytes) : Buffer.from(bytes);
    }
    if (typeof path === 'number') {
      // From the descriptor's offset to the end, as Node reads a descriptor.
      const parts: Uint8Array[] = [];
      for (let part = yield* readDescriptor(path, null, 65536); part.byteLength > 0; part = yield* readDescriptor(path, null, 65536)) parts.push(part);
      const bytes = Buffer.concat(parts);
      return encoding ? new TextDecoder().decode(bytes) : bytes;
    }
    const abs = resolvePath(cwd, path);
    try {
      if (encoding) {
        return yield* step('open', abs, (f) => f.readFileString(abs));
      }
      // Return Buffer (not raw Uint8Array) so .toString() yields UTF-8 text.
      // Many packages do JSON.parse(fs.readFileSync('package.json')) without
      // encoding, expecting Buffer.toString() to return the file contents.
      const raw = yield* step('open', abs, (f) => f.readFile(abs));
      return Buffer.from(raw);
    } catch (e) {
      // Node opens a directory, then fails to read it: the error is read's,
      // on the descriptor, with no path.
      if (errnoCodeOf(e) === 'EISDIR') throw fsError('EISDIR', 'read');
      throw e;
    }
  }

  function* writeFileOp(path: string | URL, data: string | Uint8Array): Op<void> {
    const abs = resolvePath(cwd, path);
    yield* step('open', abs, (f) => f.writeFile(abs, data));
  }

  function* appendFileOp(path: string | URL, data: string | Uint8Array): Op<void> {
    const abs = resolvePath(cwd, path);
    yield* step('open', abs, (f) => {
      if (f.appendFile === undefined) throw lacks('open', abs);
      return f.appendFile(abs, data);
    });
  }

  function* existsOp(path: string | URL): Op<boolean> {
    const abs = resolvePath(cwd, path);
    return yield* step('access', abs, (f) => f.exists(abs));
  }

  function* statOp(path: string | URL): Op<NodeStat> {
    const abs = resolvePath(cwd, path);
    return toNodeStat(yield* step('stat', abs, (f) => f.stat(abs)));
  }

  function* lstatOp(path: string | URL): Op<NodeStat> {
    const abs = resolvePath(cwd, path);
    return toNodeStat(yield* step('lstat', abs, (f) => f.lstat(abs)));
  }

  function* mkdirOp(path: string | URL, options?: { recursive?: boolean; mode?: number | string | null } | number | string | null): Op<void> {
    const abs = resolvePath(cwd, path);
    // Node's: a mode in options is checked as given (null is refused), none is 0o777.
    const opts = typeof options === 'object' && options !== null ? options : null;
    const mode = opts === null ? parseFileMode(options, 'mode', 0o777) : opts.mode === undefined ? 0o777 : parseFileMode(opts.mode, 'options.mode');
    yield* step('mkdir', abs, (f) => {
      if (f.mkdir === undefined) throw lacks('mkdir', abs);
      return f.mkdir(abs, { recursive: opts?.recursive, mode });
    });
  }

  function* readdirOp(path: string | URL, options?: { encoding?: string; withFileTypes?: boolean }): Op<string[] | Dirent[]> {
    const abs = resolvePath(cwd, path);
    const entries = yield* step('scandir', abs, (f) => f.readdir(abs));
    if (!options?.withFileTypes) return entries.map((e) => e.name);
    // d_type, or where the backend cannot say, lstat's.
    const dirents: Dirent[] = [];
    for (const e of entries) {
      const entry = resolvePath(abs, e.name);
      const holds = DIRENT_TYPES[e.type === 'unknown' ? direntTypeOfStat(yield* step('lstat', entry, (f) => f.lstat(entry))) : e.type].node;
      dirents.push({
        name: e.name,
        path: abs,
        isFile: () => holds === 'isFile',
        isDirectory: () => holds === 'isDirectory',
        isSymbolicLink: () => holds === 'isSymbolicLink',
        isBlockDevice: () => holds === 'isBlockDevice',
        isCharacterDevice: () => holds === 'isCharacterDevice',
        isFIFO: () => holds === 'isFIFO',
        isSocket: () => holds === 'isSocket',
      });
    }
    return dirents;
  }

  function* unlinkOp(path: string | URL): Op<void> {
    const abs = resolvePath(cwd, path);
    yield* step('unlink', abs, (f) => {
      if (f.unlink === undefined) throw lacks('unlink', abs);
      return f.unlink(abs);
    });
  }

  function* rmdirRecursiveStep(abs: string): Op<void> {
    yield* step('rmdir', abs, (f) => {
      if (f.rmdirRecursive === undefined) throw lacks('rmdir', abs);
      return f.rmdirRecursive(abs);
    });
  }

  /**
   * fs.rm, as Node's: the name itself (lstat), never what a link names;
   * a directory only with `recursive` (ERR_FS_EISDIR); with `force`, a name
   * that is not there is no error.
   */
  function* rmOp(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Op<void> {
    const abs = resolvePath(cwd, path);
    // With force, a name gone by the look or by the removal is no error, as in Node's rimraf.
    const gone = (e: unknown) => options?.force === true && isVfsError(e) && e.code === 'ENOENT';
    let stat: NodeStat;
    try {
      stat = yield* lstatOp(abs);
    } catch (e) {
      if (gone(e)) return;
      throw e;
    }
    if (stat.isDirectory() && !options?.recursive) {
      throw nodeSystemError('ERR_FS_EISDIR', 'Path is a directory', { code: 'EISDIR', message: 'is a directory', path: String(path), syscall: 'rm', errno: 21 });
    }
    try {
      if (stat.isDirectory()) yield* rmdirRecursiveStep(abs);
      else yield* unlinkOp(abs);
    } catch (e) {
      if (!gone(e)) throw e;
    }
  }

  function* rmdirOp(path: string | URL, options?: { recursive?: boolean }): Op<void> {
    const abs = resolvePath(cwd, path);
    if (options?.recursive) {
      yield* rmdirRecursiveStep(abs);
    } else {
      yield* step('rmdir', abs, (f) => {
        if (f.rmdir === undefined) throw lacks('rmdir', abs);
        return f.rmdir(abs);
      });
    }
  }

  function* renameOp(oldPath: string | URL, newPath: string | URL): Op<void> {
    const abs1 = resolvePath(cwd, oldPath);
    const abs2 = resolvePath(cwd, newPath);
    yield* step('rename', abs1, (f) => {
      if (f.rename === undefined) throw lacks('rename', abs1);
      return f.rename(abs1, abs2);
    });
  }

  function* copyFileOp(src: string | URL, dest: string | URL): Op<void> {
    const abs1 = resolvePath(cwd, src);
    const abs2 = resolvePath(cwd, dest);
    yield* step('copyfile', abs1, (f) => {
      if (f.copyFile === undefined) throw lacks('copyfile', abs1);
      return f.copyFile(abs1, abs2);
    });
  }

  function* chmodOp(path: string | URL, mode: number | string): Op<void> {
    const abs = resolvePath(cwd, path);
    const bits = parseFileMode(mode, 'mode');
    yield* step('chmod', abs, (f) => {
      if (f.chmod === undefined) throw lacks('chmod', abs);
      return f.chmod(abs, bits);
    });
  }

  // chown(2) and lchown(2): a side Node's -1 names keeps the file's, in the same change.
  function* chownAt(path: string | URL, owner: number | null, group: number | null, follow: boolean): Op<void> {
    const abs = resolvePath(cwd, path);
    const syscall = follow ? 'chown' : 'lchown';
    yield* step(syscall, abs, (f) => {
      if (f.chown === undefined) throw lacks(syscall, abs);
      return f.chown(abs, owner, group, follow);
    });
  }

  /** chown as its `*Sync` form and its promise take it: the path, then the ids, checked as they are used. */
  function* chownOp(path: string | URL, uid: number, gid: number, follow: boolean): Op<void> {
    const abs = resolvePath(cwd, path);
    yield* chownAt(abs, nodeOwnerId(uid, 'uid'), nodeOwnerId(gid, 'gid'), follow);
  }

  function* accessOp(path: string | URL): Op<void> {
    const abs = resolvePath(cwd, path);
    if (!(yield* step('access', abs, (f) => f.exists(abs)))) {
      throw fsError('ENOENT', 'access', abs);
    }
  }

  /** realpath(3); a missing path is `missing`'s ENOENT (Node's realpathSync lstats the path's components: a missing one is lstat's). */
  function* realpathOp(path: string | URL, missing: string): Op<string> {
    const abs = resolvePath(cwd, path);
    if (!(yield* step(missing, abs, (f) => f.exists(abs)))) {
      throw fsError('ENOENT', missing, abs);
    }
    return yield* step('realpath', abs, (f) => {
      if (f.realpath === undefined) throw lacks('realpath', abs);
      return f.realpath(abs);
    });
  }

  function* openOp(path: string | URL, flags?: string | number | null, mode?: number): Op<number> {
    const abs = resolvePath(cwd, path);
    const how = openFlagsOf(flags, mode);
    return (yield* step('open', abs, (f) => {
      if (f.open === undefined) throw lacks('open', abs);
      return f.open(abs, how);
    })) - 1 + STDIO;
  }

  function* closeOp(fd: number): Op<void> {
    yield* onDescriptor(fd, 'close', (id) => step('close', undefined, (f) => {
      if (f.close === undefined) throw lacks('close');
      return f.close(id);
    }));
  }

  function* readOp(fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null): Op<number> {
    const bytes = yield* readDescriptor(fd, positionOf(position), length);
    buffer.set(bytes, offset);
    return bytes.byteLength;
  }

  function* writeOp(fd: number, bufferOrString: Uint8Array | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | string, position?: number | null): Op<number> {
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
    return yield* onDescriptor(fd, 'write', (id) => step('write', undefined, (f) => {
      if (f.write === undefined) throw lacks('write');
      return f.write(id, at, data);
    }));
  }

  function* fstatOp(fd: number): Op<NodeStat> {
    return toNodeStat(yield* onDescriptor(fd, 'fstat', (id) => step('fstat', undefined, (f) => {
      if (f.fstat === undefined) throw lacks('fstat');
      return f.fstat(id);
    })));
  }

  /** Its length is checked before its descriptor (an int32 from 0), as Node's are. */
  function* ftruncateOp(fd: number, len?: number | null): Op<void> {
    const length = lengthOf(len);
    validateInt32(fd, 'fd', 0);
    yield* onDescriptor(fd, 'ftruncate', (id) => step('ftruncate', undefined, (f) => {
      if (f.ftruncate === undefined) throw lacks('ftruncate');
      return f.ftruncate(id, length);
    }));
  }

  function* fchownOp(fd: number, uid: number, gid: number): Op<void> {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    yield* onDescriptor(fd, 'fchown', (id) => step('fchown', undefined, (f) => {
      if (f.fchown === undefined) throw lacks('fchown');
      return f.fchown(id, owner, group);
    }));
  }

  function* fsyncOp(fd: number, syscall: string): Op<void> {
    yield* onDescriptor(fd, syscall, (id) => step(syscall, undefined, (f) => {
      if (f.fsync === undefined) throw lacks(syscall);
      return f.fsync(id);
    }));
  }

  /**
   * truncate(2) as Node makes it: the file opened for writing (its errors
   * name open), cut or zero-extended to `len` (a negative one is 0), closed.
   * The length is checked once the file is open, as Node's ftruncate checks it.
   * A face with a path's truncate is asked for it. A descriptor in place of
   * the path is ftruncate's (Node's DEP0081).
   */
  function* truncateOp(path: string | URL | Uint8Array | number, len?: number | null): Op<void> {
    if (typeof path === 'number') {
      yield* ftruncateOp(path, len);
      return;
    }
    const abs = resolvePath(cwd, path);
    const pathTruncates = yield* step('open', abs, (f) => f.truncate !== undefined);
    if (pathTruncates) {
      const length = lengthOf(len);
      yield* step('open', abs, (f) => {
        if (f.truncate === undefined) throw lacks('open', abs);
        return f.truncate(abs, length);
      });
      return;
    }
    const fd = yield* step('open', abs, (f) => {
      if (f.open === undefined) throw lacks('open', abs);
      return f.open(abs, openFlagsOf('r+', undefined));
    });
    try {
      const length = lengthOf(len);
      yield* step('ftruncate', undefined, (f) => {
        if (f.ftruncate === undefined) throw lacks('ftruncate');
        return f.ftruncate(fd, length);
      });
    } finally {
      yield* step('close', undefined, (f) => {
        if (f.close === undefined) throw lacks('close');
        return f.close(fd);
      });
    }
  }

  /** symlink(2): the link at `path` holds `target` as given (a relative target stays relative, read from the link's directory). */
  function* symlinkOp(target: string | URL | Uint8Array, path: string | URL | Uint8Array): Op<void> {
    const text = pathText(target);
    const abs = resolvePath(cwd, path);
    yield* step('symlink', abs, (f) => {
      if (f.symlink === undefined) throw lacks('symlink', abs);
      return f.symlink(text, abs);
    });
  }

  /** readlink(2): the link's text in `encoding` (UTF-8 by default), or its bytes with `encoding: 'buffer'`. */
  function* readlinkOp(path: string | URL | Uint8Array, options?: string | { encoding?: string | null } | null): Op<string | Buffer> {
    // No encoding, or an empty one, is UTF-8, as Node takes it.
    const encoding = (typeof options === 'string' ? options : options?.encoding) || 'utf8';
    if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) throw invalidArgValue('encoding', encoding, 'is invalid encoding');
    const abs = resolvePath(cwd, path);
    const text = yield* step('readlink', abs, (f) => {
      if (f.readlink === undefined) throw lacks('readlink', abs);
      return f.readlink(abs);
    });
    if (encoding === 'buffer') return Buffer.from(text);
    return encoding === 'utf8' ? text : Buffer.from(text).toString(encoding);
  }

  // ─── Sync API ───

  const readFileSync = (path: string | URL | number, options?: string | { encoding?: string; flag?: string }) => sync('readFileSync', readFileOp(path, options));
  const writeFileSync = (path: string | URL, data: string | Uint8Array, _options?: string | { encoding?: string }) => sync('writeFileSync', writeFileOp(path, data));
  const appendFileSync = (path: string | URL, data: string | Uint8Array) => sync('appendFileSync', appendFileOp(path, data));
  const existsSync = (path: string | URL) => sync('existsSync', existsOp(path));
  const statSync = (path: string | URL) => sync('statSync', statOp(path));
  const lstatSync = (path: string | URL) => sync('lstatSync', lstatOp(path));
  const mkdirSync = (path: string | URL, options?: { recursive?: boolean; mode?: number | string | null } | number | string | null) => sync('mkdirSync', mkdirOp(path, options));
  const readdirSync = (path: string | URL, options?: { encoding?: string; withFileTypes?: boolean }) => sync('readdirSync', readdirOp(path, options));
  const unlinkSync = (path: string | URL) => sync('unlinkSync', unlinkOp(path));
  const rmSync = (path: string | URL, options?: { recursive?: boolean; force?: boolean }) => sync('rmSync', rmOp(path, options));
  const rmdirSync = (path: string | URL, options?: { recursive?: boolean }) => sync('rmdirSync', rmdirOp(path, options));
  const renameSync = (oldPath: string | URL, newPath: string | URL) => sync('renameSync', renameOp(oldPath, newPath));
  const copyFileSync = (src: string | URL, dest: string | URL) => sync('copyFileSync', copyFileOp(src, dest));
  const chmodSync = (path: string | URL, mode: number | string) => sync('chmodSync', chmodOp(path, mode));
  const chownSync = (path: string | URL, uid: number, gid: number) => sync('chownSync', chownOp(path, uid, gid, true));
  const lchownSync = (path: string | URL, uid: number, gid: number) => sync('lchownSync', chownOp(path, uid, gid, false));
  const accessSync = (path: string | URL, _mode?: number) => sync('accessSync', accessOp(path));
  const realpathSync = Object.assign(
    function realpathSync(path: string | URL): string { return sync('realpathSync', realpathOp(path, 'lstat')); },
    { native: function realpathSyncNative(path: string | URL): string { return sync('realpathSync', realpathOp(path, 'realpath')); } },
  );
  const truncateSync = (path: string | URL | Uint8Array | number, len?: number | null) => sync('truncateSync', truncateOp(path, len));
  const openSync = (path: string | URL, flags?: string | number | null, mode?: number) => sync('openSync', openOp(path, flags, mode));
  const closeSync = (fd: number) => sync('closeSync', closeOp(fd));
  const readSync = (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => sync('readSync', readOp(fd, buffer, offset, length, position));
  const writeSync = (fd: number, bufferOrString: Uint8Array | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | string, position?: number | null) =>
    sync('writeSync', writeOp(fd, bufferOrString, offsetOrPosition, lengthOrEncoding, position));
  const fstatSync = (fd: number) => sync('fstatSync', fstatOp(fd));
  const ftruncateSync = (fd: number, len?: number | null) => sync('ftruncateSync', ftruncateOp(fd, len));
  const fchownSync = (fd: number, uid: number, gid: number) => sync('fchownSync', fchownOp(fd, uid, gid));
  const fsyncSync = (fd: number) => sync('fsyncSync', fsyncOp(fd, 'fsync'));
  const fdatasyncSync = (fd: number) => sync('fdatasyncSync', fsyncOp(fd, 'fdatasync'));
  const symlinkSync = (target: string | URL | Uint8Array, path: string | URL | Uint8Array, _type?: string | null) => sync('symlinkSync', symlinkOp(target, path));
  const readlinkSync = (path: string | URL | Uint8Array, options?: string | { encoding?: string | null } | null) => sync('readlinkSync', readlinkOp(path, options));

  /**
   * link(2), refused (ENOSYS) as the hosted node refuses it: the filesystem
   * has no hard links, and a copy would claim an inode the names do not share.
   */
  function linkSync(existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array): void {
    throw fsError('ENOSYS', 'link', pathText(existingPath), pathText(newPath));
  }

  // ─── Callback API ───

  // Their ids are checked at once, as Node's are: a bad one throws, never calls back.
  function chown(path: string | URL, uid: number, gid: number, cb: Callback<void>): void {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    callback(() => chownAt(path, owner, group, true), cb);
  }

  function lchown(path: string | URL, uid: number, gid: number, cb: Callback<void>): void {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    callback(() => chownAt(path, owner, group, false), cb);
  }

  function fchown(fd: number, uid: number, gid: number, cb: Callback<void>): void {
    const owner = nodeOwnerId(uid, 'uid');
    const group = nodeOwnerId(gid, 'gid');
    callback(() => onDescriptor(fd, 'fchown', (id) => step('fchown', undefined, (f) => {
      if (f.fchown === undefined) throw lacks('fchown');
      return f.fchown(id, owner, group);
    })), cb);
  }

  function readFile(path: string | URL, optionsOrCb: string | { encoding?: string } | Callback<string | Uint8Array>, cb?: Callback<string | Uint8Array>): void {
    const callbackFn = callbackOf<string | Uint8Array>(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    callback(() => readFileOp(path, options), callbackFn);
  }

  function writeFile(path: string | URL, data: string | Uint8Array, optionsOrCb: string | { encoding?: string } | Callback<void>, cb?: Callback<void>): void {
    callback(() => writeFileOp(path, data), callbackOf<void>(typeof optionsOrCb === 'function' ? optionsOrCb : cb));
  }

  function stat(path: string | URL, cb: Callback<NodeStat>): void {
    callback(() => statOp(path), cb);
  }

  function lstat(path: string | URL, cb: Callback<NodeStat>): void {
    callback(() => lstatOp(path), cb);
  }

  function mkdir(path: string | URL, optionsOrCb: { recursive?: boolean } | Callback<void>, cb?: Callback<void>): void {
    const callbackFn = callbackOf<void>(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    callback(() => mkdirOp(path, options), callbackFn);
  }

  function readdir(path: string | URL, optionsOrCb: { encoding?: string; withFileTypes?: boolean } | Callback<string[] | Dirent[]>, cb?: Callback<string[] | Dirent[]>): void {
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    callback(() => readdirOp(path, options), callbackOf<string[] | Dirent[]>(typeof optionsOrCb === 'function' ? optionsOrCb : cb));
  }

  function rm(path: string | URL, optionsOrCb: { recursive?: boolean; force?: boolean } | Callback<void>, cb?: Callback<void>): void {
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    const done = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    if (done) callback(() => rmOp(path, options), done);
  }

  function unlink(path: string | URL, cb: Callback<void>): void {
    callback(() => unlinkOp(path), cb);
  }

  function rename(oldPath: string | URL, newPath: string | URL, cb: Callback<void>): void {
    callback(() => renameOp(oldPath, newPath), cb);
  }

  function access(path: string | URL, modeOrCb: number | Callback<void>, cb?: Callback<void>): void {
    callback(() => accessOp(path), callbackOf<void>(typeof modeOrCb === 'function' ? modeOrCb : cb));
  }

  /** Its callback is its last argument, as Node's symlink takes it. */
  function symlink(target: string | URL | Uint8Array, path: string | URL | Uint8Array, ...rest: Array<string | null | undefined | Callback<void>>): void {
    const callbackFn = callbackOf<void>(rest.length === 0 ? path : rest[rest.length - 1]);
    callback(() => symlinkOp(target, path), callbackFn);
  }

  function readlink(path: string | URL | Uint8Array, optionsOrCb: string | { encoding?: string | null } | null | undefined | Callback<string | Buffer>, cb?: Callback<string | Buffer>): void {
    const callbackFn = callbackOf<string | Buffer>(typeof optionsOrCb === 'function' ? optionsOrCb : cb);
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    callback(() => readlinkOp(path, options), callbackFn);
  }

  function link(existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array, cb?: Callback<void>): void {
    const callbackFn = callbackOf<void>(cb);
    const from = pathText(existingPath);
    const to = pathText(newPath);
    callback(function* () { linkSync(from, to); }, callbackFn);
  }

  /** Its length and callback are checked before anything is done, as Node's are. */
  function truncate(path: string | URL | Uint8Array | number, lenOrCb?: number | null | Callback<void>, cb?: Callback<void>): void {
    if (typeof path === 'number') {
      ftruncate(path, lenOrCb, cb);
      return;
    }
    const length = lengthOf(typeof lenOrCb === 'function' ? undefined : lenOrCb);
    const callbackFn = callbackOf<void>(typeof lenOrCb === 'function' ? lenOrCb : cb);
    callback(() => truncateOp(path, length), callbackFn);
  }

  /** Its length, callback and descriptor are checked before anything is done, in that order, as Node's are. */
  function ftruncate(fd: number, lenOrCb?: number | null | Callback<void>, cb?: Callback<void>): void {
    const length = lengthOf(typeof lenOrCb === 'function' ? undefined : lenOrCb);
    const callbackFn = callbackOf<void>(typeof lenOrCb === 'function' ? lenOrCb : cb);
    validateInt32(fd, 'fd', 0);
    callback(() => ftruncateOp(fd, length), callbackFn);
  }

  function exists(path: string | URL, cb: (exists: boolean) => void): void {
    callback(() => existsOp(path), (err, result) => cb(err === null && result === true));
  }

  function open(path: string | URL, flagsOrCb: string | number | Callback<number>, modeOrCb?: number | Callback<number>, cb?: Callback<number>): void {
    let callbackFn: Callback<number>;
    let flags: string | number;
    let mode: number | undefined;

    if (typeof flagsOrCb === 'function') {
      callbackFn = flagsOrCb;
      flags = 'r';
    } else if (typeof modeOrCb === 'function') {
      callbackFn = modeOrCb;
      flags = flagsOrCb;
    } else {
      callbackFn = callbackOf<number>(cb);
      flags = flagsOrCb;
      mode = modeOrCb;
    }

    callback(() => openOp(path, flags, mode), callbackFn);
  }

  function close(fd: number, cb: Callback<void>): void {
    callback(() => closeOp(fd), cb);
  }

  /** Node's fs.read: its callback is given the bytes read and the buffer. */
  function read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: ReadCallback): void {
    callback(() => readOp(fd, buffer, offset, length, position), (err, bytesRead) => cb(err, bytesRead, buffer));
  }

  /**
   * Node's fs.write, (fd, buffer, offset?, length?, position?, callback) or
   * (fd, string, position?, encoding?, callback): its callback is given the
   * bytes written and what was written.
   */
  function write(fd: number, data: Uint8Array | string, ...rest: (number | string | null | undefined | WriteCallback)[]): void {
    const callbackFn = rest.pop();
    if (typeof callbackFn !== 'function') throw invalidArgType('cb', 'function', callbackFn);
    const [first, second, third] = rest.map((arg) => (typeof arg === 'function' ? undefined : arg));
    const at = (arg: typeof first): number | null | undefined => (typeof arg === 'string' ? undefined : arg);
    callback(() => (typeof data === 'string'
      ? writeOp(fd, data, at(first), typeof second === 'string' ? second : undefined)
      : writeOp(fd, data, at(first), typeof second === 'number' ? second : undefined, at(third))), (err, written) => callbackFn(err, written, data));
  }

  function fsync(fd: number, cb: Callback<void>): void {
    callback(() => fsyncOp(fd, 'fsync'), cb);
  }

  function fstat(fd: number, cb: Callback<NodeStat>): void {
    callback(() => fstatOp(fd), cb);
  }

  type RealpathOptions = string | { encoding?: string | null } | null | undefined;
  const realpath = Object.assign(
    function realpath(path: string | URL, optOrCb: RealpathOptions | Callback<string>, cb?: Callback<string>): void {
      callback(() => realpathOp(path, 'lstat'), callbackOf<string>(typeof optOrCb === 'function' ? optOrCb : cb));
    },
    {
      native: function realpathNative(path: string | URL, optOrCb: RealpathOptions | Callback<string>, cb?: Callback<string>): void {
        callback(() => realpathOp(path, 'lstat'), callbackOf<string>(typeof optOrCb === 'function' ? optOrCb : cb));
      },
    },
  );

  // ─── Stream API ───

  // The engine's own read and write streams, over this filesystem: Node's
  // ReadStream and WriteStream read and write through the `fs` they are given.
  // A face without descriptors has none to give them (ENOSYS).
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
  const streamsOpen = (path: string | URL | null | undefined): void => {
    if ((faces.sync ?? faces.async).open === undefined) throw lacks('open', streamPath(path));
  };
  class ReadStream extends engineFs.ReadStream {
    constructor(path: string | URL | null | undefined, options?: string | StreamOptions) {
      streamsOpen(path);
      reachStreams?.();
      super(streamPath(path), streamOptions(options));
    }
  }
  class WriteStream extends engineFs.WriteStream {
    constructor(path: string | URL | null | undefined, options?: string | StreamOptions) {
      streamsOpen(path);
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
   * any depth when recursive), or as the watched file itself. It is made at
   * once, so it needs the synchronous face.
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
    const face = faces.sync;
    // A watch is made at once: a face that cannot answer now, or has none, has no watch to give.
    if (face === undefined || face.watch === undefined) throw lacks('watch', given);
    let abs: string;
    try {
      if (given === '') throw fsError('ENOENT', 'watch', given);
      abs = realpathSync(filename);
    } catch (error) {
      if (errnoCodeOf(error) === 'ENOENT') throw fsError('ENOENT', 'watch', given);
      throw error;
    }
    const directory = face.isDirectory(abs);
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
    handle = face.watch(abs, changed, { persistent });

    return watcher;
  }

  // ─── Promises API ───

  const promises = {
    readFile: (path: string | URL, options?: string | { encoding?: string }) => promised(() => readFileOp(path, options)),
    writeFile: (path: string | URL, data: string | Uint8Array) => promised(() => writeFileOp(path, data)),
    appendFile: (path: string | URL, data: string | Uint8Array) => promised(() => appendFileOp(path, data)),
    stat: (path: string | URL) => promised(() => statOp(path)),
    lstat: (path: string | URL) => promised(() => lstatOp(path)),
    mkdir: (path: string | URL, options?: { recursive?: boolean }) => promised(() => mkdirOp(path, options)),
    readdir: (path: string | URL, options?: { encoding?: string; withFileTypes?: boolean }) => promised(() => readdirOp(path, options)),
    unlink: (path: string | URL) => promised(() => unlinkOp(path)),
    rmdir: (path: string | URL, options?: { recursive?: boolean }) => promised(() => rmdirOp(path, options)),
    rename: (oldPath: string | URL, newPath: string | URL) => promised(() => renameOp(oldPath, newPath)),
    copyFile: (src: string | URL, dest: string | URL) => promised(() => copyFileOp(src, dest)),
    access: (path: string | URL, _mode?: number) => promised(() => accessOp(path)),
    realpath: (path: string | URL) => promised(() => realpathOp(path, 'lstat')),
    // A path only: a descriptor is its FileHandle's truncate.
    truncate: (path: string | URL | Uint8Array, len?: number | null) => promised(function* () {
      if (typeof path === 'number') throw invalidArgType('path', ['string', 'Buffer', 'URL'], path);
      yield* truncateOp(path, len);
    }),
    symlink: (target: string | URL | Uint8Array, path: string | URL | Uint8Array, _type?: string | null) => promised(() => symlinkOp(target, path)),
    link: (existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array) => promised(function* () { linkSync(existingPath, newPath); }),
    readlink: (path: string | URL | Uint8Array, options?: string | { encoding?: string | null } | null) => promised(() => readlinkOp(path, options)),
    chmod: (path: string | URL, mode: number | string) => promised(() => chmodOp(path, mode)),
    chown: (path: string | URL, uid: number, gid: number) => promised(() => chownOp(path, uid, gid, true)),
    lchown: (path: string | URL, uid: number, gid: number) => promised(() => chownOp(path, uid, gid, false)),
    open: (path: string | URL, flags?: string | number, mode?: number) => promised(function* () {
      const fd = yield* openOp(path, flags, mode);
      let closed = false;
      // A closed handle refuses each call before its arguments, as Node's FileHandle does
      // (its descriptor number may be another file's by then); closing it again is nothing.
      const isOpen = (syscall: string): void => {
        if (closed) throw Object.assign(new Error('file closed'), { code: 'EBADF', syscall });
      };
      return {
        fd,
        close: () => promised(function* () {
          if (closed) return;
          closed = true;
          yield* closeOp(fd);
        }),
        read: (buffer: Uint8Array, offset: number, length: number, position: number | null) => promised(function* () {
          isOpen('read');
          return { bytesRead: yield* readOp(fd, buffer, offset, length, position), buffer };
        }),
        write: (data: Uint8Array | string) => promised(function* () {
          isOpen('write');
          return { bytesWritten: yield* writeOp(fd, data) };
        }),
        stat: () => promised(function* () {
          isOpen('fstat');
          return yield* fstatOp(fd);
        }),
        chown: (uid: number, gid: number) => promised(function* () {
          isOpen('fchown');
          yield* fchownOp(fd, uid, gid);
        }),
        truncate: (len?: number | null) => promised(function* () {
          isOpen('ftruncate');
          yield* ftruncateOp(fd, len);
        }),
      };
    }),
    rm: (path: string | URL, options?: { recursive?: boolean; force?: boolean }) => promised(() => rmOp(path, options)),
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
