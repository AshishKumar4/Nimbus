/**
 * A WASI guest over the real WASI body (WASI_INSTANCE_PREAMBLE_SRC) with a
 * credential, so its filesystem is the resident one (core runtime/wasi/
 * resident-filesystem.ts) behind the real codec (wasi/filesystem.ts), over a
 * supervisor that dispatches each op as the session does. The guest's imports
 * are called from the test as a guest calls them, with its memory laid out by
 * hand. `refuse(path)` makes the session refuse every write to a file whose
 * path it matches with ENOSPC, as a full store does.
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
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSupervisorBridgeStore, createSupervisorOpHandler } from '../../../packages/core/src/workspace/supervisor-op.ts';
import { SupervisorDeliveries } from '../../../packages/core/src/workspace/supervisor-delivery.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { makeImportsWithoutJSPI } from './wasi-imports.mjs';
import { acrossRpc } from './rpc-error.mjs';

export const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const PREOPEN_FD = 3;
const enc = new TextEncoder();

/** Whether this engine can park a guest: without JSPI a guest answers from the session, and these tests have nothing to test. */
export const canPark = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';

/** @param {{ refuse?: (path: string) => boolean }} [options] */
export async function residentGuest({ refuse = () => false } = {}) {
  const modulePath = path.join(os.tmpdir(), `wasi-resident-guest-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(modulePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiFsStats, __wasiSettleWrites };`);
  let P;
  try { P = await import(pathToFileURL(modulePath).href); } finally { rmSync(modulePath, { force: true }); }

  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', USER.uid, USER.gid);
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('guest', ['guest'], '/home/user', { cred: USER });
  const authority = new ProcessFiles(raw);
  const bridge = createSupervisorBridgeStore({ vfs: raw, processes, filesystem: authority });
  // Fenced waves, as a process's binding sends them: a refusal answers its own op.
  const deliveries = new SupervisorDeliveries();
  const dispatch = createSupervisorOpHandler({ vfs: raw, filesystem: authority, processes, bridge, host: {}, deliveries });
  const own = authority.bind({ pid, cred: USER });
  const refusedHandles = new Set();
  const supervisor = { synchronous: () => { throw new Error('rpc stubs have no synchronous view'); } };
  for (const op of Object.values(FILESYSTEM_RPC_METHODS)) {
    supervisor[op] = async (...args) => {
      if (op === 'fsWrite' && refusedHandles.has(args[0])) {
        throw acrossRpc(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
      }
      try {
        const value = await dispatch({ op, args, pid });
        const opened = /** @type {{ path?: string, id?: number } | undefined} */ (op === 'fsOpen' ? value : undefined);
        if (opened && refuse(String(opened.path))) refusedHandles.add(opened.id);
        return value;
      } catch (error) { throw acrossRpc(error); }
    };
  }
  // What session/rpc.ts answers itself rather than through the op table.
  supervisor.fsAcquire = async (epoch, cursor, options) => own.acquire(epoch, cursor, options);
  // The process's waves (its filesystem client's), fenced as SupervisorRPC fences them.
  supervisor.openWaveWriter = async () => (await dispatch({ op: 'openWaveWriter', args: [], pid })).writer;
  supervisor.retireWaveWriter = async (writer) => { await dispatch({ op: 'retireWaveWriter', args: [writer], pid }); };
  supervisor.writeBatchStream = async (stream, fence, owner) => {
    try {
      return await dispatch({
        op: 'writeBatchStream', args: [], pid, stream,
        ...(fence === undefined ? {} : { waveFence: { ...fence, hostIncarnation: deliveries.incarnation } }),
        ...(owner === undefined ? {} : { mutationOwner: owner }),
      });
    } catch (error) { throw acrossRpc(error); }
  };
  supervisor.fsList = async (...args) => own.list(...args);
  supervisor.fsReadBatch = async (requests) => {
    const out = [];
    for (const request of requests) {
      try {
        if (!('length' in request)) out.push({ stat: (await own.stat(request.path, { followSymlinks: false })) ?? null });
        else out.push({ bytes: await own.readRange(request.path, request.offset, request.length) });
      } catch (error) { out.push({ error }); }
    }
    return out;
  };

  const memory = new WebAssembly.Memory({ initial: 16 });
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred: USER });
  P.__wasiAdoptSupervisor(supervisor);
  const { wasiImport } = makeImportsWithoutJSPI(P, {
    argv: ['guest'], env: {}, getMemory: () => memory, stdoutWrite: () => {}, stderrWrite: () => {},
  });
  const view = () => new DataView(memory.buffer);
  const bytesAt = () => new Uint8Array(memory.buffer);
  const PATH = 1024, OUT = 2048, IOV = 3072, DATA = 4096;
  const putPath = (name) => { const b = enc.encode(name); bytesAt().set(b, PATH); return b.length; };
  const RIGHTS_ALL = 0x1fffffffn;

  const guest = {
    P, kernel, raw, stats: () => P.__wasiFsStats(),
    /** path_open: the fd, or a thrown errno. `flags`: { create, truncate, exclusive, directory, write }. */
    async open(name, { create = false, truncate = false, exclusive = false, directory = false, write = false } = {}) {
      const n = putPath(name);
      const oflags = (create ? 1 : 0) | (directory ? 2 : 0) | (exclusive ? 4 : 0) | (truncate ? 8 : 0);
      const rights = write ? RIGHTS_ALL : RIGHTS_ALL & ~(1n << 6n) & ~(1n << 22n) & ~(1n << 8n);
      const errno = await wasiImport.path_open(PREOPEN_FD, 1, PATH, n, oflags, rights, rights, 0, OUT);
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
    close: (fd) => wasiImport.fd_close(fd),
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
    async mkdir(name) { const n = putPath(name); return wasiImport.path_create_directory(PREOPEN_FD, PATH, n); },
    /** fd_filestat_get: { nlink, size }, or a thrown errno. */
    async fstat(fd) {
      const errno = await wasiImport.fd_filestat_get(fd, OUT);
      if (errno !== 0) throw Object.assign(new Error(`fd_filestat_get: errno ${errno}`), { errno });
      return { nlink: Number(view().getBigUint64(OUT + 24, true)), size: Number(view().getBigUint64(OUT + 32, true)) };
    },
    async dispose() { await bridge.dispose(); await authority.releaseProcess(pid); harness.db.close(); },
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
