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
import { ARENA_SIZE, CaptureStore } from '../../packages/core/src/runtime/bash/capture-store.ts';

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
// bash-runner@5: every jmp_buf copy and saved-copy end is recorded in the module's log, which it exports with the stack's bounds and pointer.
assert(imports(bash).includes('nimbus_procenv.full') && !imports(bash).includes('nimbus_procenv.copy'));
const exported = Object.fromEntries(WebAssembly.Module.exports(bash).map(({ name, kind }) => [name, kind]));
for (const name of ['__stack_pointer', '__data_end', '__heap_base']) assert.equal(exported[name], 'global', name);
assert.equal(exported.nimbus_procenv_log, 'function');
// bash-runner@6: bash asks the runner for a stat preview1 left untyped (a pipe, a stdin that is not a terminal),
// and bash and BusyBox ask it for the session's accounts.
assert(imports(bash).includes('nimbus_proc.stat_metadata'));
assert(imports(bash).includes('nimbus_proc.account') && imports(busybox).includes('nimbus_proc.account'));
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
    // These runs name no account: none is found.
    account() { return 44; },
  };
}

async function runBash() {
  const observed = { cwd: 0, captured: [], metadata: 0, denials: 0 };
  let instance;
  let reason = null, rewind = false, result = 0, code = null;
  let pending, captureEnv, captureSp, jumpEnv, jumpValue;
  // The runner's own capture store, driven as the runner drives it (bash/preamble.ts).
  let store;
  const stats = { mainHi: 0, captureBytesHi: 0, captureCompactions: 0, captureLiveHi: 0 };
  const memory = () => instance.exports.memory;
  const view = () => new DataView(memory().buffer);
  const sp = () => instance.exports.__stack_pointer.value;
  const unwind = () => instance.exports.asyncify_start_unwind(store.unwindAt(memory(), sp(), stats, 1));
  const nimbus = nativeImports(() => instance, '/work', observed);
  Object.assign(nimbus, {
    getppid: () => 1, getpgid: () => 17, setpgid: () => -52, tcgetpgrp: () => -59, tcsetpgrp: () => -59,
    setjmp(env) {
      if (rewind) { instance.exports.asyncify_stop_rewind(); rewind = false; return; }
      store.setting(memory(), env);
      captureEnv = env; captureSp = sp(); reason = 'capture'; unwind();
    },
    longjmp(env, value) {
      jumpEnv = env; jumpValue = value; reason = 'jump'; unwind();
    },
  });
  const procenv = {
    full() { store.applyLog(memory()); },
  };
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
      unwind(); return 0;
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
  instance = new WebAssembly.Instance(bash, { wasi_snapshot_preview1: table, nimbus_proc: nimbus, nimbus_procenv: procenv, env });
  const base = memory().buffer.byteLength;
  memory().grow(ARENA_SIZE / 65536);
  store = new CaptureStore({ low: instance.exports.__data_end.value, high: instance.exports.__heap_base.value, log: instance.exports.nimbus_procenv_log() }, base, ARENA_SIZE);
  let initial = true;
  for (let steps = 0; code === null; steps++) {
    assert(steps < 5000, 'binary scheduler did not terminate');
    try { if (initial) { initial = false; wasi.start(instance); } else instance.exports._start(); }
    catch (error) { if (error === exit) break; throw error; }
    assert(reason, 'guest returned without exit or unwind');
    instance.exports.asyncify_stop_unwind();
    let rewindAt = store.top;
    if (reason === 'capture') {
      rewindAt = store.take(memory(), captureEnv, captureSp, stats, 1);
    } else if (reason === 'jump') {
      const target = store.jump(memory(), jumpEnv, jumpValue, 1);
      instance.exports.__stack_pointer.value = target.sp;
      rewindAt = target.at;
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
