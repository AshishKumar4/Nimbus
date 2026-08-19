#!/usr/bin/env bun
// A named programmatic shell: cwd and environment persist between calls.
//
// `exec` has always been one-shot — every call starts at the same cwd with the
// same environment — so `cd build` followed by `make` did not work, and an
// embedder scripting a sandbox had to re-derive the path on every line. Naming
// a shell makes it behave the way a terminal tab does.
//
// Unnamed calls are untouched, which is the property that matters most here.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { rpcExec } from '../../packages/worker/src/session/programmatic.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const dir = mkdtempSync(join(tmpdir(), 'nimbus-named-shell-'));

try {
  const db = new Database(join(dir, 'workspace.sqlite'));
  const harness = createSqliteVfsTestHarness(db);
  const ws = await NimbusWorkspace.create({
    sql: harness.sql,
    transactions: harness.ctx,
    generation: 1,
  });
  await ws.exec('mkdir -p /home/user/build');

  const rows = new Map();
  const host = {
    _w1SessionDestroyed: false,
    env: {},
    ctx: {
      waitUntil: () => {},
      storage: {
        get: async (key) => rows.get(key),
        put: async (key, value) => { rows.set(key, value); },
        delete: async (key) => { rows.delete(key); },
      },
    },
    shell: ws.shell,
    shellProcessPid: null,
    sqliteFs: ws.vfs,
    processes: new SessionProcessSupervisor(),
    portRegistry: { getAll: () => [] },
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: null,
    _viteShimPid: null,
    _viteShimPort: null,
    terminal: null,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    initSession() { throw new Error('the test host is already booted'); },
  };

  // ── cd sticks, and so does an exported variable ───────────────────────────
  assert.equal((await rpcExec(host, 'cd /home/user/build', { shellId: 'agent-1' })).exitCode, 0);
  const where = await rpcExec(host, 'pwd', { shellId: 'agent-1' });
  assert.equal(where.stdout.trim(), '/home/user/build', 'the named shell stayed where it was put');

  await rpcExec(host, 'export STAGE=release', { shellId: 'agent-1' });
  const stage = await rpcExec(host, 'echo $STAGE', { shellId: 'agent-1' });
  assert.equal(stage.stdout.trim(), 'release', 'an exported variable outlives the call');

  // ── Two names are two shells ──────────────────────────────────────────────
  const other = await rpcExec(host, 'pwd', { shellId: 'agent-2' });
  assert.equal(other.stdout.trim(), '/home/user', 'a fresh name starts at home, not in the other shell');
  const stillThere = await rpcExec(host, 'pwd', { shellId: 'agent-1' });
  assert.equal(stillThere.stdout.trim(), '/home/user/build', 'and does not disturb the first');

  // ── An unnamed call remembers nothing, exactly as before ──────────────────
  await rpcExec(host, 'cd /home/user/build');
  const unnamed = await rpcExec(host, 'pwd');
  assert.notEqual(unnamed.stdout.trim(), '/home/user/build', 'an unnamed exec is still one-shot');

  // ── shellRoot seeds a NEW shell only ──────────────────────────────────────
  const seeded = await rpcExec(host, 'pwd', { shellId: 'agent-3', shellRoot: '/home/user/build' });
  assert.equal(seeded.stdout.trim(), '/home/user/build');
  await rpcExec(host, 'cd /home/user', { shellId: 'agent-3', shellRoot: '/home/user/build' });
  const kept = await rpcExec(host, 'pwd', { shellId: 'agent-3', shellRoot: '/home/user/build' });
  assert.equal(kept.stdout.trim(), '/home/user', 'a seed does not reset a shell that already exists');

  // ── Concurrent calls on one name serialize instead of racing ──────────────
  //
  // Both would otherwise read the same cwd and write it back, and the loser's
  // `cd` would vanish.
  await Promise.all([
    rpcExec(host, 'cd /home/user/build', { shellId: 'agent-4' }),
    rpcExec(host, 'echo hello', { shellId: 'agent-4' }),
  ]);
  const raced = await rpcExec(host, 'pwd', { shellId: 'agent-4' });
  assert.equal(raced.stdout.trim(), '/home/user/build', 'the cd survived a concurrent sibling');

  // ── A bad name is refused, not silently used as a storage key ─────────────
  await assert.rejects(() => rpcExec(host, 'pwd', { shellId: '../escape' }), /Invalid|expected|string/i);
  await assert.rejects(() => rpcExec(host, 'pwd', { shellId: '' }), /Invalid|expected|string|small/i);

  assert.ok(
    [...rows.keys()].every((key) => key.startsWith('nimbus_programmatic_shell:')),
    'state is stored under the declared prefix and nothing else',
  );

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('programmatic named shell: ok');
