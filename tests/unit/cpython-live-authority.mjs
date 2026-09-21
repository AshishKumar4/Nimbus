#!/usr/bin/env bun
// CPython booting the way a live session boots it: the stdlib is a file in
// the session, served through the filesystem authority on every read.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { FILESYSTEM_RPC_METHODS, vfsSupervisor } from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSupervisorBridgeStore, createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const RUNTIME_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '../../packages/worker/wasm/python');
const WASM = path.join(RUNTIME_DIR, 'python.wasm');
const STDLIB = path.join(RUNTIME_DIR, 'python313.zip');
if (!existsSync(WASM) || !existsSync(STDLIB)) {
  console.log('cpython-live-authority: SKIPPED (python.wasm not built)');
  process.exit(0);
}

const preamblePath = path.join(os.tmpdir(), `cpython-live-${process.pid}.mjs`);
writeFileSync(preamblePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor };`);
let P;
try { P = await import(pathToFileURL(preamblePath).href); } finally { rmSync(preamblePath, { force: true }); }

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const home = 'home/user/.nimbus/runtimes/cpython/3.13.14';

function seed(root) {
  for (const dir of ['home/user', 'tmp', `${home}/lib/python3.13/lib-dynload`]) root.mkdir(dir, { recursive: true, mode: 0o755 });
  root.chown('home/user', user.uid, user.gid);
  root.chown('tmp', user.uid, user.gid);
  root.writeFile(`${home}/lib/python313.zip`, readFileSync(STDLIB), { mode: 0o644 });
  root.writeFile(`${home}/lib/python3.13/os.py`, '# stdlib marker; the real os is in the zip\n', { mode: 0o644 });
}

async function boot({ label, supervisor, parking, enter, makeImports }) {
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }] });
  P.__wasiAdoptSupervisor(supervisor);
  const stderr = [];
  const { wasiImport } = makeImports({
    argv: ['python'],
    env: { HOME: '/home/user', TMPDIR: '/tmp', PYTHONUNBUFFERED: '1' },
    parking,
    getMemory: () => instance.exports.memory,
    stdoutWrite: () => {},
    stderrWrite: (s) => { stderr.push(s); },
  });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), { wasi_snapshot_preview1: wasiImport });
  const { memory, malloc, free, nimbus_py_init, nimbus_py_run } = instance.exports;
  const encoder = new TextEncoder();
  async function withCString(text, fn) {
    const bytes = encoder.encode(text);
    const ptr = malloc(bytes.length + 1);
    new Uint8Array(memory.buffer, ptr, bytes.length + 1).set([...bytes, 0]);
    try { return await fn(ptr); } finally { free(ptr); }
  }
  await enter(instance.exports._initialize)();
  assert.equal(await withCString(`/${home}`, (ptr) => enter(nimbus_py_init)(ptr)), 0, `${label}: nimbus_py_init failed: ${stderr.join('')}`);
  const program = `import json, pathlib; pathlib.Path("/home/user/${label}.txt").write_text(json.dumps({"n": 6 * 7}))`;
  assert.equal(await withCString(program, (ptr) => enter(nimbus_py_run)(ptr)), 0, `${label}: ${stderr.join('')}`);
}

// Same isolate: the authority's synchronous view answers on the guest's own stack.
{
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  seed(raw.as(CRED_KERNEL));
  const authority = new SqliteFilesystemAuthority(raw);
  const bridge = authority.bind({ pid: 11, cred: user });
  try {
    await boot({ label: 'local', supervisor: vfsSupervisor(bridge), parking: 'none', enter: (fn) => fn, makeImports: (options) => makeImportsWithoutJSPI(P, options) });
    assert.equal(raw.as(CRED_KERNEL).readFileString('home/user/local.txt'), '{"n": 42}');
  } finally {
    await authority.releaseProcess(11);
    harness.db.close();
  }
}

// Across an RPC hop: every syscall is a supervisor op envelope answered by the
// host's dispatch handler, parked on JSPI, exactly as a resident facet runs.
if (typeof WebAssembly.promising === 'function') {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  seed(raw.as(CRED_KERNEL));
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('python', ['python'], '/home/user', { cred: user });
  const authority = new SqliteFilesystemAuthority(raw);
  const store = createSupervisorBridgeStore({ vfs: raw, processes, filesystem: authority });
  const dispatch = createSupervisorOpHandler({ vfs: raw, filesystem: authority, processes, bridge: store, host: {} });
  // Structured clone across the hop hands bytes back as ArrayBuffer, not
  // Uint8Array, and a thrown error keeps only its message.
  const cloned = (value) => value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
  // workerd's RpcPromise is a callable proxy: typeof 'function', with `then`, not a Promise.
  const rpcThenable = (promise) => Object.assign(() => { throw new Error('pipelined call'); }, { then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected) });
  // A WorkerEntrypoint stub answers every property with a callable, the
  // synchronous capability included; the adapter must not believe it.
  const supervisor = { synchronous: () => { throw new Error('rpc stubs have no synchronous view'); } };
  for (const op of Object.values(FILESYSTEM_RPC_METHODS)) {
    // A stub call answers with workerd's own thenable class, never a Promise.
    supervisor[op] = (...args) => rpcThenable((async () => {
      try { return cloned(await dispatch({ op, args, pid })); }
      catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
    })());
  }
  try {
    await boot({ label: 'rpc', supervisor, parking: 'jspi', enter: (fn) => WebAssembly.promising(fn), makeImports: (options) => P.__wasiMakeImports(options) });
    assert.equal(raw.as(CRED_KERNEL).readFileString('home/user/rpc.txt'), '{"n": 42}');
  } finally {
    await store.dispose();
    await authority.releaseProcess(pid);
    harness.db.close();
  }
}
console.log('cpython-live-authority: the interpreter boots from and reads and writes through the authority, locally and over supervisor RPC');
