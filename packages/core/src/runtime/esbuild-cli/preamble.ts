/**
 * esbuild-cli/preamble.ts — the `esbuild` command, esbuild-facet side.
 *
 * The real esbuild CLI (Go, compiled into esbuild.wasm) runs here as a program,
 * a fresh Go instance per invocation, in the isolate of the facet that hosts
 * esbuild. Its arguments, working directory and environment are the caller's,
 * and every file it touches goes through the supervisor capability minted for
 * the calling process, so paths resolve against the caller's cwd and outputs
 * are the caller's files. The Go heap, the module graph and the output bytes
 * never live in the session's isolate: the session sees one filesystem call
 * at a time.
 *
 * scripts/bundle-facet-workers.mjs bundles this file as an IIFE, puts Go's own
 * wasm_exec.js from the esbuild-wasm package in front of it as
 * `__esbuildGoRuntime(global, fs)`, so the Go glue is always the one
 * esbuild.wasm was built against, and stages the result as a static asset
 * (public/_assets/runtime/esbuild-cli-<buildId>.js in @nimbus-sh/worker). The
 * IIFE may contain no import, export or top-level await;
 * `globalThis.__esbuildCliRun` is its only entry point.
 */
import { supervisorFilesystem } from '../vfs-supervisor.js';
import type { RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsStat } from '../os-contracts.js';
import type { WasiSupervisorStub } from '../wasi/types.js';
import type { EsbuildCliArgs, EsbuildCliOutput, GoProgram, GoRuntimeFactory } from './types.js';

declare const __esbuildGoRuntime: GoRuntimeFactory;

type Callback = (error: Error | null, value?: unknown) => void;

// Node's open(2) flag values. Go reads them off `fs.constants`.
const O_WRONLY = 0o1, O_RDWR = 0o2, O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000;
const O_DIRECTORY = 0o200000;
const CONSTANTS = { O_RDONLY: 0, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_DIRECTORY };

// Go's syscall panics on a code missing from its errno table, so anything
// outside this one reaches it as EIO.
const GO_ERRNO_CODES: Record<string, true> = {
  EPERM: true, ENOENT: true, EINTR: true, EIO: true, EBADF: true, EAGAIN: true, ENOMEM: true, EACCES: true,
  EBUSY: true, EEXIST: true, EXDEV: true, ENOTDIR: true, EISDIR: true, EINVAL: true, EMFILE: true, ENOTTY: true,
  EFBIG: true, ENOSPC: true, ESPIPE: true, EROFS: true, EMLINK: true, EPIPE: true, ENAMETOOLONG: true,
  ENOTEMPTY: true, ENOSYS: true,
};

// One write call, to a file or to the caller's stdout/stderr, carries at most
// this many bytes, so the session holds a slice of an output at a time.
const WRITE_SLICE_BYTES = 1 << 20;

const S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFIFO = 0o010000;

interface GoStats {
  dev: number; ino: number; mode: number; nlink: number; uid: number; gid: number; rdev: number;
  size: number; blksize: number; blocks: number; atimeMs: number; mtimeMs: number; ctimeMs: number;
  isDirectory(): boolean;
}

type OpenFile =
  | { kind: 'bytes'; path: string; bytes: Uint8Array; stat: GoStats; position: number }
  | { kind: 'directory'; path: string; stat: GoStats }
  | { kind: 'handle'; path: string; handle: number };

interface ProcessState { cwd: string; umask: number }

function errno(code: string, detail: string): Error {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

function goError(error: unknown): Error {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message), {
    code: typeof code === 'string' && GO_ERRNO_CODES[code] ? code : 'EIO',
  });
}

function resolvePath(cwd: string, path: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function goStats(stat: RuntimeVfsStat, size = stat.size): GoStats {
  const type = stat.type === 'directory' ? S_IFDIR : stat.type === 'symlink' ? S_IFLNK : S_IFREG;
  return {
    dev: stat.dev, ino: stat.ino, mode: type | (stat.mode & 0o7777), nlink: stat.nlink,
    uid: stat.uid, gid: stat.gid, rdev: 0, size, blksize: 4096, blocks: Math.ceil(size / 512),
    atimeMs: stat.atime, mtimeMs: stat.mtime, ctimeMs: stat.ctime,
    isDirectory: () => stat.type === 'directory',
  };
}

/**
 * The program's three standard descriptors. stdout and stderr go to the
 * caller as the program writes them, in slices, awaited one at a time.
 */
class Stdio {
  private stdinOffset = 0;
  /** Go's runtime prints synchronously; those bytes go out at the next chance to await. */
  private readonly held: Array<{ fd: 1 | 2; bytes: Uint8Array }> = [];
  constructor(private readonly stdin: Uint8Array | null, private readonly output: EsbuildCliOutput) {}

  hold(fd: 1 | 2, bytes: Uint8Array): void {
    this.held.push({ fd, bytes });
  }

  async write(fd: 1 | 2, bytes: Uint8Array): Promise<void> {
    await this.flush();
    for (let done = 0; done < bytes.length; done += WRITE_SLICE_BYTES) {
      await this.output(fd, bytes.slice(done, done + WRITE_SLICE_BYTES));
    }
  }

  async flush(): Promise<void> {
    for (let next = this.held.shift(); next; next = this.held.shift()) {
      await this.output(next.fd, next.bytes);
    }
  }

  read(buffer: Uint8Array, offset: number, length: number): number {
    const input = this.stdin ?? new Uint8Array(0);
    const chunk = input.subarray(this.stdinOffset, this.stdinOffset + length);
    buffer.set(chunk, offset);
    this.stdinOffset += chunk.length;
    return chunk.length;
  }
}

const isOutput = (fd: number): fd is 1 | 2 => fd === 1 || fd === 2;

/**
 * Node's callback `fs`, the surface Go's syscall package calls, over the
 * session filesystem. A file opened read-only is fetched whole when it is
 * opened (esbuild reads every file it opens to the end); anything opened for
 * writing is a handle in the session, written in bounded slices.
 */
function goFilesystem(vfs: RuntimeFsBridge, stdio: Stdio, state: ProcessState, live: () => boolean, crash: (error: unknown) => void) {
  const files = new Map<number, OpenFile>();
  let nextFd = 3;
  const at = (path: string) => resolvePath(state.cwd, path);
  const add = (file: OpenFile) => { const fd = nextFd++; files.set(fd, file); return fd; };
  const file = (fd: number): OpenFile => {
    const open = files.get(fd);
    if (!open) throw errno('EBADF', `fd ${fd}`);
    return open;
  };
  const settle = (work: () => unknown, callback: Callback): void => {
    Promise.resolve().then(work).then(
      (value) => { if (live()) deliver(callback, null, value); },
      (error: unknown) => { if (live()) deliver(callback, goError(error), undefined); },
    );
  };
  // A callback re-enters the Go program; a trap raised in there has no other way out.
  const deliver = (callback: Callback, error: Error | null, value: unknown): void => {
    try { callback(error, value); } catch (trap) { crash(trap); }
  };
  const stat = async (path: string, followSymlinks: boolean): Promise<GoStats> => {
    const found = await vfs.stat(path, { followSymlinks });
    if (!found) throw errno('ENOENT', path);
    return goStats(found);
  };

  const fs = {
    constants: CONSTANTS,
    writeSync(fd: number, buffer: Uint8Array): number {
      // A view of Go's own memory, valid only for this call.
      if (isOutput(fd)) stdio.hold(fd, buffer.slice());
      return buffer.length;
    },
    write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback): void {
      settle(async () => {
        const data = buffer.subarray(offset, offset + length);
        if (isOutput(fd)) {
          await stdio.write(fd, data);
          return length;
        }
        const open = file(fd);
        if (open.kind !== 'handle') throw errno('EBADF', `fd ${fd} is not open for writing`);
        for (let done = 0; done < length;) {
          // A copy: a view would carry its whole buffer across the RPC.
          const slice = data.slice(done, Math.min(length, done + WRITE_SLICE_BYTES));
          const written = await vfs.write(open.handle, position === null ? null : position + done, slice);
          if (written <= 0) throw errno('EIO', `short write to ${open.path}`);
          done += written;
        }
        return length;
      }, callback);
    },
    read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback): void {
      settle(async () => {
        if (fd === 0) return stdio.read(buffer, offset, length);
        const open = file(fd);
        if (open.kind === 'directory') throw errno('EISDIR', open.path);
        if (open.kind === 'bytes') {
          const start = position ?? open.position;
          const chunk = open.bytes.subarray(start, start + length);
          buffer.set(chunk, offset);
          if (position === null) open.position += chunk.length;
          return chunk.length;
        }
        const bytes = await vfs.read(open.handle, position, length);
        buffer.set(bytes, offset);
        return bytes.length;
      }, callback);
    },
    open(path: string, flags: number, mode: number, callback: Callback): void {
      settle(async () => {
        const target = at(path);
        const access = flags & 3;
        if (access === 0 && (flags & (O_CREAT | O_TRUNC | O_APPEND)) === 0) {
          const found = await vfs.stat(target);
          if (!found) throw errno('ENOENT', target);
          if (found.type === 'directory') return add({ kind: 'directory', path: target, stat: goStats(found) });
          if (flags & O_DIRECTORY) throw errno('ENOTDIR', target);
          const bytes = await vfs.readFile(target);
          if (!bytes) throw errno('ENOENT', target);
          return add({ kind: 'bytes', path: target, bytes, stat: goStats(found, bytes.length), position: 0 });
        }
        const openFlags: RuntimeOpenFlags = {
          read: access === O_RDWR,
          write: true,
          create: (flags & O_CREAT) !== 0,
          exclusive: (flags & O_EXCL) !== 0,
          truncate: (flags & O_TRUNC) !== 0,
          append: (flags & O_APPEND) !== 0,
          mode,
        };
        const handle = await vfs.open(target, openFlags);
        return add({ kind: 'handle', path: target, handle: handle.id });
      }, callback);
    },
    close(fd: number, callback: Callback): void {
      settle(async () => {
        const open = file(fd);
        files.delete(fd);
        if (open.kind === 'handle') await vfs.close(open.handle);
      }, callback);
    },
    fstat(fd: number, callback: Callback): void {
      settle(async () => {
        if (fd <= 2) {
          return {
            dev: 0, ino: fd, mode: S_IFIFO | 0o600, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0,
            blksize: 4096, blocks: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, isDirectory: () => false,
          } satisfies GoStats;
        }
        const open = file(fd);
        return open.kind === 'handle' ? goStats(await vfs.fstat(open.handle)) : open.stat;
      }, callback);
    },
    stat(path: string, callback: Callback): void { settle(() => stat(at(path), true), callback); },
    lstat(path: string, callback: Callback): void { settle(() => stat(at(path), false), callback); },
    readdir(path: string, callback: Callback): void {
      settle(async () => (await vfs.readdir(at(path))).map((entry) => entry.name), callback);
    },
    mkdir(path: string, perm: number, callback: Callback): void {
      settle(() => vfs.mkdir(at(path), { mode: perm }), callback);
    },
    rmdir(path: string, callback: Callback): void { settle(() => vfs.rmdir(at(path)), callback); },
    unlink(path: string, callback: Callback): void { settle(() => vfs.unlink(at(path)), callback); },
    rename(from: string, to: string, callback: Callback): void { settle(() => vfs.rename(at(from), at(to)), callback); },
    readlink(path: string, callback: Callback): void {
      settle(async () => {
        const target = await vfs.readlink(at(path));
        if (target === null) throw errno('EINVAL', `${path} is not a symbolic link`);
        return target;
      }, callback);
    },
    symlink(target: string, path: string, callback: Callback): void { settle(() => vfs.symlink(target, at(path)), callback); },
    link(_existing: string, path: string, callback: Callback): void {
      settle(() => { throw errno('ENOSYS', `hard links are not supported: ${path}`); }, callback);
    },
    chmod(path: string, mode: number, callback: Callback): void { settle(() => vfs.chmod(at(path), mode), callback); },
    fchmod(fd: number, mode: number, callback: Callback): void {
      settle(() => { const open = file(fd); return open.kind === 'handle' ? vfs.fchmod(open.handle, mode) : vfs.chmod(open.path, mode); }, callback);
    },
    chown(path: string, uid: number, gid: number, callback: Callback): void { settle(() => vfs.chown(at(path), uid, gid), callback); },
    lchown(path: string, uid: number, gid: number, callback: Callback): void {
      settle(() => vfs.chown(at(path), uid, gid, { followSymlinks: false }), callback);
    },
    fchown(fd: number, uid: number, gid: number, callback: Callback): void {
      settle(() => { const open = file(fd); return open.kind === 'handle' ? vfs.fchown(open.handle, uid, gid) : vfs.chown(open.path, uid, gid); }, callback);
    },
    utimes(path: string, atime: number, mtime: number, callback: Callback): void {
      settle(() => vfs.utimes(at(path), atime * 1000, mtime * 1000), callback);
    },
    truncate(path: string, length: number, callback: Callback): void { settle(() => vfs.truncate(at(path), length), callback); },
    ftruncate(fd: number, length: number, callback: Callback): void {
      settle(() => { const open = file(fd); if (open.kind !== 'handle') throw errno('EBADF', `fd ${fd} is not open for writing`); return vfs.ftruncate(open.handle, length); }, callback);
    },
    fsync(fd: number, callback: Callback): void {
      settle(() => { const open = file(fd); return open.kind === 'handle' ? vfs.fsync(open.handle) : undefined; }, callback);
    },
  };
  return { fs, files };
}

globalThis.__esbuildCliRun = async function __esbuildCliRun(
  args: EsbuildCliArgs,
  supervisor: WasiSupervisorStub,
  output: EsbuildCliOutput,
  module: WebAssembly.Module,
): Promise<number> {
  const stdio = new Stdio(args.stdin, output);
  const vfs = supervisorFilesystem(supervisor);
  const state: ProcessState = { cwd: args.cwd, umask: args.umask };
  let go: GoProgram | null = null;
  let crash: (error: unknown) => void = () => {};
  const crashed = new Promise<never>((_, reject) => { crash = reject; });
  const { fs, files } = goFilesystem(vfs, stdio, state, () => go !== null && !go.exited, (error) => crash(error));
  const process = {
    pid: 1,
    ppid: 0,
    getuid: () => args.uid,
    geteuid: () => args.uid,
    getgid: () => args.gid,
    getegid: () => args.gid,
    getgroups: () => args.groups,
    umask(mask?: number): number {
      const prior = state.umask;
      if (typeof mask === 'number') state.umask = mask;
      return prior;
    },
    cwd: () => state.cwd,
    chdir(path: string): void { state.cwd = resolvePath(state.cwd, path); },
  };
  const Go = __esbuildGoRuntime({ Object, Array, Uint8Array, TextEncoder, TextDecoder, crypto, performance, fs, process }, fs);
  const program = new Go();
  go = program;
  program.argv = ['esbuild', ...args.argv];
  program.env = args.env;
  let exitCode = 0;
  program.exit = (code) => { exitCode = code; };
  try {
    const instance = await WebAssembly.instantiate(module, program.importObject);
    await Promise.race([program.run(instance), crashed]);
  } catch (error) {
    stdio.hold(2, new TextEncoder().encode(`esbuild: ${error instanceof Error ? error.message : String(error)}\n`));
    exitCode = exitCode || 1;
  } finally {
    for (const timer of program._scheduledTimeouts.values()) clearTimeout(timer);
    for (const open of files.values()) {
      if (open.kind === 'handle') await Promise.resolve(vfs.close(open.handle)).catch(() => undefined);
    }
    files.clear();
  }
  await stdio.flush();
  return exitCode;
};
