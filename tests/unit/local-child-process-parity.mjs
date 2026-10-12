#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import wabtFactory from 'wabt';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';

if (!process.env.CHILD_PARITY_CASE) {
  const failures = [];
  for (const engine of ['bun', 'node']) for (const name of ['native', 'shell-path', 'parent', 'runtime-parent', 'host', 'python']) {
    const child = spawnSync(engine, ['--no-warnings', fileURLToPath(import.meta.url)], {
      env: { ...process.env, CHILD_PARITY_CASE: name }, encoding: 'utf8', timeout: 90_000,
    });
    if (child.status !== 0) failures.push(`${engine} ${name}: ${child.stdout}\n${child.stderr}`);
    else console.log(`ok ${engine} ${name}`);
  }
  assert.deepEqual(failures, []);
  process.exit(0);
}
const core = typeof process.versions.bun === 'string' ? '../../packages/core/src' : '../../packages/core/dist';
const ext = typeof process.versions.bun === 'string' ? 'ts' : 'js';
const { NimbusWorkspace } = await import(`${core}/workspace/nimbus-workspace.${ext}`);
const { localFacetHost } = await import(`${core}/runtime/local-facet-host.${ext}`);
const { ISOLATE_NETWORK } = await import(`${core}/_shared/workspace-network.${ext}`);
const { CRED_KERNEL } = await import(`${core}/runtime/os-contracts.${ext}`);
const { openRuntimeStdio } = await import(`${core}/runtime/runtime-stdio.${ext}`);
const sqlite = await hostSqlite();
const host = localFacetHost(ISOLATE_NETWORK);
const name = process.env.CHILD_PARITY_CASE;
if (name === 'host' || name === 'python' || name === 'shell-path') {
  const seed = await NimbusWorkspace.create({ ...sqlite });
  const runtime = RUNTIMES.find(runtime => runtime.name === (name === 'python' ? 'cpython' : 'bash'));
  // A shebang needs an installed interpreter, independently of broker normalization.
  seedRuntime(seed.vfs, name === 'shell-path' ? { ...runtime, entrypoints: [...runtime.entrypoints,
    { binName: 'sh', runner: runtime.entrypoints[0].runner, args: [] }] } : runtime);
  await seed.close();
}
const ws = await NimbusWorkspace.create({ ...sqlite, cwd: '/home/user', facets: Object.create(host) });
const children = [];
const spawn = async (command, args = [], extra = {}) => {
  const result = await ws.children.spawn({ parentPid: ws.shellProcessPid, command, args,
    cwd: '/home/user', env: { PATH: '/bin' }, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  children.push(result.childPid);
  return result.childPid;
};
const output = async pid => {
  const status = await ws.children.wait(pid, 5000), bytes = await ws.children.drainOutput(pid);
  return { code: status.exitCode, stdout: new TextDecoder().decode(bytes.stdout), stderr: new TextDecoder().decode(bytes.stderr) };
};
try {
  switch (name) {
    case 'native': {
      const wabt = await wabtFactory();
      const parsed = wabt.parseWat('parent.wat', `(module
        (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
        (import "nimbus_proc" "spawn" (func $spawn (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
        (import "nimbus_proc" "start" (func $start (param i32) (result i32)))
        (import "nimbus_proc" "wait" (func $wait (param i32 i32 i32 i32) (result i32)))
        (memory (export "memory") 1) (data (i32.const 64) "true\\00") (data (i32.const 96) "/")
        (func (export "_start") (local $pid i32)
          (if (call $spawn (i32.const 64) (i32.const 5) (i32.const 0) (i32.const 0)
            (i32.const 96) (i32.const 1) (i32.const -1) (i32.const -1) (i32.const -1) (i32.const 128))
            (then (call $exit (i32.const 81))))
          (local.set $pid (i32.load (i32.const 128)))
          (if (i32.le_s (local.get $pid) (i32.const 0)) (then (call $exit (i32.const 82))))
          (if (call $start (local.get $pid)) (then (call $exit (i32.const 83))))
          (if (call $wait (local.get $pid) (i32.const 0) (i32.const 132) (i32.const 136)) (then (call $exit (i32.const 84))))
          (if (i32.ne (i32.load (i32.const 136)) (local.get $pid)) (then (call $exit (i32.const 85))))
          (if (i32.load (i32.const 132)) (then (call $exit (i32.const 86))))))`);
      try { await ws.fs.writeFile('native-parent.wasm', parsed.toBinary({}).buffer); } finally { parsed.destroy(); }
      const result = await ws.exec('wasm-runner /home/user/native-parent.wasm');
      if (host.parking === 'jspi') assert.equal(result.exitCode, 0, result.stderr);
      else {
        assert.notEqual(result.exitCode, 0, 'a native non-parking caller must not receive false syscall success');
        assert.match(result.stderr, /nimbus_proc.*JSPI|JSPI.*nimbus_proc/s, 'unsupported native child ABI is refused by name');
        assert.equal(ws.children.stats.total, 0, 'refusal starts no child');
      }
      break;
    }
    case 'shell-path': {
      const fs = ws.vfs.as(CRED_KERNEL);
      fs.mkdir('usr/local/bin', { recursive: true });
      fs.writeFile('usr/local/bin/echo', '#!/bin/sh\necho CUSTOM\n', { mode: 0o755 });
      fs.writeFile('usr/local/bin/hook', '#!/bin/sh\necho HOOK\n', { mode: 0o755 });
      for (const [command, expected] of [['/usr/local/bin/echo', 'CUSTOM\n'], ['/usr/local/bin/hook', 'HOOK\n']]) {
        const pid = await spawn(command, ['x'], { shell: true });
        assert.deepEqual(await output(pid), { code: 0, stdout: expected, stderr: '' });
      }
      break;
    }
    case 'parent': {
      ws.registry.register('leave-child', async ctx => { await spawn('sleep', ['60'], { parentPid: ctx.pid }); return 0; });
      assert.equal((await ws.exec('sudo leave-child')).exitCode, 0);
      assert.equal((await ws.children.wait(children.at(-1), 1000)).signal, 'SIGTERM', 'a credential-transition parent ends its child');
      break;
    }
    case 'runtime-parent': {
      const ctx = { pid: ws.shellProcessPid, cred: ws.processes.cred(ws.shellProcessPid), cwd: '/home/user', env: {},
        signal: new AbortController().signal, stdout: { write() {} }, stderr: { write() {} } };
      const stdio = openRuntimeStdio(ws, ctx, 'runtime-parent');
      const pid = await spawn('sleep', ['60'], { parentPid: stdio.pid });
      stdio.finish(0);
      assert.equal((await ws.children.wait(pid, 1000)).signal, 'SIGTERM', 'a runtime-stdio parent ends its child');
      break;
    }
    case 'host': {
      const result = await ws.exec(`bash -c 'printf x | cat'`);
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout, 'x');
      break;
    }
    case 'python': {
      const result = await ws.exec(`echo hi | python3 -c "import sys; print(sys.stdin.read().strip())"`);
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout, 'hi\n');
      break;
    }
  }
} finally {
  for (const pid of children) ws.children.kill(pid, 'SIGKILL');
  await ws.close();
}
