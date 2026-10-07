#!/usr/bin/env bun
// The installed hook's real runner binding persists across workspace wakes.
// No WASM facet is needed to answer the JS protocol hook.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { GIT_RUNNER } from '../../packages/core/src/runtime/os-contracts.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const h = createSqliteVfsTestHarness();
const bytes = new TextEncoder().encode('Nimbus fsmonitor hook marker\n');
const runtime = {
  manifest: {
    name: 'git', version: '2.53.0', license: 'GPL-2.0-only', wasi_namespace: 'wasi_snapshot_preview1',
    files: [{ path: 'bin/git-fsmonitor-nimbus', content: 'hook', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 'exec' }],
    entrypoints: [{ binName: 'git-fsmonitor-nimbus', runner: GIT_RUNNER, kind: 'fsmonitor', args: [] }],
  },
  readBlob: async () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
};
const facets = { open() { throw new Error('the fsmonitor protocol must not open a WASM facet'); } };
const options = { sql: h.sql, transactions: h.ctx, facets, runtimes: [runtime], cwd: '/home/user' };
const hook = async (ws, token) => {
  const r = await ws.exec(`cd /home/user/repo && git-fsmonitor-nimbus 2 '${token}'`);
  assert.equal(r.exitCode, 0, r.stderr);
  const parts = r.stdout.split('\0'); assert.equal(parts.pop(), '');
  return { token: parts.shift(), paths: parts };
};
let ws = await NimbusWorkspace.create(options);
try {
  assert.equal((await ws.exec('mkdir -p repo && printf one > repo/a')).exitCode, 0);
  const first = await hook(ws, '0'); assert.deepEqual(first.paths, ['/']);
  await ws.close(); ws = await NimbusWorkspace.create(options);
  const wake = await hook(ws, first.token); assert.deepEqual(wake.paths, [], 'the runner keeps issued revision provenance after a workspace wake');
  assert.equal((await ws.exec('printf two > repo/a')).exitCode, 0);
  const changed = await hook(ws, wake.token); assert.ok(changed.paths.includes('a') || changed.paths.includes('/'), 'a shell process write is visible to the hook');
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  ws.filesystem.vfs.mount('/home/user/repo/external', backend);
  const mounted = await hook(ws, changed.token); assert.ok(mounted.paths.includes('external/'));
  backend.writeFile('/new.txt', new TextEncoder().encode('external'));
  assert.deepEqual((await hook(ws, mounted.token)).paths, ['external/'], 'the runner forwards the visible mount inventory');
  ws.filesystem.vfs.unmount('/home/user/repo/external');
  assert.deepEqual((await hook(ws, mounted.token)).paths, ['external/'], 'the runner invalidates an unmounted prefix');
  ws.vfs.rotateIncarnation(); assert.deepEqual((await hook(ws, mounted.token)).paths, ['/'], 'restore/new epoch invalidates the installed hook token');
  console.log('git-fsmonitor-runtime: installed hook, durable wake, process write and mounts passed');
} finally { await ws.close(); h.db.close(); }
