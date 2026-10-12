#!/usr/bin/env bun

// The WASI process ABI reaches the workspace's broker through a real local
// supervisor. A runtime child has its own realm and the broker's one stdin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import wabtFactory from 'wabt';
import { hostSqlite } from './lib/host-sqlite.mjs';

if (!process.env.LOCAL_CP_ENGINE) {
  for (const engine of ['bun', 'node']) {
    const child = spawnSync(engine, ['--no-warnings', fileURLToPath(import.meta.url)], {
      env: { ...process.env, LOCAL_CP_ENGINE: engine }, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(child.status, 0, `${engine}: ${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /local child processes ok/);
    console.log(`  ok ${engine}: WASI children, pipes, statuses and runtime stdin`);
  }
  process.exit(0);
}

const core = typeof process.versions.bun === 'string' ? '../../packages/core/src' : '../../packages/core/dist';
const ext = typeof process.versions.bun === 'string' ? 'ts' : 'js';
const { NimbusWorkspace } = await import(`${core}/workspace/nimbus-workspace.${ext}`);
const { localFacetHost } = await import(`${core}/runtime/local-facet-host.${ext}`);
const { facetTaskSource } = await import(`${core}/runtime/facet-task.${ext}`);
const { ISOLATE_NETWORK } = await import(`${core}/_shared/workspace-network.${ext}`);
const wabt = await wabtFactory();
const compile = (source) => {
  const parsed = wabt.parseWat('local-child.wat', source);
  try { return parsed.toBinary({}).buffer; } finally { parsed.destroy(); }
};

const DRIVER = facetTaskSource(`async function drive(args, { SUPERVISOR }) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const memory = new WebAssembly.Memory({ initial: 4 });
  __wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], pid: args.processPid });
  __wasiAdoptSupervisor(SUPERVISOR);
  // Made as for a guest that parks, unwrapped: this driver awaits what the
  // imports answer, as a parked guest would (tests/unit/lib/wasi-imports.mjs).
  const { Suspending } = WebAssembly;
  WebAssembly.Suspending = function Unwrapped(body) { return body; };
  let bundle;
  try {
    bundle = __wasiMakeImports({ argv: ['parent'], env: {}, getMemory: () => memory,
      stdoutBytes: () => {}, stderrBytes: () => {} });
  } finally {
    if (Suspending === undefined) delete WebAssembly.Suspending;
    else WebAssembly.Suspending = Suspending;
  }
  const proc = bundle.procImport, wasi = bundle.wasiImport;
  const bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
  const enc = new TextEncoder(), dec = new TextDecoder();
  let region = 0;
  const scratch = () => 16384 + ((region++ % 32) * 4096);
  const strings = (at, words) => { const data = enc.encode(words.map(s => s + '\\0').join('')); bytes.set(data, at); return data.length; };
  const pipe = () => { const at = scratch(); check(proc.pipe(at) === 0, 'pipe'); return [view.getInt32(at, true), view.getInt32(at + 4, true)]; };
  const spawn = async (argv, input = -1, output = -1, env = []) => {
    const at = scratch(), argc = strings(at, argv), envc = strings(at + 1024, env);
    const dir = strings(at + 2048, ['/home/user']) - 1;
    let errno = await proc.spawn(at, argc, at + 1024, envc, at + 2048, dir, input, output, -1, at + 4000);
    if (errno !== 0) return { errno, pid: null };
    const pid = view.getInt32(at + 4000, true);
    do errno = await proc.start(pid); while (errno === 27);
    return { errno, pid };
  };
  const write = async (fd, text) => {
    const at = scratch(), data = enc.encode(text); bytes.set(data, at + 64);
    view.setUint32(at, at + 64, true); view.setUint32(at + 4, data.length, true);
    check(await wasi.fd_write(fd, at, 1, at + 8) === 0, 'write to child');
    check(view.getUint32(at + 8, true) === data.length, 'all stdin written');
  };
  const readAll = async (fd) => {
    let text = '';
    for (;;) {
      const at = scratch(); view.setUint32(at, at + 64, true); view.setUint32(at + 4, 1024, true);
      const errno = await wasi.fd_read(fd, at, 1, at + 8);
      if (errno === 27) continue;
      check(errno === 0, 'read child output: ' + errno);
      const size = view.getUint32(at + 8, true);
      if (size === 0) return text;
      text += dec.decode(bytes.slice(at + 64, at + 64 + size));
    }
  };
  const wait = async (pid) => {
    const at = scratch(); let errno;
    do errno = await proc.wait(pid, 0, at, at + 4); while (errno === 27);
    check(errno === 0 && view.getInt32(at + 4, true) === pid, 'wait child');
    return view.getInt32(at, true);
  };
  try {
    const [shellOut, shellWrite] = pipe();
    const shell = await spawn(['/bin/sh', '-c', 'echo hello; exit 7'], -1, shellWrite);
    check(shell.errno === 0, 'shell spawn: ' + shell.errno);
    await wasi.fd_close(shellWrite);
    check(await readAll(shellOut) === 'hello\\n', 'shell output reaches parent');
    check(await wait(shell.pid) === (7 << 8), 'shell exit status');

    for (const command of [['cat'], ['wasm-runner', '/home/user/echo.wasm']]) {
      const [input, inputWrite] = pipe(), [output, outputWrite] = pipe();
      const child = await spawn(command, input, outputWrite);
      check(child.errno === 0, 'stdin child spawn: ' + command + ': ' + child.errno);
      await wasi.fd_close(outputWrite);
      await write(inputWrite, 'piped input\\n');
      await wasi.fd_close(inputWrite);
      check(await readAll(output) === 'piped input\\n', 'child receives stdin: ' + command);
      check(await wait(child.pid) === 0, 'stdin child status: ' + command);
    }

    const slow = await spawn(['sleep', '60']);
    check(slow.errno === 0, 'sleep spawn');
    check(await proc.kill(slow.pid, 15) === 0, 'SIGTERM kills child');
    check(await wait(slow.pid) === 15, 'signal-only wait status');
    check((await spawn(['missing-local-child'])).errno === 44, 'unknown command is ENOENT');
    check((await spawn(['true'], -1, -1, ['NIMBUS_CP_DEPTH=8'])).errno === 6, 'depth is EAGAIN');

    const orphan = await SUPERVISOR.cpSpawn({ command: 'sleep', args: ['60'], env: {}, cwd: '/home/user',
      stdio: ['ignore', 'ignore', 'ignore'], parentPid: 999 });
    return { ok: true, mode: 'wasi', exitCode: 0, stdout: JSON.stringify({ orphan: orphan.childPid }), stderr: '' };
  } finally { bundle.procDispose(); }
}`);

const host = localFacetHost(ISOLATE_NETWORK);
const opened = [];
let parentPid;
const facets = {
  ...host,
  open(spec) {
    opened.push(spec);
    const facet = host.open(spec);
    if (spec.tag !== 'wasm-runner-wasi' || parentPid !== undefined) return facet;
    parentPid = spec.syscalls.pid;
    return { dispose: () => facet.dispose(), submit: (_task, args, options) => facet.submit(DRIVER, args, options) };
  },
};
const sqlite = await hostSqlite();
const ws = await NimbusWorkspace.create({ ...sqlite, generation: 1, cwd: '/home/user', facets });
try {
  await ws.fs.writeFile('parent.wasm', compile(`(module
    (import "wasi_snapshot_preview1" "proc_exit" (func (param i32)))
    (memory (export "memory") 1) (func (export "_start")))`));
  await ws.fs.writeFile('echo.wasm', compile(`(module
    (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
    (memory (export "memory") 1)
    (func (export "_start")
      (i32.store (i32.const 0) (i32.const 64)) (i32.store (i32.const 4) (i32.const 1024))
      (loop $next
        (drop (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
        (if (i32.load (i32.const 8)) (then
          (i32.store (i32.const 4) (i32.load (i32.const 8)))
          (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 12)))
          (i32.store (i32.const 4) (i32.const 1024)) (br $next))))))`));
  const result = await ws.exec('wasm-runner /home/user/parent.wasm');
  assert.equal(result.exitCode, 0, result.stderr);
  const { orphan } = JSON.parse(result.stdout);
  const broker = opened[0].syscalls.children;
  assert.ok(broker, 'workspace adds its broker to the parent facet');
  assert.ok(opened.length >= 2, 'a runtime child opens a separate facet');
  assert.ok(opened.every(spec => spec.syscalls.children === broker), 'all facets share one manager');
  assert.equal(await broker.wait(orphan, 1000).then(status => status.signal), 'SIGTERM', 'parent log exit kills an unawaited child');
  assert.equal(broker._getChildEntry(orphan).parentPid, parentPid, 'supervisor pins the invoking parent pid');
  let leftBehind;
  ws.registry.register('leave-child', async (ctx) => {
    leftBehind = await broker.spawn({ parentPid: ctx.pid, command: 'sleep', args: ['60'], env: {},
      cwd: ctx.cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    return 0;
  });
  assert.equal((await ws.exec('leave-child')).exitCode, 0);
  assert.equal((await broker.wait(leftBehind.childPid, 1000)).signal, 'SIGTERM', 'local exec ends its parent before reaping its tree');
  console.log('local child processes ok');
} finally { await ws.close(); }
