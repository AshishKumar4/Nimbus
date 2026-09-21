// Binary gate: rebuilt Bash must unwind from filesystem imports; BusyBox must
// preserve its EH ABI while using real cwd, metadata and flush imports.
import assert from 'node:assert/strict';
import { WASI } from 'node:wasi';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, lstatSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.versions.bun) {
  const child = spawnSync('node', [fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const root = mkdtempSync(join(tmpdir(), 'nimbus-wasm-abi-'));
const wasmRoot = new URL('../../packages/worker/wasm/bash/', import.meta.url);
const bashBytes = readFileSync(process.env.NIMBUS_BASH_WASM || new URL('bash.async.wasm', wasmRoot));
const busyboxBytes = readFileSync(new URL('coreutils/busybox.wasm', wasmRoot));
const bash = new WebAssembly.Module(bashBytes);
const busybox = new WebAssembly.Module(busyboxBytes);
const imports = (mod) => WebAssembly.Module.imports(mod).map(({ module, name }) => `${module}.${name}`);
assert(imports(bash).includes('nimbus_proc.capture_cwd'));
assert(imports(busybox).includes('nimbus_proc.startup_cwd'));
assert(imports(busybox).includes('nimbus_proc.stat_metadata'));
assert(imports(busybox).includes('wasi_snapshot_preview1.fd_sync'));
assert(imports(busybox).includes('wasi_snapshot_preview1.fd_datasync'));

mkdirSync(join(root, 'work'));
writeFileSync(join(root, 'work/input'), 'printf "delayed\\n"\n');
writeFileSync(join(root, 'work/mode'), 'private', { mode: 0o600 });
const text = new TextDecoder();
const bytes = new TextEncoder();
const exit = Symbol('guest exit');
const errorCode = (error) => ({ ENOENT: 44, EACCES: 2, EPERM: 63, EBADF: 8 }[error.code] || 29);

function nativeImports(getInstance, cwd, observed) {
  return {
    startup_cwd(ptr, capacity) {
      const value = bytes.encode(cwd);
      if (capacity === 0) return value.length;
      if (capacity <= value.length) return -37;
      const memory = new Uint8Array(getInstance().exports.memory.buffer);
      memory.set(value, ptr); memory[ptr + value.length] = 0;
      observed.cwd++;
      return value.length;
    },
    identity: (field) => [123, 456, 17, 1][field] ?? 0o022,
    capture_cwd(ptr, length) {
      observed.captured.push(text.decode(new Uint8Array(getInstance().exports.memory.buffer, ptr, length)));
      return 0;
    },
    stat_metadata(fd, ptr, length, follow, out) {
      try {
        const guestPath = ptr ? text.decode(new Uint8Array(getInstance().exports.memory.buffer, ptr, length)) : null;
        const path = guestPath === null ? null : join(root, resolve(fd >= 3 ? '/' : cwd, guestPath));
        const stat = path === null ? fstatSync(fd) : (follow ? statSync(path) : lstatSync(path));
        const view = new DataView(getInstance().exports.memory.buffer);
        [stat.mode, 123, 456].forEach((value, i) => view.setUint32(out + i * 4, value, true));
        observed.metadata++;
        return 0;
      } catch (error) { return errorCode(error); }
    },
    chmod() { observed.denials++; return 2; },
    fchmod() { observed.denials++; return 2; },
    chown() { observed.denials++; return 63; },
  };
}

async function runBash() {
  const observed = { cwd: 0, captured: [], metadata: 0, denials: 0 };
  let instance;
  let reason = null, rewind = false, result = 0, code = null, nextSlot = 0;
  let pending, captureEnv, jumpEnv, jumpValue;
  const slots = new Map();
  const free = [];
  const mainSize = 8 << 20, slotSize = 256 << 10;
  let base, slot0;
  const view = () => new DataView(instance.exports.memory.buffer);
  const header = (ptr, size) => { view().setUint32(ptr, ptr + 8, true); view().setUint32(ptr + 4, ptr + size, true); };
  const nimbus = nativeImports(() => instance, '/work', observed);
  Object.assign(nimbus, {
    getppid: () => 1, getpgid: () => 17, setpgid: () => -52, tcgetpgrp: () => -59, tcsetpgrp: () => -59,
    setjmp(env) {
      if (rewind) { instance.exports.asyncify_stop_rewind(); rewind = false; return; }
      if (slots.has(env)) free.push(slots.get(env));
      const index = free.length > 1 ? free.shift() : nextSlot < 32 ? nextSlot++ : free.shift();
      assert.notEqual(index, undefined);
      slots.set(env, index); view().setInt32(env, index, true); view().setInt32(env + 4, 0, true);
      captureEnv = env; reason = 'capture'; header(slot0 + index * slotSize, slotSize);
      instance.exports.asyncify_start_unwind(slot0 + index * slotSize);
    },
    longjmp(env, value) {
      jumpEnv = env; jumpValue = value; reason = 'jump'; header(base, mainSize);
      instance.exports.asyncify_start_unwind(base);
    },
  });
  // These commands deliberately stay in Bash. Unexpected process operations
  // fail this binary proof instead of claiming success for an untested syscall.
  for (const { module, name } of WebAssembly.Module.imports(bash)) {
    if (module === 'nimbus_proc' && !(name in nimbus)) nimbus[name] = () => { throw new Error(`unexpected process import ${name}`); };
  }
  let output = '';
  const wasi = new WASI({ version: 'preview1', returnOnExit: true,
    args: ['bash', '--noprofile', '--norc', '-c', 'source input; printf "%s\\n" *'],
    env: { HOME: '/work', PWD: '/wrong', PATH: '/bin', TERM: 'dumb' }, preopens: { '/': root } });
  const table = { ...wasi.getImportObject().wasi_snapshot_preview1 };
  table.proc_exit = (status) => { code = status; throw exit; };
  const delayed = new Map();
  for (const name of ['path_open', 'path_filestat_get', 'fd_readdir']) {
    const original = table[name];
    table[name] = (...args) => {
      if (rewind) { instance.exports.asyncify_stop_rewind(); rewind = false; return result; }
      reason = 'io'; pending = () => original(...args); delayed.set(name, (delayed.get(name) || 0) + 1);
      header(base, mainSize); instance.exports.asyncify_start_unwind(base); return 0;
    };
  }
  const originalWrite = table.fd_write;
  table.fd_write = (fd, iovs, count, written) => {
    if (fd !== 1 && fd !== 2) return originalWrite(fd, iovs, count, written);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const ptr = view().getUint32(iovs + i * 8, true), len = view().getUint32(iovs + i * 8 + 4, true);
      output += text.decode(new Uint8Array(instance.exports.memory.buffer, ptr, len)); total += len;
    }
    view().setUint32(written, total, true); return 0;
  };
  const env = { getuid: () => 123, geteuid: () => 123, getgid: () => 456, getegid: () => 456,
    getpid: () => 17, setuid: () => -1, setgid: () => -1, umask: () => 0o022,
    gethostname: () => -1, dlopen: () => 0, dlsym: () => 0, dlclose: () => -1, dlerror: () => 0 };
  instance = new WebAssembly.Instance(bash, { wasi_snapshot_preview1: table, nimbus_proc: nimbus, env });
  base = instance.exports.memory.buffer.byteLength; slot0 = base + mainSize;
  instance.exports.memory.grow((mainSize + 32 * slotSize) / 65536);
  let initial = true;
  for (let steps = 0; code === null; steps++) {
    assert(steps < 5000, 'binary scheduler did not terminate');
    try { if (initial) { initial = false; wasi.start(instance); } else instance.exports._start(); }
    catch (error) { if (error === exit) break; throw error; }
    assert(reason, 'guest returned without exit or unwind');
    instance.exports.asyncify_stop_unwind();
    let rewindAt = base;
    if (reason === 'capture') {
      rewindAt = slot0 + view().getInt32(captureEnv, true) * slotSize;
      view().setUint32(captureEnv + 8, view().getUint32(rewindAt, true), true);
    } else if (reason === 'jump') {
      rewindAt = slot0 + view().getInt32(jumpEnv, true) * slotSize;
      view().setUint32(rewindAt, view().getUint32(jumpEnv + 8, true), true);
      view().setInt32(jumpEnv + 4, jumpValue, true);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1)); result = pending();
    }
    reason = null; rewind = true; instance.exports.asyncify_start_rewind(rewindAt);
  }
  assert.equal(code, 0, output);
  assert(output.startsWith('delayed\n'), output);
  assert(observed.captured.includes('/work'));
  for (const name of ['path_open', 'path_filestat_get', 'fd_readdir']) assert(delayed.get(name) > 0, name);
  console.log('PASS Bash filesystem Asyncify boundaries', Object.fromEntries(delayed));
}

async function runBusybox(argv, expectedCode) {
  const observed = { cwd: 0, captured: [], metadata: 0, denials: 0, sync: 0 };
  let instance, output = '', code;
  const wasi = new WASI({ version: 'preview1', returnOnExit: true, args: ['busybox', ...argv],
    env: { PWD: '/wrong', HOME: '/work' }, preopens: { '/': root } });
  const table = { ...wasi.getImportObject().wasi_snapshot_preview1 };
  const native = nativeImports(() => instance, '/work', observed);
  table.proc_exit = (status) => { code = status; throw exit; };
  const write = table.fd_write;
  table.fd_write = (fd, iovs, count, written) => {
    if (fd !== 1 && fd !== 2) return write(fd, iovs, count, written);
    const view = new DataView(instance.exports.memory.buffer); let total = 0;
    for (let i = 0; i < count; i++) { const p = view.getUint32(iovs + i * 8, true), n = view.getUint32(iovs + i * 8 + 4, true); output += text.decode(new Uint8Array(instance.exports.memory.buffer, p, n)); total += n; }
    view.setUint32(written, total, true); return 0;
  };
  for (const name of ['fd_sync', 'fd_datasync']) { const original = table[name]; table[name] = (...args) => { observed.sync++; return original(...args); }; }
  instance = new WebAssembly.Instance(busybox, { wasi_snapshot_preview1: table, nimbus_proc: native });
  try { code = wasi.start(instance); } catch (error) { if (error !== exit) throw error; }
  assert.equal(code, expectedCode, output);
  assert.equal(observed.cwd, 1);
  return { output, observed };
}

try {
  await runBash();
  assert.equal((await runBusybox(['realpath', '.'], 0)).output, '/work\n');
  const mode = await runBusybox(['stat', '-c', '%a:%u:%g', 'mode'], 0);
  assert.equal(mode.output.trim(), '600:123:456');
  assert.equal((await runBusybox(['chmod', '777', 'mode'], 1)).observed.denials, 1);
  assert((await runBusybox(['fsync', 'mode'], 0)).observed.sync > 0);
  // Node WASI rejects fd_datasync on its read-only handle; the guest must see it.
  assert((await runBusybox(['fsync', '-d', 'mode'], 1)).observed.sync > 0);
  assert.equal(statSync(join(root, 'work/mode')).mode & 0o777, 0o600);
  console.log('PASS BusyBox real cwd, credential metadata, permission denial and flush');
  for (const [name, data] of [['bash', bashBytes], ['busybox', busyboxBytes]]) console.log(name, createHash('sha256').update(data).digest('hex'));
} finally { rmSync(root, { recursive: true, force: true }); }
