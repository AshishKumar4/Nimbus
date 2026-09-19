#!/usr/bin/env bun
// The session's programmatic exec boundary refuses a relative `cwd`.
//
// Every shell, process-table entry and VFS lookup keys on absolute POSIX
// paths; a relative cwd that reached `spawn` degraded to silent wrongness —
// `pwd` echoed the literal string and npm wrote ENOENT under it. The SDK now
// resolves it against the sandbox root, and this boundary rejects whatever
// still arrives relative so no other caller (agent tools, hand-rolled RPC
// clients) can hand the shell a bad cwd.

import assert from 'node:assert/strict';

import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { rpcExec, rpcRunCode, rpcStartProcess } from '../../packages/worker/src/session/programmatic.ts';

function makeHost() {
  const processes = new SessionProcessSupervisor();
  return {
    _w1SessionDestroyed: false,
    env: {},
    ctx: { waitUntil: () => {}, storage: {} },
    shell: {
      getEnv: () => ({ HOME: '/home/user' }),
      getCwd: () => '/home/user',
      execute: async () => ({ exitCode: 0 }),
    },
    shellProcessPid: null,
    sqliteFs: {},
    processes,
    portRegistry: { getAll: () => [] },
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: {},
    _viteShimPid: null,
    _viteShimPort: null,
    terminal: null,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    ensureRuntimeReady() { assert.ok(this.shell && this.sqliteFs, 'the test host must already be initialized'); },
  };
}

// ── relative cwd is refused, naming the field ────────────────────────────
for (const cwd of ['rel', './rel', '../x', '']) {
  await assert.rejects(
    () => rpcExec(makeHost(), 'pwd', { cwd }),
    (e) => e instanceof Error && /\bcwd\b/.test(e.message) && /absolute/.test(e.message),
    `exec rejects cwd=${JSON.stringify(cwd)} naming the field`,
  );
  await assert.rejects(
    () => rpcStartProcess(makeHost(), 'pwd', { cwd }),
    (e) => e instanceof Error && /\bcwd\b/.test(e.message) && /absolute/.test(e.message),
    `startProcess rejects cwd=${JSON.stringify(cwd)} naming the field`,
  );
}

// runCode funnels through rpcExec, so it is guarded the same way.
await assert.rejects(
  () => rpcRunCode(makeHost(), 'console.log(1)', { cwd: 'rel' }),
  /\bcwd\b.*absolute|absolute.*\bcwd\b/,
  'runCode refuses a relative cwd before reaching the shell',
);

// ── absolute and omitted cwd still run ───────────────────────────────────
{
  const host = makeHost();
  const result = await rpcExec(host, 'pwd', { cwd: '/home/user' });
  assert.equal(result.exitCode, 0, 'an absolute cwd still executes');
}
{
  const host = makeHost();
  const result = await rpcExec(host, 'pwd');
  assert.equal(result.exitCode, 0, 'no cwd still executes');
}

console.log('programmatic exec cwd: ok');
