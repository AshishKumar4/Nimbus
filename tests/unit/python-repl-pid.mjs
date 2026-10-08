import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

// Only the Cloudflare facet transport is stood in for. Startup still goes
// through the real adapter, its artifact reads, and the REPL session.
const pools = [];
mock.module('@nimbus-sh/fabric/isolate-pool.js', () => ({
  IsolatePool: class {
    constructor(_env, _ctx, options) { this.options = options; this.steps = []; this.disposed = false; pools.push(this); }
    async submitRequest(_fn, request) {
      this.steps.push(await request.json());
      return Response.json({ stdout: '', stderr: '', exitCode: 0 });
    }
    dispose() { this.disposed = true; }
  },
}));
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
const { runPythonRepl, warmPythonRepl } = await import('../../packages/worker/src/runtime/python-repl.ts');
const { WebSocketTerminal } = await import('../../packages/worker/src/facets/ws-terminal.ts');

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
root.mkdir('py/share/cpython', { recursive: true });
root.mkdir('py/lib', { recursive: true });
root.writeFile('py/share/cpython/python.wasm', 'compiled interpreter asset');
root.writeFile('py/lib/python313.zip', 'stdlib asset');
const authority = new ProcessFiles(raw);
const deps = {
  facetMgr: { loaderHost: () => ({ env: {}, ctx: { id: {}, waitUntil() {} }, network: ISOLATE_NETWORK }) },
  authority, installRoot: 'py', home: '/home/user', manifest: {},
};
try {
  await warmPythonRepl(deps);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].options.omitSupervisor, true);
  assert.equal(pools[0].disposed, true, 'the install-time pool stayed live');

  for (const pid of [401, 402]) {
    const cred = { uid: pid, gid: pid, groups: [pid], umask: 0o022 };
    const ready = Promise.withResolvers();
    let text = '';
    const terminal = new WebSocketTerminal(null, (chunk) => {
      text += chunk;
      if (text.includes('>>> ')) ready.resolve();
    });
    const running = runPythonRepl({ ...deps, pid, cred, start: { cwd: '/home/user', binName: 'python3' }, terminal });
    let timer;
    try {
      await Promise.race([ready.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the PID-scoped interpreter did not reach its ready prompt')), 2000);
      })]);
      const pool = pools.at(-1);
      assert.equal(pool.options.supervisorPid, pid, 'the prompt used the install-time or another PID pool');
      assert.equal(pool.steps.length, 1, 'the prompt was published without booting its driver');
      assert.deepEqual(pool.steps[0].cred, cred, 'the prompt boot did not carry this process credential');
      assert.match(pool.steps[0].userCode, /import base64, codeop, sys, traceback/, 'the interpreter boot did not initialize its REPL driver');
    } finally {
      clearTimeout(timer);
      await terminal.disposeRepl();
      await running;
      terminal.close();
    }
  }
  assert.equal(pools.length, 3, 'the REPL reused a pool across process lifetimes');
  assert.ok(pools.every((pool) => pool.disposed), 'a closed prompt kept its pool');
} finally {
  harness.db.close();
}
console.log('python-repl-pid: each ready prompt boots its own driver with its invoking process credential');
