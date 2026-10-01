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

import { programmaticHost } from './lib/programmatic-host.mjs';
import { rpcExec, rpcRunCode, rpcStartProcess } from '../../packages/worker/src/session/programmatic.ts';

const opened = [];
async function makeHost() {
  const box = await programmaticHost();
  opened.push(box);
  return box.host;
}

// ── relative cwd is refused, naming the field ────────────────────────────
for (const cwd of ['rel', './rel', '../x', '']) {
  await assert.rejects(
    async () => rpcExec(await makeHost(), 'pwd', { cwd }),
    (e) => e instanceof Error && /\bcwd\b/.test(e.message) && /absolute/.test(e.message),
    `exec rejects cwd=${JSON.stringify(cwd)} naming the field`,
  );
  await assert.rejects(
    async () => rpcStartProcess(await makeHost(), 'pwd', { cwd }),
    (e) => e instanceof Error && /\bcwd\b/.test(e.message) && /absolute/.test(e.message),
    `startProcess rejects cwd=${JSON.stringify(cwd)} naming the field`,
  );
}

// runCode funnels through rpcExec, so it is guarded the same way.
await assert.rejects(
  async () => rpcRunCode(await makeHost(), 'console.log(1)', { cwd: 'rel' }),
  /\bcwd\b.*absolute|absolute.*\bcwd\b/,
  'runCode refuses a relative cwd before reaching the shell',
);

// ── absolute and omitted cwd still run ───────────────────────────────────
{
  const host = await makeHost();
  const result = await rpcExec(host, 'pwd', { cwd: '/home/user' });
  assert.equal(result.exitCode, 0, 'an absolute cwd still executes');
  assert.equal(result.stdout, '/home/user\n');
}
{
  const host = await makeHost();
  const result = await rpcExec(host, 'pwd');
  assert.equal(result.exitCode, 0, 'no cwd still executes');
}

for (const box of opened) box.close();
console.log('programmatic exec cwd: ok');
