/**
 * napi-wasm-loader.ts — loads a threadless napi-rs binding (build.mjs) into a
 * host with one thread and an event loop (a Nimbus node process, or Node).
 *
 * Replaces upstream's generated `<binary>.wasi.cjs`, which needs `node:wasi`,
 * `worker_threads` and a shared memory. Here:
 *
 *   - N-API comes from @emnapi/core's non-threaded model: async work and
 *     threadsafe functions are its JavaScript plugins, dispatched on the event
 *     loop instead of a uv thread pool.
 *   - WASI is Nimbus's filesystem codec (`installAuthorityFilesystem`, the
 *     one bash and CPython run on) over the host's own `fs` module, so the
 *     binding sees exactly the files, write cache and credentials the calling
 *     process does. Everything else WASI needs is a few lines below.
 *   - A binding with async fns (rolldown) exports an event-loop-driven tokio
 *     runtime (scripts/napi-wasm/rolldown/binding): its tasks run when this
 *     loader pumps them (`nimbus_napi_pump`), after the binding asks
 *     (`nimbus_napi.request_pump`, when a task is spawned) and after any napi
 *     callback while tasks are alive (a callback is how JavaScript wakes a
 *     task awaiting it). A binding without one (satteri, the Astro compiler)
 *     is plain synchronous napi plus emnapi's async work.
 *   - With JSPI, the pump runs under `WebAssembly.promising` through the wasi
 *     trampoline (wasi-trampoline.mjs): a file the host does not hold in
 *     memory is then read asynchronously and the pump resumes, instead of
 *     failing with EAGAIN. Synchronous napi entries never suspend.
 */

import { instantiateNapiModuleSync } from '@emnapi/core';
import { asyncWork, tsfn } from '@emnapi/core/plugins';
import { createContext } from '@emnapi/runtime';
import type * as NodeFsModule from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  installAuthorityFilesystem,
  type FilesystemFd,
  type FilesystemImports,
} from '../../../../core/src/runtime/wasi/filesystem.js';
import type {
  Awaitable,
  RuntimeFileHandle,
  RuntimeFsBridge,
  RuntimeFsPath,
  RuntimeOpenFlags,
  RuntimeVfsStat,
} from '../../../../core/src/runtime/os-contracts.js';

/** Build-time constant (build.mjs `define`). */
declare const __NIMBUS_NAPI_WASM_DISPATCHED__: readonly string[];

type NodeFs = typeof NodeFsModule;
type WasmFn = (...args: never[]) => unknown;

export interface NapiWasmBindingHost {
  /** The calling process's `fs`. Nimbus's node-shims provide it in a guest. */
  fs: NodeFs;
  env: Record<string, string | undefined>;
  writeStdout(bytes: Uint8Array): void;
  writeStderr(bytes: Uint8Array): void;
  /** The binding, compiled ahead of time (a Worker Loader module-map member in Nimbus). */
  binding: WebAssembly.Module;
  /** The wasi trampoline, compiled the same way. */
  trampoline: WebAssembly.Module;
  /** Wasm pages the binding's imported memory starts at (its declared minimum). */
  memoryPages: number;
  /**
   * The binding's linear memory, when the host makes it (to watch what the
   * binding grows to): `memoryPages` initial pages, maximum 65536, unshared.
   * Absent: the loader makes it.
   */
  memory?: WebAssembly.Memory;
  /** The binding's name, for diagnostics. */
  name: string;
  /**
   * Called once if the binding dies: a trap (a Rust panic aborts), or the
   * host's stack overflowing inside it (a RangeError). The instance is
   * unusable from then on and no promise it holds will settle, so the host
   * settles its own callers and drops the binding. Absent: the error is
   * thrown as an uncaught one.
   */
  onFatal?(error: unknown): void;
}

/** What the loader calls on the binding instance besides napi. */
interface BindingExports {
  _initialize(): void;
  /** Present on a binding built with the event-loop runtime. */
  nimbus_napi_pump?(budget: number): number;
  nimbus_napi_alive_tasks?(): number;
}

/** Task polls one pump turn may run before it yields to the event loop. */
const PUMP_BUDGET = 4096;
/** Every read-only open is answered from one read of the whole file. */
const RESIDENT_OPEN_BYTES = 0x7fffffff;

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** POSIX-normalize an absolute path; `..` stops at the root. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return '/' + out.join('/');
}

interface BridgeHandle extends RuntimeFileHandle {
  /** A synchronous descriptor, when the host could open the file without waiting. */
  fd?: number;
  /** An asynchronous one, when it could not (content not resident). */
  file?: FileHandle;
}

/**
 * The host's `fs` as the codec's filesystem authority. `suspend` says whether
 * an operation may answer with a Promise: only the pump's stack can wait, so
 * the synchronous bridge rethrows the host's EAGAIN ("exists, not resident")
 * and the codec returns it to the guest as an errno.
 */
function nodeFsBridge(fs: NodeFs, handles: Map<number, BridgeHandle>, nextHandle: { value: number }, suspend: boolean): RuntimeFsBridge {
  const promises = fs.promises;
  const C = fs.constants;
  const attempt = <T>(sync: () => T, later: () => Promise<T>): Awaitable<T> => {
    try {
      return sync();
    } catch (error) {
      if (suspend && errorCode(error) === 'EAGAIN') return later();
      throw error;
    }
  };
  const orNullWhenAbsent = (error: unknown): null => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  };
  const handle = (id: number): BridgeHandle => {
    const h = handles.get(id);
    if (!h || h.closed) fail('EBADF');
    return h;
  };
  const resolve = (p: RuntimeFsPath): string => {
    if (typeof p === 'string') return normalize(p);
    if ('root' in p) return normalize(p.root + '/' + p.path);
    return normalize(handle(p.directory).path + '/' + p.path);
  };
  // Node's Stats carry dev/ino/nlink; a Nimbus guest's fs names files by path
  // and leaves them out. WASI's filestat needs all three as integers, so a
  // missing inode is the path's own FNV-1a (distinct files, distinct inodes,
  // stable across calls) and a missing link count is 1.
  const toStat = (st: Stats, path: string): RuntimeVfsStat => {
    let ino = Number(st.ino);
    if (!Number.isSafeInteger(ino) || ino === 0) {
      ino = 0x811c9dc5;
      for (let i = 0; i < path.length; i++) ino = Math.imul(ino ^ path.charCodeAt(i), 0x01000193) >>> 0;
    }
    const integer = (value: unknown, fallback: number) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback);
    return {
      dev: integer(st.dev, 0),
      ino,
      nlink: integer(st.nlink, 1),
      type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file',
      size: integer(st.size, 0),
      ctime: st.ctime.getTime(),
      atime: st.atime.getTime(),
      mtime: st.mtime.getTime(),
      mode: integer(st.mode, 0),
      uid: integer(st.uid, 0),
      gid: integer(st.gid, 0),
      revision: st.mtime.getTime(),
    };
  };
  const openFlags = (flags: RuntimeOpenFlags): number =>
    (flags.write ? (flags.read ? C.O_RDWR : C.O_WRONLY) : C.O_RDONLY)
    | (flags.create ? C.O_CREAT : 0)
    | (flags.exclusive ? C.O_EXCL : 0)
    | (flags.truncate ? C.O_TRUNC : 0)
    | (flags.append ? C.O_APPEND : 0);
  const register = (path: string, flags: RuntimeOpenFlags, io: { fd?: number; file?: FileHandle }): BridgeHandle => {
    const h: BridgeHandle = {
      id: nextHandle.value++,
      path,
      flags: {
        read: !!flags.read, write: !!flags.write, append: !!flags.append, create: !!flags.create,
        exclusive: !!flags.exclusive, directory: !!flags.directory, truncate: !!flags.truncate,
        followSymlinks: flags.followSymlinks !== false,
      },
      position: 0,
      closed: false,
      ...io,
    };
    handles.set(h.id, h);
    return h;
  };
  const stat = (path: string, followSymlinks: boolean | undefined): Awaitable<RuntimeVfsStat | null> => {
    try {
      return toStat(followSymlinks === false ? fs.lstatSync(path) : fs.statSync(path), path);
    } catch (error) {
      if (suspend && errorCode(error) === 'EAGAIN') {
        return (followSymlinks === false ? promises.lstat(path) : promises.stat(path)).then((st) => toStat(st, path), orNullWhenAbsent);
      }
      return orNullWhenAbsent(error);
    }
  };
  const readdir = (path: string) => {
    const entries = (list: Dirent[]) => list.map((d) => ({
      name: String(d.name),
      type: d.isDirectory() ? 'directory' as const : d.isSymbolicLink() ? 'symlink' as const : 'file' as const,
    }));
    return attempt(
      () => entries(fs.readdirSync(path, { withFileTypes: true })),
      async () => entries(await promises.readdir(path, { withFileTypes: true })),
    );
  };

  const bridge = {
    stat: (p: RuntimeFsPath, o?: { followSymlinks?: boolean }) => stat(resolve(p), o?.followSymlinks),
    readFile: (p: RuntimeFsPath): Awaitable<Uint8Array | null> => {
      const path = resolve(p);
      try {
        return fs.readFileSync(path);
      } catch (error) {
        if (suspend && errorCode(error) === 'EAGAIN') return promises.readFile(path).catch(orNullWhenAbsent);
        return orNullWhenAbsent(error);
      }
    },
    open: (p: RuntimeFsPath, flags: RuntimeOpenFlags): Awaitable<BridgeHandle> => {
      const path = resolve(p);
      if (flags.directory) {
        // A directory's metadata is always answerable without waiting.
        if (!fs.statSync(path).isDirectory()) fail('ENOTDIR');
        return register(path, flags, {});
      }
      const mode = flags.mode ?? 0o666;
      return attempt(
        () => register(path, flags, { fd: fs.openSync(path, openFlags(flags), mode) }),
        async () => register(path, flags, { file: await promises.open(path, openFlags(flags), mode) }),
      );
    },
    fstat: (id: number): Awaitable<RuntimeVfsStat> => {
      const h = handle(id);
      if (h.fd !== undefined) return toStat(fs.fstatSync(h.fd), h.path);
      if (h.file) return h.file.stat().then((st) => toStat(st, h.path));
      return toStat(fs.statSync(h.path), h.path);
    },
    read: (id: number, offset: number | null, length: number): Awaitable<Uint8Array> => {
      const h = handle(id);
      const position = offset ?? h.position;
      const buffer = new Uint8Array(length);
      const done = (n: number) => {
        if (offset === null) h.position += n;
        return buffer.subarray(0, n);
      };
      if (h.fd !== undefined) {
        const fd = h.fd;
        return attempt(() => done(fs.readSync(fd, buffer, 0, length, position)), async () => {
          const file = await promises.open(h.path, 'r');
          try {
            return done((await file.read(buffer, 0, length, position)).bytesRead);
          } finally {
            await file.close();
          }
        });
      }
      if (h.file) return h.file.read(buffer, 0, length, position).then((r) => done(r.bytesRead));
      return fail('EISDIR');
    },
    write: (id: number, offset: number | null, bytes: Uint8Array): Awaitable<number> => {
      const h = handle(id);
      const position = h.flags.append ? null : (offset ?? h.position);
      const done = (n: number) => {
        if (offset === null && !h.flags.append) h.position += n;
        return n;
      };
      if (h.fd !== undefined) return done(fs.writeSync(h.fd, bytes, 0, bytes.length, position));
      if (h.file) return h.file.write(bytes, 0, bytes.length, position).then((r) => done(r.bytesWritten));
      return fail('EISDIR');
    },
    close: (id: number): Awaitable<void> => {
      const h = handle(id);
      h.closed = true;
      handles.delete(id);
      if (h.fd !== undefined) fs.closeSync(h.fd);
      else if (h.file) return h.file.close();
    },
    seek: (id: number, offset: number, whence: 'set' | 'current' | 'end'): number => {
      const h = handle(id);
      if (whence === 'set') h.position = offset;
      else if (whence === 'current') h.position += offset;
      else h.position = Number((h.fd !== undefined ? fs.fstatSync(h.fd) : fs.statSync(h.path)).size) + offset;
      return h.position;
    },
    setStatus: (id: number, status: { append?: boolean }) => {
      handle(id).flags.append = !!status.append;
    },
    ftruncate: (id: number, size: number): Awaitable<void> => {
      const h = handle(id);
      if (h.fd !== undefined) return fs.ftruncateSync(h.fd, size);
      if (h.file) return h.file.truncate(size);
      return fail('EISDIR');
    },
    fsync: (id?: number): Awaitable<void> => {
      if (id === undefined) return;
      const h = handle(id);
      if (h.fd !== undefined) fs.fsyncSync(h.fd);
      else if (h.file) return h.file.sync();
    },
    futimes: (id: number, atimeMs: number, mtimeMs: number) => {
      const h = handle(id);
      if (h.fd !== undefined) fs.futimesSync(h.fd, atimeMs / 1000, mtimeMs / 1000);
      else fs.utimesSync(h.path, atimeMs / 1000, mtimeMs / 1000);
    },
    readdir: (p: RuntimeFsPath) => readdir(resolve(p)),
    readdirHandle: (id: number) => readdir(handle(id).path),
    mkdir: (p: RuntimeFsPath, o?: { recursive?: boolean; mode?: number }) => {
      fs.mkdirSync(resolve(p), { recursive: !!o?.recursive, mode: o?.mode });
    },
    rmdir: (p: RuntimeFsPath) => fs.rmdirSync(resolve(p)),
    unlink: (p: RuntimeFsPath) => fs.unlinkSync(resolve(p)),
    rename: (from: RuntimeFsPath, to: RuntimeFsPath) => fs.renameSync(resolve(from), resolve(to)),
    symlink: (target: string, p: RuntimeFsPath) => fs.symlinkSync(target, resolve(p)),
    readlink: (p: RuntimeFsPath): Awaitable<string | null> => {
      const path = resolve(p);
      const notALink = (error: unknown): null => {
        if (errorCode(error) === 'EINVAL') return null;
        throw error;
      };
      try {
        return String(fs.readlinkSync(path));
      } catch (error) {
        if (suspend && errorCode(error) === 'EAGAIN') return promises.readlink(path).then(String, notALink);
        return notALink(error);
      }
    },
    copyFile: (from: RuntimeFsPath, to: RuntimeFsPath) => fs.copyFileSync(resolve(from), resolve(to)),
    utimes: (p: RuntimeFsPath, atimeMs: number | null | undefined, mtimeMs: number | null | undefined) => {
      const now = Date.now();
      fs.utimesSync(resolve(p), (atimeMs ?? now) / 1000, (mtimeMs ?? now) / 1000);
    },
  };
  // The codec calls only the members above; the bridge contract's remaining
  // members (revision, acquire, list, …) belong to the supervisor authority.
  const authority = bridge as unknown as RuntimeFsBridge;
  return authority;
}

/**
 * The non-filesystem half of WASI preview1: what the binding imports besides
 * files. Clocks, entropy, environment, stdio and the root preopen; no
 * sockets, no threads, no process exit.
 */
function baseWasiImports(host: NapiWasmBindingHost, memory: () => WebAssembly.Memory, fds: Map<number, FilesystemFd>) {
  const view = () => new DataView(memory().buffer);
  const bytes = () => new Uint8Array(memory().buffer);
  const encoder = new TextEncoder();
  const environ = Object.entries(host.env)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, v]) => encoder.encode(`${k}=${v}\0`));
  const stdio = (fd: number) => {
    const e = fds.get(fd);
    return e && (e.kind === 'stdin' || e.kind === 'stdout' || e.kind === 'stderr') ? e.kind : null;
  };
  return {
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, environ.length, true);
      view().setUint32(size, environ.reduce((n, e) => n + e.length, 0), true);
      return ERRNO_SUCCESS;
    },
    environ_get(ptrs: number, buf: number) {
      let at = buf;
      environ.forEach((e, i) => {
        view().setUint32(ptrs + i * 4, at, true);
        bytes().set(e, at);
        at += e.length;
      });
      return ERRNO_SUCCESS;
    },
    args_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return ERRNO_SUCCESS;
    },
    args_get() {
      return ERRNO_SUCCESS;
    },
    clock_res_get(_id: number, out: number) {
      view().setBigUint64(out, 1000n, true);
      return ERRNO_SUCCESS;
    },
    clock_time_get(id: number, _precision: bigint, out: number) {
      const ns = id === 0
        ? BigInt(Date.now()) * 1_000_000n
        : BigInt(Math.round(performance.now() * 1_000_000));
      view().setBigUint64(out, ns, true);
      return ERRNO_SUCCESS;
    },
    random_get(buf: number, length: number) {
      // getRandomValues fills at most 64 KiB per call.
      for (let at = 0; at < length; at += 65536) {
        crypto.getRandomValues(bytes().subarray(buf + at, buf + Math.min(length, at + 65536)));
      }
      return ERRNO_SUCCESS;
    },
    sched_yield() {
      return ERRNO_SUCCESS;
    },
    proc_exit(code: number): never {
      throw new Error(`${host.name} binding called proc_exit(${code})`);
    },
    fd_prestat_get(fd: number, out: number) {
      const e = fds.get(fd);
      if (e?.kind !== 'preopen') return ERRNO_BADF;
      view().setUint8(out, 0);
      view().setUint32(out + 4, encoder.encode(e.wasiPath).length, true);
      return ERRNO_SUCCESS;
    },
    fd_prestat_dir_name(fd: number, ptr: number, length: number) {
      const e = fds.get(fd);
      if (e?.kind !== 'preopen') return ERRNO_BADF;
      bytes().set(encoder.encode(e.wasiPath).subarray(0, length), ptr);
      return ERRNO_SUCCESS;
    },
    // Stdio. The codec hands these every descriptor it does not own.
    fd_write(fd: number, iovs: number, count: number, written: number) {
      const kind = stdio(fd);
      if (kind !== 'stdout' && kind !== 'stderr') return ERRNO_BADF;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        chunks.push(bytes().slice(ptr, ptr + len));
        total += len;
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      if (kind === 'stderr') host.writeStderr(out);
      else host.writeStdout(out);
      view().setUint32(written, total, true);
      return ERRNO_SUCCESS;
    },
    fd_read(fd: number, _iovs: number, _count: number, read: number) {
      if (stdio(fd) !== 'stdin') return ERRNO_BADF;
      view().setUint32(read, 0, true);
      return ERRNO_SUCCESS;
    },
    fd_close(fd: number) {
      return stdio(fd) ? ERRNO_SUCCESS : ERRNO_BADF;
    },
    fd_fdstat_get(fd: number, out: number) {
      if (!stdio(fd)) return ERRNO_BADF;
      bytes().fill(0, out, out + 24);
      view().setUint8(out, 2); // character device
      view().setBigUint64(out + 8, 0x1fffffffn, true);
      view().setBigUint64(out + 16, 0x1fffffffn, true);
      return ERRNO_SUCCESS;
    },
  };
}

/**
 * poll_oneoff: every subscription is reported ready. A clock subscription is
 * a sleep; on the pump's stack it really waits (the JSPI form), and anywhere
 * else it returns at once, since a synchronous wait would hold the only
 * thread.
 */
function pollOneoff(memory: () => WebAssembly.Memory, wait: boolean) {
  return (inPtr: number, outPtr: number, count: number, eventsPtr: number): Awaitable<number> => {
    const view = new DataView(memory().buffer);
    let sleepNs = 0n;
    const events: Array<[bigint, number]> = [];
    for (let i = 0; i < count; i++) {
      const sub = inPtr + i * 48;
      const tag = view.getUint8(sub + 8);
      if (tag === 0 && (view.getUint16(sub + 40, true) & 1) === 0) {
        const timeout = view.getBigUint64(sub + 24, true);
        if (timeout > sleepNs) sleepNs = timeout;
      }
      events.push([view.getBigUint64(sub, true), tag]);
    }
    const report = () => {
      const out = new DataView(memory().buffer);
      new Uint8Array(memory().buffer).fill(0, outPtr, outPtr + events.length * 32);
      events.forEach(([userdata, tag], i) => {
        out.setBigUint64(outPtr + i * 32, userdata, true);
        out.setUint8(outPtr + i * 32 + 10, tag);
      });
      out.setUint32(eventsPtr, events.length, true);
      return ERRNO_SUCCESS;
    };
    if (!wait || sleepNs === 0n) return report();
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, Number(sleepNs / 1_000_000n));
    return promise.then(report);
  };
}

export function createNapiWasmBinding(host: NapiWasmBindingHost): Record<string, unknown> {
  // Only a binding built with the event-loop runtime has a pump; only a pump
  // stack may suspend, so only such a binding takes the JSPI trampoline.
  const pumped = WebAssembly.Module.exports(host.binding).some((e) => e.name === 'nimbus_napi_pump');
  const jspi = pumped && typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
  const memory = host.memory ?? new WebAssembly.Memory({ initial: host.memoryPages, maximum: 65536 });
  const getMemory = () => memory;
  const fds = new Map<number, FilesystemFd>([
    [0, { kind: 'stdin' }],
    [1, { kind: 'stdout' }],
    [2, { kind: 'stderr' }],
    // Bindings hand WASI absolute paths; wasi-libc resolves them against `/`.
    [3, { kind: 'preopen', vfsPath: '/', wasiPath: '/' }],
  ]);
  let nextFd = 4;
  const allocateFd = () => {
    while (fds.has(nextFd)) nextFd++;
    return nextFd++;
  };
  const handles = new Map<number, BridgeHandle>();
  const nextHandle = { value: 1 };

  // One descriptor table, two codecs over it: the synchronous one every
  // stack may call, and the one the pump's stack calls through JSPI.
  const wasiImports = (suspend: boolean): Record<string, WasmFn> => {
    const imports: Partial<FilesystemImports> & Record<string, WasmFn> = baseWasiImports(host, getMemory, fds);
    const bridge = nodeFsBridge(host.fs, handles, nextHandle, suspend);
    installAuthorityFilesystem(imports, {
      fs: () => bridge,
      memory: getMemory,
      fds,
      allocateFd,
      synchronous: false,
      residentBytes: RESIDENT_OPEN_BYTES,
      retainResident: false,
    });
    imports.poll_oneoff = pollOneoff(getMemory, suspend);
    return imports;
  };
  const syncImports = wasiImports(false);

  let trampoline: WebAssembly.Instance | null = null;
  let wasi: Record<string, unknown> = syncImports;
  if (jspi) {
    const asyncImports = wasiImports(true);
    const sync: Record<string, WasmFn> = {};
    const suspending: Record<string, WebAssembly.Suspending> = {};
    for (const name of __NIMBUS_NAPI_WASM_DISPATCHED__) {
      sync[name] = syncImports[name];
      suspending[name] = new WebAssembly.Suspending(asyncImports[name]);
    }
    trampoline = new WebAssembly.Instance(host.trampoline, { sync, async: suspending });
    wasi = { ...syncImports, ...trampoline.exports };
  }

  // ── The pump ──────────────────────────────────────────────────────────
  // Set at the instance boundary, and only on a pumped binding.
  let pumpSync: ((budget: number) => number) | null = null;
  let aliveTasks: (() => number) | null = null;
  let pumpJspi: ((budget: number) => Promise<number>) | null = null;
  let pumping = false;
  let pumpScheduled = false;
  let pumpAgain = false;
  let depth = 0;
  let fatal: unknown = null;

  const die = (error: unknown) => {
    if (fatal !== null) return;
    fatal = error;
    while (waiting > 0) context.decreaseWaitingRequestCounter();
    // A trap or a stack overflow leaves the instance unusable: tell the host,
    // or surface it as an uncaught error.
    if (host.onFatal) {
      host.onFatal(error);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  };
  const finished = (status: number) => {
    pumping = false;
    if ((status & 1) === 0 && !pumpAgain) return;
    pumpAgain = false;
    // Budget spent, or a request arrived mid-pump: give I/O a turn first.
    if (!pumpScheduled) {
      pumpScheduled = true;
      setTimeout(runPump, 0);
    }
  };
  function runPump(): void {
    pumpScheduled = false;
    if (fatal !== null || pumpSync === null) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    if (pumpJspi) {
      pumpJspi(PUMP_BUDGET).then((status) => finished(status >>> 0), die);
      return;
    }
    let status: number;
    try {
      status = pumpSync(PUMP_BUDGET) >>> 0;
    } catch (error) {
      die(error);
      return;
    }
    finished(status);
  }
  const requestPump = () => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(runPump);
  };

  // Every napi callback enters the binding through the function table; once
  // the outermost one returns, a task it woke may be runnable.
  const wrapped = new WeakMap<WasmFn, WasmFn>();
  const tableGet = (table: WebAssembly.Table) => (index: number) => {
    const fn: unknown = table.get(index);
    if (typeof fn !== 'function') return fn;
    const target = fn as WasmFn;
    let w = wrapped.get(target);
    if (!w) {
      w = function (this: unknown, ...args: never[]) {
        depth++;
        try {
          return target.apply(this, args);
        } finally {
          depth--;
          if (depth === 0 && !pumping && fatal === null && aliveTasks !== null && aliveTasks() > 0) {
            requestPump();
          }
        }
      };
      wrapped.set(target, w);
    }
    return w;
  };

  const context = createContext();
  // What the binding holds open (threadsafe functions, async work) holds a
  // Node host's event loop open until released; a dead binding releases
  // nothing, so a fatal error lets go of it all.
  let waiting = 0;
  const increaseWaiting = context.increaseWaitingRequestCounter.bind(context);
  const decreaseWaiting = context.decreaseWaitingRequestCounter.bind(context);
  context.increaseWaitingRequestCounter = () => {
    waiting++;
    increaseWaiting();
  };
  context.decreaseWaitingRequestCounter = () => {
    if (waiting === 0) return;
    waiting--;
    decreaseWaiting();
  };
  const { napiModule } = instantiateNapiModuleSync(host.binding, {
    context,
    asyncWorkPoolSize: 0,
    plugins: [asyncWork, tsfn],
    wasi: {
      wasiImport: wasi,
      initialize(instance: WebAssembly.Instance) {
        const reactor: Pick<BindingExports, '_initialize'> = instance.exports as never;
        reactor._initialize();
      },
    },
    getTable: (raw: WebAssembly.Exports) => {
      const table = raw.__indirect_function_table as WebAssembly.Table;
      const get = tableGet(table);
      return new Proxy(table, {
        get(target, prop) {
          if (prop === 'get') return get;
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    overwriteImports(importObject: Record<string, Record<string, unknown>>) {
      importObject.env = { ...importObject.env, ...importObject.napi, ...importObject.emnapi, memory };
      importObject.wasi_snapshot_preview1 = wasi;
      importObject.nimbus_napi = { request_pump: requestPump };
      return importObject;
    },
    beforeInit({ instance }: { instance: WebAssembly.Instance }) {
      // The binding's own exports, typed once here at the instance boundary.
      const exports = instance.exports as unknown as BindingExports;
      if (pumped && exports.nimbus_napi_pump && exports.nimbus_napi_alive_tasks) {
        pumpSync = exports.nimbus_napi_pump;
        aliveTasks = exports.nimbus_napi_alive_tasks;
      }
      if (trampoline) {
        (trampoline.exports.table as WebAssembly.Table).set(0, instance.exports.nimbus_napi_pump);
        pumpJspi = WebAssembly.promising(trampoline.exports.pump as (budget: number) => number);
      }
      for (const name of Object.keys(instance.exports)) {
        if (name.startsWith('__napi_register__')) (instance.exports[name] as () => void)();
      }
    },
  });
  return napiModule.exports as Record<string, unknown>;
}
