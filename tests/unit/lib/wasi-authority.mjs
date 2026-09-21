/**
 * The real wasi-instance.ts preamble over a real session filesystem.
 *
 * Every file syscall a guest makes is answered by the authority codec through
 * the supervisor stub `__wasiAdoptSupervisor` installs, so the only honest way
 * to assert filesystem semantics — symlinks, permissions, inode identity,
 * directory types — is against a SqliteVFS with a credentialed process bound
 * to it. This builds that: a session with a kernel and a user, one process
 * spawned as the user, and the preamble adopted onto that process's bridge.
 *
 * `parking: 'none'` by default: the bridge is in this isolate, so the codec
 * answers from its synchronous view and every import returns a plain errno.
 * That is the local-facet-host contract, and it is what lets a test call the
 * import table from JS without a wasm stack to park. A guest asked for with
 * `parking: 'jspi'` gets the parkable table through the preamble's no-JSPI
 * branch (lib/wasi-imports.mjs), and its imports answer Promises to await;
 * with `suspending: true` as well it gets the real Suspending table, which
 * only a wasm export entered through WebAssembly.promising may call.
 *
 * Directory note: lives under tests/unit/lib/ because the suite runs
 * `tests/unit/*.mjs`, which would otherwise execute a helper as a test.
 */
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../../packages/core/src/runtime/wasi-instance.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../../packages/core/src/runtime/filesystem-authority.ts';
import { vfsSupervisor } from '../../../packages/core/src/runtime/vfs-supervisor.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSupervisorBridgeStore } from '../../../packages/core/src/workspace/supervisor-op.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { Kernel } from '../../../packages/core/src/substrate/lifo/kernel/index.ts';
import { createSqliteVfsTestHarness } from '../sqlite-vfs-test-harness.mjs';
import { makeImportsWithoutJSPI } from './wasi-imports.mjs';

export const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

let preamble = null;

/**
 * The preamble is module-shaped (top-level await for cloudflare:sockets), so
 * it is evaluated once as an ES module from a temp file. One module means one
 * descriptor table, exactly as one facet has; `__wasiInitFS` resets it.
 */
export async function loadWasiPreamble() {
  if (preamble) return preamble;
  const src = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiRunStartAsync, fdTable };`;
  const file = path.join(os.tmpdir(), `wasi-authority-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(file, src);
  try {
    preamble = await import(pathToFileURL(file).href);
  } finally {
    rmSync(file, { force: true });
  }
  return preamble;
}

/**
 * A session: `/home/user` owned by the user, `/tmp` shared, and a process
 * spawned as the user whose bridge the guest adopts.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.dirs]              directories created by the kernel, user-owned
 * @param {Record<string,string|Uint8Array>} [opts.files]  user-owned files
 * @param {Record<string,string>} [opts.symlinks]          path → target, user-owned
 * @param {Readonly<{uid:number,gid:number,groups:readonly number[],umask:number}>} [opts.cred]
 */
export function makeSession(opts = {}) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  // Mounted under a kernel as a session is: the namespace root is the
  // kernel's, with an identity of its own, and /dev and /proc are its mounts.
  const kernel = new Kernel();
  kernel.initFilesystem();
  const authority = new SqliteFilesystemAuthority(raw, kernel.vfs);
  const root = raw.as(CRED_KERNEL);
  const cred = opts.cred ?? USER;
  const user = raw.as(cred);
  for (const dir of ['home/user', 'tmp', ...(opts.dirs ?? [])]) {
    root.mkdir(dir, { recursive: true });
    root.chown(dir, cred.uid, cred.gid);
  }
  for (const [file, data] of Object.entries(opts.files ?? {})) {
    const parent = file.slice(0, file.lastIndexOf('/'));
    if (parent && !root.exists(parent)) { root.mkdir(parent, { recursive: true }); root.chown(parent, cred.uid, cred.gid); }
    root.writeFile(file, data);
    root.chown(file, cred.uid, cred.gid);
  }
  for (const [link, target] of Object.entries(opts.symlinks ?? {})) {
    root.symlink(target, link);
    root.chown(link, cred.uid, cred.gid, { followSymlinks: false });
  }
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('guest', ['guest'], '/home/user', { cred });
  const store = createSupervisorBridgeStore({ vfs: raw, processes, filesystem: authority });
  const supervisor = vfsSupervisor(store.bridge(pid));
  return {
    raw, root, user, cred, pid, authority, supervisor,
    async dispose() { await store.dispose(); await authority.releaseProcess(pid); harness.db.close(); },
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A guest over `session`: the preamble initialised with `init`, the session's
 * supervisor adopted, and an import table plus the memory helpers a JS-driven
 * test needs to call it.
 *
 * @param {Awaited<ReturnType<typeof loadWasiPreamble>>} P
 * @param {ReturnType<typeof makeSession> | null} session  null adopts nothing
 * @param {object} [init]      `__wasiInitFS` options; default root '/' preopen
 * @param {object} [imports]   extra `__wasiMakeImports` options (abi, parking, …)
 */
export function makeGuest(P, session, init = {}, imports = {}) {
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], ...init });
  if (session) P.__wasiAdoptSupervisor(session.supervisor);
  const memory = new WebAssembly.Memory({ initial: 8 });
  const stdout = [];
  const stderr = [];
  const { suspending = false, ...options } = {
    argv: ['prog'], env: {}, parking: 'none',
    getMemory: () => memory,
    stdoutWrite: (s) => { stdout.push(s); },
    stderrWrite: (s) => { stderr.push(s); },
    ...imports,
  };
  const { wasiImport } = options.parking === 'jspi' && !suspending ? makeImportsWithoutJSPI(P, options) : P.__wasiMakeImports(options);
  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  // Bump allocator over the raw linear memory (well past page 0).
  let bump = 4096;
  const alloc = (n) => { const p = bump; bump += (n + 7) & ~7; return p; };
  const putStr = (s) => { const b = enc.encode(s); const p = alloc(b.length); u8().set(b, p); return [p, b.length]; };
  const iovec = (len) => {
    const buf = alloc(len);
    const iov = alloc(8);
    dv().setUint32(iov, buf, true);
    dv().setUint32(iov + 4, len, true);
    return { iov, buf, len };
  };
  const ALL_RIGHTS = -1n;
  return {
    wasi: wasiImport, memory, u8, dv, alloc, putStr, iovec, stdout, stderr,
    /** path_open against preopen fd 3 (or `dirfd`); every right by default. */
    open(p, { dirfd = 3, lookup = 1, oflags = 0, rights = ALL_RIGHTS, inheriting = ALL_RIGHTS, fdflags = 0 } = {}) {
      const [pp, pl] = putStr(p);
      const out = alloc(4);
      const errno = wasiImport.path_open(dirfd, lookup, pp, pl, oflags, rights, inheriting, fdflags, out);
      return { errno, fd: dv().getUint32(out, true) };
    },
    read(fd, max = 65536) {
      const { iov, buf } = iovec(max);
      const nread = alloc(4);
      const errno = wasiImport.fd_read(fd, iov, 1, nread);
      const n = dv().getUint32(nread, true);
      return { errno, n, text: dec.decode(u8().subarray(buf, buf + n)), bytes: u8().slice(buf, buf + n) };
    },
    write(fd, text) {
      const bytes = typeof text === 'string' ? enc.encode(text) : text;
      const buf = alloc(bytes.length);
      u8().set(bytes, buf);
      const iov = alloc(8);
      dv().setUint32(iov, buf, true);
      dv().setUint32(iov + 4, bytes.length, true);
      const nw = alloc(4);
      const errno = wasiImport.fd_write(fd, iov, 1, nw);
      return { errno, n: dv().getUint32(nw, true) };
    },
    /** path_filestat_get; the raw stat buffer is returned for ABI-specific decoding. */
    stat(p, { dirfd = 3, lookup = 1 } = {}) {
      const [pp, pl] = putStr(p);
      const at = alloc(64);
      const errno = wasiImport.path_filestat_get(dirfd, lookup, pp, pl, at);
      return { errno, at, filetype: dv().getUint8(at + 16), size: Number(dv().getBigUint64(at + 32, true)), ino: dv().getBigUint64(at + 8, true), dev: dv().getBigUint64(at, true) };
    },
    fstat(fd) {
      const at = alloc(64);
      const errno = wasiImport.fd_filestat_get(fd, at);
      return { errno, at, filetype: dv().getUint8(at + 16), size: Number(dv().getBigUint64(at + 32, true)), ino: dv().getBigUint64(at + 8, true), dev: dv().getBigUint64(at, true) };
    },
    readdir(fd) {
      const buf = alloc(4096);
      const used = alloc(4);
      const errno = wasiImport.fd_readdir(fd, buf, 4096, 0n, used);
      const entries = [];
      let off = buf;
      const end = buf + dv().getUint32(used, true);
      while (off + 24 <= end) {
        const next = dv().getBigUint64(off, true);
        const ino = dv().getBigUint64(off + 8, true);
        const namelen = dv().getUint32(off + 16, true);
        const type = dv().getUint8(off + 20);
        if (off + 24 + namelen > end) break;
        entries.push({ name: dec.decode(u8().subarray(off + 24, off + 24 + namelen)), type, ino, next });
        off += 24 + namelen;
      }
      return { errno, entries };
    },
  };
}
