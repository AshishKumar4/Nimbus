/**
 * A WASI guest over the real WASI body (WASI_INSTANCE_PREAMBLE_SRC) with a
 * credential, so its filesystem is the resident one (core runtime/wasi/
 * resident-filesystem.ts) behind the real codec (wasi/filesystem.ts), over a
 * supervisor that dispatches each op as the session does. The guest's imports
 * are called from the test as a guest calls them, with its memory laid out by
 * hand. `refuse(path)` makes the session refuse every write to a file whose
 * path it matches with ENOSPC, as a full store does. `of` runs the guest as
 * another process of an earlier guest's session, in a WASI body of its own;
 * `after` runs it as the next process in an earlier guest's WASI body (a warm
 * facet, FacetSpec.warm), which that guest ended. `cred` is who it runs as.
 * `source` is more preamble text, after the WASI body, in the same module, as
 * a facet composes a runtime's tail with it (its entries are on globalThis).
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../../packages/core/src/runtime/wasi-instance.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { FILESYSTEM_RPC_METHODS } from '../../../packages/core/src/runtime/vfs-supervisor.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { subtreeListing } from '../../../packages/core/src/runtime/fs-list-tree.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSupervisorBridgeStore, createSupervisorOpHandler } from '../../../packages/core/src/workspace/supervisor-op.ts';
import { SupervisorDeliveries } from '../../../packages/core/src/workspace/supervisor-delivery.ts';
import { withRecall } from '../../../packages/core/src/vfs/recall.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { makeImportsWithoutJSPI } from './wasi-imports.mjs';
import { acrossRpc } from './rpc-error.mjs';

export const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const PREOPEN_FD = 3;
const enc = new TextEncoder();

/** Whether this engine can park a guest: without JSPI a guest answers from the session, and these tests have nothing to test. */
export const canPark = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';

/**
 * The module the guest runs: preamble.ts, with the two of its functions the
 * export line below adds to its exports.
 *
 * @typedef {typeof import('../../../packages/worker/src/runtime/wasi/preamble.ts') & {
 *   __wasiSettleFirst: (body: () => import('../../../packages/core/src/runtime/wasi/types.ts').SyscallResult) => import('../../../packages/core/src/runtime/wasi/types.ts').SyscallResult,
 *   __wasiInbound: <T>(result: T) => T }} Preamble
 */

/** A session for guests: its store, its supervisor and the op handler a process's binding calls. */
function residentSession() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', USER.uid, USER.gid);
  const processes = new SessionProcessSupervisor();
  const authority = new ProcessFiles(raw);
  const bridge = createSupervisorBridgeStore({ vfs: raw, processes, filesystem: authority });
  // Fenced waves, as a process's binding sends them: a refusal answers its own op.
  const deliveries = new SupervisorDeliveries();
  const dispatch = createSupervisorOpHandler({ vfs: raw, filesystem: authority, processes, bridge, host: {}, deliveries });
  return { harness, raw, kernel, processes, authority, bridge, deliveries, dispatch, retired: [] };
}

/**
 * @param {{ refuse?: (path: string) => boolean, of?: { session: ReturnType<typeof residentSession> },
 *   after?: { P: Preamble, session: ReturnType<typeof residentSession> }, cred?: typeof USER, source?: string }} [options]
 */
export async function residentGuest({ refuse = () => false, of, after, cred = USER, source = '' } = {}) {
  let P = after?.P;
  if (P === undefined) {
    const modulePath = path.join(os.tmpdir(), `wasi-resident-guest-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
    writeFileSync(modulePath, `${WASI_INSTANCE_PREAMBLE_SRC}\n${source}\nexport { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiFsStats, __wasiSettleWrites, __wasiRunStartAsync, __wasiPrepareFilesystem, __wasiInbound, __wasiSettleFirst };`);
    try { P = await import(pathToFileURL(modulePath).href); } finally { rmSync(modulePath, { force: true }); }
  }

  const session = (of ?? after)?.session ?? residentSession();
  const { harness, raw, kernel, processes, authority } = session;
  const boundIncarnation = session.deliveries.incarnation;
  const { pid } = processes.spawn('guest', ['guest'], '/home/user', { cred });

  const refusedHandles = new Set();
  const supervisor = { synchronous: () => { throw new Error('rpc stubs have no synchronous view'); } };
  for (const op of Object.values(FILESYSTEM_RPC_METHODS)) {
    supervisor[op] = async (...args) => {
      if (op === 'fsWrite' && refusedHandles.has(args[0])) {
        throw acrossRpc(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
      }
      try {
        if (globalThis.__guestTrace) globalThis.__guestTrace.push(op);
        const value = await session.dispatch({ op, args, pid });
        const opened = /** @type {{ path?: string, id?: number } | undefined} */ (op === 'fsOpen' ? value : undefined);
        if (opened && refuse(String(opened.path))) refusedHandles.add(opened.id);
        return value;
      } catch (error) {
        if (globalThis.__guestTrace) globalThis.__guestTrace.push(`${op}!${error?.code ?? error?.message}`);
        throw acrossRpc(error);
      }
    };
  }
  // What session/rpc.ts answers itself rather than through the op table.
  supervisor.fsAcquire = async (epoch, cursor, options) => session.bridge.bridge(pid).acquire(epoch, cursor, options);
  /** The directory batches the guest asked for (fsReadDirectories requests). */
  const batches = [];
  supervisor.fsReadDirectories = async (request) => { batches.push(request); return session.dispatch({ op: 'fsReadDirectories', args: [request], pid }); };
  // The process's waves (its filesystem client's), fenced as SupervisorRPC fences them.
  supervisor.openWaveWriter = async () => /** @type {{ writer: string | null }} */ (await session.dispatch({ op: 'openWaveWriter', args: [], pid })).writer;
  supervisor.retireWaveWriter = async (writer) => { await session.dispatch({ op: 'retireWaveWriter', args: [writer], pid }); };
  supervisor.writeBatchStream = async (stream, fence, owner) => {
    try {
      return await session.dispatch({
        op: 'writeBatchStream', args: [], pid, stream,
        ...(fence === undefined ? {} : { waveFence: { ...fence, hostIncarnation: boundIncarnation } }),
        ...(owner === undefined ? {} : { mutationOwner: owner }),
      });
    } catch (error) { throw acrossRpc(error); }
  };
  supervisor.fsList = async (...args) => session.bridge.bridge(pid).list(...args);
  supervisor.fsListTree = async (root, maxEntries) => subtreeListing(session.bridge.bridge(pid), root, maxEntries);
  supervisor.fsReadBatch = async (requests) => {
    const current = session.bridge.bridge(pid);
    const out = [];
    for (const request of requests) {
      try {
        if (!('length' in request)) out.push({ stat: (await current.stat(request.path, { followSymlinks: false })) ?? null });
        else out.push({ bytes: await current.readRange(request.path, request.offset, request.length, { expectedEpoch: request.expectedEpoch, expectedRevision: request.expectedRevision }) });
      } catch (error) { out.push({ error }); }
    }
    return out;
  };

  const memory = new WebAssembly.Memory({ initial: 16 });
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred });
  P.__wasiAdoptSupervisor(supervisor);
  const { wasiImport, fsImport } = makeImportsWithoutJSPI(P, {
    argv: ['guest'], env: {}, getMemory: () => memory, stdoutWrite: () => {}, stderrWrite: () => {},
  });
  const view = () => new DataView(memory.buffer);
  const bytesAt = () => new Uint8Array(memory.buffer);
  const PATH = 1024, PATH2 = 1536, OUT = 2048, IOV = 3072, DATA = 4096;
  const putPath = (name) => { const b = enc.encode(name); bytesAt().set(b, PATH); return b.length; };
  const RIGHTS_ALL = 0x1fffffffn;
  const times = (atime, mtime) => [
    typeof atime === 'number' ? BigInt(atime) * 1_000_000n : 0n,
    typeof mtime === 'number' ? BigInt(mtime) * 1_000_000n : 0n,
    (atime === 'now' ? 2 : atime === 'omit' ? 0 : 1) | (mtime === 'now' ? 8 : mtime === 'omit' ? 0 : 4),
  ];

  const guest = {
    P, kernel, raw, session, pid, supervisor, wasiImport, fsImport, memory, batches, stats: () => P.__wasiFsStats(),
    /**
     * The session's isolate is replaced under the running guest: its calls
     * reach a fresh process table, of the next generation, that never held it.
     */
    restartSession() {
      const next = new SessionProcessSupervisor();
      next.setPidBase(1_000_000);
      session.retired.push(session.bridge);
      session.processes = next;
      session.bridge = createSupervisorBridgeStore({ vfs: raw, processes: next, filesystem: authority });
      session.deliveries = new SupervisorDeliveries();
      session.dispatch = createSupervisorOpHandler({ vfs: raw, filesystem: authority, processes: next, bridge: session.bridge, host: {}, deliveries: session.deliveries });
    },
    /** path_open: the fd, or a thrown errno. `allocate` also asks for FD_ALLOCATE (a live description, not a read-only copy). */
    async open(name, { create = false, truncate = false, exclusive = false, directory = false, read = true, write = false, append = false, allocate = false } = {}) {
      const n = putPath(name);
      const oflags = (create ? 1 : 0) | (directory ? 2 : 0) | (exclusive ? 4 : 0) | (truncate ? 8 : 0);
      let rights = write ? RIGHTS_ALL : RIGHTS_ALL & ~(1n << 6n) & ~(1n << 22n) & ~(1n << 8n);
      if (!read) rights &= ~(1n << 1n);
      if (allocate) rights |= 1n << 8n;
      const errno = await wasiImport.path_open(PREOPEN_FD, 1, PATH, n, oflags, rights, rights, append ? 1 : 0, OUT);
      if (errno !== 0) throw Object.assign(new Error(`path_open ${name}: errno ${errno}`), { errno });
      return view().getUint32(OUT, true);
    },
    async write(fd, text) {
      const b = enc.encode(text);
      bytesAt().set(b, DATA);
      view().setUint32(IOV, DATA, true);
      view().setUint32(IOV + 4, b.length, true);
      return wasiImport.fd_write(fd, IOV, 1, OUT);
    },
    /** fd_write/fd_pwrite: the byte count, or a thrown errno. */
    async writeAt(fd, text, offset = null) {
      const b = enc.encode(text);
      bytesAt().set(b, DATA);
      view().setUint32(IOV, DATA, true);
      view().setUint32(IOV + 4, b.length, true);
      const errno = offset === null
        ? await wasiImport.fd_write(fd, IOV, 1, OUT)
        : await wasiImport.fd_pwrite(fd, IOV, 1, BigInt(offset), OUT);
      if (errno !== 0) throw Object.assign(new Error(`fd_write: errno ${errno}`), { errno });
      return view().getUint32(OUT, true);
    },
    close: (fd) => wasiImport.fd_close(fd),
    /** fd_read from the description's current offset, as text, or a thrown errno. */
    async read(fd, n) {
      view().setUint32(IOV, DATA, true);
      view().setUint32(IOV + 4, n, true);
      const errno = await wasiImport.fd_read(fd, IOV, 1, OUT);
      if (errno !== 0) throw Object.assign(new Error(`fd_read: errno ${errno}`), { errno });
      return new TextDecoder().decode(bytesAt().slice(DATA, DATA + view().getUint32(OUT, true)));
    },
    /** fd_pread of up to `n` bytes at `offset`, as text, or a thrown errno. */
    async pread(fd, n, offset = 0) {
      view().setUint32(IOV, DATA, true);
      view().setUint32(IOV + 4, n, true);
      const errno = await wasiImport.fd_pread(fd, IOV, 1, BigInt(offset), OUT);
      if (errno !== 0) throw Object.assign(new Error(`fd_pread: errno ${errno}`), { errno });
      return new TextDecoder().decode(bytesAt().slice(DATA, DATA + view().getUint32(OUT, true)));
    },
    /** fd_write of `bytes` (a Uint8Array) in one call. */
    async writeBytes(fd, bytes) {
      const at = 1 << 20;
      while (memory.buffer.byteLength < at + bytes.byteLength) memory.grow(Math.ceil((at + bytes.byteLength - memory.buffer.byteLength) / 65536));
      bytesAt().set(bytes, at);
      view().setUint32(IOV, at, true);
      view().setUint32(IOV + 4, bytes.byteLength, true);
      return wasiImport.fd_write(fd, IOV, 1, OUT);
    },
    /** path_filestat_get: the size the guest sees, or a thrown errno. */
    async statSize(name) {
      const n = putPath(name);
      const errno = await wasiImport.path_filestat_get(PREOPEN_FD, 1, PATH, n, OUT);
      if (errno !== 0) throw Object.assign(new Error(`stat ${name}: errno ${errno}`), { errno });
      return Number(view().getBigUint64(OUT + 32, true));
    },
    /** Preview1's path stat, with the mode from the guest's nimbus_fs extension. */
    async stat(name) {
      const n = putPath(name);
      const errno = await wasiImport.path_filestat_get(PREOPEN_FD, 1, PATH, n, OUT);
      if (errno !== 0) throw Object.assign(new Error(`path_filestat_get ${name}: errno ${errno}`), { errno });
      const stat = { size: Number(view().getBigUint64(OUT + 32, true)), nlink: Number(view().getBigUint64(OUT + 24, true)) };
      const modeErrno = await fsImport.path_stat(PREOPEN_FD, 1, PATH, n, OUT);
      if (modeErrno !== 0) throw Object.assign(new Error(`path_stat ${name}: errno ${modeErrno}`), { errno: modeErrno });
      return { ...stat, mode: view().getUint32(OUT + 64, true) & 0o7777 };
    },
    async rename(from, to) {
      const n = putPath(from), b = enc.encode(to);
      bytesAt().set(b, PATH2);
      return wasiImport.path_rename(PREOPEN_FD, PATH, n, PREOPEN_FD, PATH2, b.length);
    },
    async unlink(name) { const n = putPath(name); return wasiImport.path_unlink_file(PREOPEN_FD, PATH, n); },
    ftruncate: (fd, size) => wasiImport.fd_filestat_set_size(fd, BigInt(size)),
    async chmod(name, mode) { const n = putPath(name); return fsImport.path_chmod(PREOPEN_FD, 1, PATH, n, mode); },
    fchmod: (fd, mode) => fsImport.fd_chmod(fd, mode),
    async utimes(name, atime, mtime) { const n = putPath(name); return wasiImport.path_filestat_set_times(PREOPEN_FD, 1, PATH, n, ...times(atime, mtime)); },
    futimes: (fd, atime, mtime) => wasiImport.fd_filestat_set_times(fd, ...times(atime, mtime)),
    /** Delivery without ending the process or giving its grants back. */
    flush: () => P.__wasiSettleFirst(() => 0),
    settle: () => P.__wasiSettleWrites(),
    inbound: () => P.__wasiInbound(0),
    /** A peer on the same session, waiting for any grant its access recalls. */
    peer: (work) => withRecall(() => work(kernel)),
    /** poll_oneoff with one relative clock subscription of `ms`: the errno the guest is handed. */
    sleep(ms) {
      const SUB = 8192, EVENT = 8192 + 48, NEVENTS = 8192 + 48 + 32;
      const v = view();
      v.setBigUint64(SUB, 1n, true);                          // userdata
      v.setUint8(SUB + 8, 0);                                  // tag: clock
      v.setUint32(SUB + 16, 1, true);                          // clock id: monotonic
      v.setBigUint64(SUB + 24, BigInt(ms) * 1_000_000n, true); // timeout (ns)
      v.setBigUint64(SUB + 32, 0n, true);                      // precision
      v.setUint16(SUB + 40, 0, true);                          // flags: relative
      return wasiImport.poll_oneoff(SUB, EVENT, 1, NEVENTS);
    },
    sync: (fd) => wasiImport.fd_sync(fd),
    /** os.listdir: path_open of the directory, then fd_readdir until it is read through; the names, or a thrown errno. */
    async listdir(name) {
      const fd = await guest.open(name, { directory: true });
      const BUF = 16384, LEN = 8192;
      const names = [];
      let cookie = 0n;
      try {
        for (;;) {
          const errno = await wasiImport.fd_readdir(fd, BUF, LEN, cookie, OUT);
          if (errno !== 0) throw Object.assign(new Error(`fd_readdir ${name}: errno ${errno}`), { errno });
          const used = view().getUint32(OUT, true);
          let at = 0;
          let whole = 0;
          while (at + 24 <= used) {
            const next = view().getBigUint64(BUF + at, true);
            const length = view().getUint32(BUF + at + 16, true);
            if (at + 24 + length > used) break;
            const entry = new TextDecoder().decode(bytesAt().slice(BUF + at + 24, BUF + at + 24 + length));
            if (entry !== '.' && entry !== '..') names.push(entry);
            cookie = next;
            at += 24 + length;
            whole++;
          }
          if (used < LEN || whole === 0) break;
        }
      } finally {
        await guest.close(fd);
      }
      return names;
    },
    async mkdir(name) { const n = putPath(name); return wasiImport.path_create_directory(PREOPEN_FD, PATH, n); },
    /** fd_filestat_get: { nlink, size }, or a thrown errno. */
    async fstat(fd) {
      const errno = await wasiImport.fd_filestat_get(fd, OUT);
      if (errno !== 0) throw Object.assign(new Error(`fd_filestat_get: errno ${errno}`), { errno });
      return { nlink: Number(view().getBigUint64(OUT + 24, true)), size: Number(view().getBigUint64(OUT + 32, true)) };
    },
    async dispose() { for (const b of [...session.retired, session.bridge]) await b.dispose(); await authority.releaseProcess(pid); harness.db.close(); },
    /** This process ends (its writes settled, its grants given back); the session goes on for another. */
    /** What the run's settle reported (null: everything it wrote was answered). */
    async end() { const failed = await P.__wasiSettleWrites(); await authority.releaseProcess(pid); return failed; },
  };
  // The store boots on the first call; wait until it answers.
  await guest.open('home/user', { directory: true }).then((fd) => guest.close(fd));
  for (let i = 0; i < 50 && !(P.__wasiFsStats()?.local > 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const n = putPath('home/user');
    await wasiImport.path_filestat_get(PREOPEN_FD, 1, PATH, n, OUT);
  }
  return guest;
}
