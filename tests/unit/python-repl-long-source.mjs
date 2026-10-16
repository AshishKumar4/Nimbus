#!/usr/bin/env bun
// A long line at the Python prompt reaches the interpreter whole. Its driver
// carries the submission as base64 of its UTF-8 (python-repl.ts
// buildReplDriver), and host python3 decodes it as the driver does: the
// text typed, every character.
//
// Red before: the driver spread the line's whole UTF-8 array into
// String.fromCharCode, so a line past the engine's argument limit failed
// ("[python-repl] dispatch failed: Maximum call stack size exceeded")
// before Python saw it.
//
// Only the Cloudflare facet transport is stood in for, as python-repl-pid.mjs
// stands it in: startup goes through the real adapter and the REPL session.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock } from 'bun:test';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const pools = [];
const submitted = Promise.withResolvers();
mock.module('@nimbus-sh/fabric/isolate-pool.js', () => ({
  IsolatePool: class {
    constructor(_env, _ctx, options) { this.options = options; this.steps = []; this.disposed = false; pools.push(this); }
    async submitRequest(_fn, request) {
      this.steps.push(await request.json());
      // The boot is the first step; the line's driver the second.
      if (this.steps.length === 2) submitted.resolve(this.steps[1].userCode);
      return Response.json({ stdout: '', stderr: '', exitCode: 0 });
    }
    dispose() { this.disposed = true; }
  },
}));
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
const { runPythonRepl } = await import('../../packages/worker/src/runtime/python-repl.ts');
const { WebSocketTerminal } = await import('../../packages/worker/src/facets/ws-terminal.ts');

// 400,000 characters of two-byte UTF-8 (800,000 bytes) and a few wider ones: past the argument limit of workerd's
// V8, where the prompt runs (about 125,000), and of Bun's JSC, where this test runs (about 700,000).
const LINE = `s = "${'é'.repeat(400_000)}✓😀"`;

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
root.mkdir('py/share/cpython', { recursive: true });
root.mkdir('py/lib', { recursive: true });
root.writeFile('py/share/cpython/python.wasm', 'compiled interpreter asset');
root.writeFile('py/lib/python313.zip', 'stdlib asset');
const deps = {
  facetMgr: { loaderHost: () => ({ env: {}, ctx: { id: {}, waitUntil() {} }, network: ISOLATE_NETWORK }) },
  authority: new ProcessFiles(raw), installRoot: 'py', home: '/home/user', manifest: {},
};
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
let text = '';
const ready = Promise.withResolvers();
const terminal = new WebSocketTerminal(null, (chunk) => {
  text += chunk;
  if (text.includes('>>> ')) ready.resolve();
});
const running = runPythonRepl({ ...deps, pid: 500, cred, start: { cwd: '/home/user', binName: 'python3' }, terminal });
let driver;
try {
  const within = (promise, what) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), 20_000); })])
      .finally(() => clearTimeout(timer));
  };
  await within(ready.promise, 'the prompt did not become ready');
  terminal.sendData(`${LINE}\r`);
  const failed = new Promise((resolve) => {
    const poll = setInterval(() => { if (text.includes('dispatch failed')) { clearInterval(poll); resolve(null); } }, 20);
    submitted.promise.then(() => clearInterval(poll));
  });
  driver = await within(Promise.race([submitted.promise, failed]), 'the line was neither submitted nor refused');
  assert.notEqual(driver, null, `the line never reached the interpreter: ${text.slice(text.indexOf('[python-repl]'), text.indexOf('[python-repl]') + 200)}`);
} finally {
  await terminal.disposeRepl();
  await running;
  terminal.close();
  harness.db.close();
}

// The driver's payload, decoded as the driver decodes it.
const payload = /base64\.b64decode\("([A-Za-z0-9+/=]*)"\)\.decode\("utf-8"\)/.exec(driver);
assert.ok(payload, 'the driver no longer carries its source as base64');
const python = spawnSync('python3', ['-c', 'import base64, sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()).decode("utf-8").encode("utf-8"))'], { input: payload[1], maxBuffer: 1 << 24 });
assert.equal(python.error, undefined, `host python3 did not start: ${python.error}`);
assert.equal(python.status, 0, `host python3 could not decode the payload: ${python.stderr}`);
assert.equal(python.stdout.toString('utf8'), LINE, 'the interpreter would not see the line typed');
console.log(`ok - python-repl-long-source (a ${Buffer.byteLength(LINE)}-byte line reaches the interpreter whole, decoded by host python3)`);
