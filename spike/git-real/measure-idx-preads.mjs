// What git.wasm reads of a deep history's pack files, as a Nimbus WASI
// process would read them: under node:wasi (V8), every read of a .idx, .rev
// or .pack counted by file, with how much it moved, and how many of those
// reads a Nimbus guest sends to the session (a file over the resident cap,
// WASI_RESIDENT_FILE_CAP_BYTES, 8 MiB, is the session's descriptor: one
// call per read). Usage:
//   node measure-idx-preads.mjs <git.wasm> <repo-dir> <git args...>
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';

const RESIDENT_CAP = 8 * 1024 * 1024;
const [wasmPath, repo, ...args] = process.argv.slice(2);
const module = new WebAssembly.Module(readFileSync(wasmPath));
const stdout = openSync('/dev/null', 'w');
const wasi = new WASI({
  version: 'preview1',
  args: ['git', '-C', '/repo', ...args],
  env: {
    HOME: '/repo', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/repo/.git/measure-gitconfig', TMPDIR: '/tmp',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.packedGitWindowSize', GIT_CONFIG_VALUE_0: '1m',
    GIT_CONFIG_KEY_1: 'core.packedGitLimit', GIT_CONFIG_VALUE_1: '16m',
    GIT_CONFIG_KEY_2: 'core.deltaBaseCacheLimit', GIT_CONFIG_VALUE_2: '8m',
  },
  preopens: { '/repo': repo, '/dev': '/dev', '/tmp': '/tmp' },
  stdout,
  returnOnExit: true,
});
const base = wasi.getImportObject().wasi_snapshot_preview1;
let memory = null;
const view = () => new DataView(memory.buffer);
const pathOf = new Map();
const byFile = new Map();
const fileStat = (p) => { try { return statSync(path.join(repo, p.replace(/^\/repo\/?/, ''))).size; } catch { return 0; } };
const note = (fd, bytes, offset = null) => {
  const p = pathOf.get(fd);
  if (!p || !/\.(idx|rev|pack)$/.test(p)) return;
  let f = byFile.get(p);
  if (!f) { f = { size: fileStat(p), reads: 0, bytes: 0, pages: new Set() }; byFile.set(p, f); }
  f.reads++;
  f.bytes += bytes;
  if (offset !== null) for (let at = Math.floor(offset / 65536); at * 65536 < offset + bytes; at++) f.pages.add(at);
};
const iovTotal = (iovs, n) => { let t = 0; for (let i = 0; i < n; i++) t += view().getUint32(iovs + i * 8 + 4, true); return t; };
const imports = { ...base };
imports.path_open = (dirfd, dirflags, p, len, oflags, rb, ri, fdflags, fdPtr) => {
  const r = base.path_open(dirfd, dirflags, p, len, oflags, rb, ri, fdflags, fdPtr);
  if (r === 0) pathOf.set(view().getUint32(fdPtr, true), new TextDecoder().decode(new Uint8Array(memory.buffer, p, len)));
  return r;
};
imports.fd_pread = (fd, iovs, n, off, nreadPtr) => {
  const r = base.fd_pread(fd, iovs, n, off, nreadPtr);
  if (r === 0) note(fd, view().getUint32(nreadPtr, true), Number(off));
  return r;
};
imports.fd_read = (fd, iovs, n, nreadPtr) => {
  const r = base.fd_read(fd, iovs, n, nreadPtr);
  if (r === 0) note(fd, view().getUint32(nreadPtr, true));
  return r;
};
void iovTotal;
const enosys = () => 52;
const proc = Object.fromEntries(['pipe', 'dup', 'dup2', 'spawn', 'start', 'wait', 'kill'].map((n) => [n, enosys]));
proc.ids = (out) => { view().setUint32(out, process.getuid(), true); view().setUint32(out + 4, process.getgid(), true); return 0; };
// The Nimbus filesystem extension over the host's files: preview1's filestat, then mode, uid, gid.
const preopenDirs = { 3: repo, 4: '/dev', 5: '/tmp' };
const { lstatSync, statSync: hostStat, chmodSync } = await import('node:fs');
const writeStat = (out, st) => {
  const v = view();
  const type = st.isDirectory() ? 3 : st.isSymbolicLink() ? 7 : st.isCharacterDevice() ? 2 : st.isFile() ? 4 : 0;
  v.setBigUint64(out, BigInt(st.dev), true); v.setBigUint64(out + 8, BigInt(st.ino), true); v.setUint8(out + 16, type);
  v.setBigUint64(out + 24, BigInt(st.nlink), true); v.setBigUint64(out + 32, BigInt(st.size), true);
  v.setBigUint64(out + 40, BigInt(Math.trunc(st.atimeMs * 1e6)), true); v.setBigUint64(out + 48, BigInt(Math.trunc(st.mtimeMs * 1e6)), true);
  v.setBigUint64(out + 56, BigInt(Math.trunc(st.ctimeMs * 1e6)), true);
  v.setUint32(out + 64, st.mode, true); v.setUint32(out + 68, st.uid, true); v.setUint32(out + 72, st.gid, true);
};
const hostPath = (fd, p, len) => `${preopenDirs[fd]}/${new TextDecoder().decode(new Uint8Array(memory.buffer, p, len))}`;
const errnoOf = (e) => ({ ENOENT: 44, ENOTDIR: 54, EACCES: 2, ELOOP: 32 })[e.code] ?? 29;
const fsExt = {
  path_stat(fd, flags, p, len, out) {
    if (!(fd in preopenDirs)) return 8;
    try { writeStat(out, (flags & 1 ? hostStat : lstatSync)(hostPath(fd, p, len))); return 0; } catch (e) { return errnoOf(e); }
  },
  fd_stat(fd, out) {
    const r = base.fd_filestat_get(fd, out);
    if (r !== 0) return r;
    const type = view().getUint8(out + 16);
    view().setUint32(out + 64, (type === 3 ? 0o040755 : type === 2 ? 0o020620 : 0o100644), true);
    view().setUint32(out + 68, process.getuid(), true); view().setUint32(out + 72, process.getgid(), true);
    return 0;
  },
  path_chmod(fd, flags, p, len, mode) {
    if (!(fd in preopenDirs)) return 8;
    try { chmodSync(hostPath(fd, p, len), mode & 0o7777); return 0; } catch (e) { return errnoOf(e); }
  },
  fd_chmod() { return 0; },
};
const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: imports, nimbus_proc: proc, nimbus_fs: fsExt });
memory = instance.exports.memory;
const t = performance.now();
const cpu0 = process.cpuUsage();
const code = wasi.start(instance);
const cpu = process.cpuUsage(cpu0);
const runMs = performance.now() - t;
try { closeSync(stdout); } catch { /* the guest closed it */ }
const files = [...byFile].map(([p, f]) => ({ file: path.basename(p), sizeMiB: +(f.size / 1048576).toFixed(1), reads: f.reads, readMiB: +(f.bytes / 1048576).toFixed(1), distinctPages64k: f.pages.size, sessionCalls: f.size > RESIDENT_CAP ? f.reads : 0 }));
console.log(JSON.stringify({
  args: args.join(' '), exit: code, runMs: Math.round(runMs), cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  jsHeapMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
  linearMemoryMiB: +(memory.buffer.byteLength / 1048576).toFixed(1),
  sessionCalls: files.reduce((s, f) => s + f.sessionCalls, 0), files,
}));
