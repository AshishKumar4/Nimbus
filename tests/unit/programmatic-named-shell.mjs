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
    shellProcessPid: ws.shellProcessPid,
    sqliteFs: ws.vfs,
    processes: ws.processes,
    portRegistry: { getAll: () => [] },
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: ws.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    terminal: null,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    ensureRuntimeReady() { assert.equal(this.shell, ws.shell); assert.equal(this.processes, ws.processes); },
  };

  // ── cd sticks, and so does an exported variable ───────────────────────────
  assert.equal((await rpcExec(host, 'cd /home/user/build', { shellId: 'agent-1' })).exitCode, 0);
  const where = await rpcExec(host, 'pwd', { shellId: 'agent-1' });
  assert.equal(where.stdout.trim(), '/home/user/build', 'the named shell stayed where it was put');
  assert.equal((await rpcExec(host, 'echo "$PWD"', { shellId: 'agent-1' })).stdout.trim(), '/home/user/build', 'PWD follows the persisted cwd');

  await rpcExec(host, 'export STAGE=release', { shellId: 'agent-1' });
  const stage = await rpcExec(host, 'echo $STAGE', { shellId: 'agent-1' });
  assert.equal(stage.stdout.trim(), 'release', 'an exported variable outlives the call');

  // ── Two names are two shells ──────────────────────────────────────────────
  const other = await rpcExec(host, 'pwd', { shellId: 'agent-2' });
  assert.equal(other.stdout.trim(), '/home/user', 'a fresh name starts at home, not in the other shell');
  assert.equal((await rpcExec(host, 'echo "$PWD"', { shellId: 'agent-2' })).stdout.trim(), '/home/user', 'PWD stays scoped to its named shell');
  const stillThere = await rpcExec(host, 'pwd', { shellId: 'agent-1' });
  assert.equal(stillThere.stdout.trim(), '/home/user/build', 'and does not disturb the first');

  // ── An unnamed call remembers nothing, and shares nothing ─────────────────
  // Kinu (2026-10-01): an `export` in one unnamed call reached the next
  // unnamed call of another actor, and two unnamed calls running at once
  // read and overwrote each other's variables mid-run.
  await rpcExec(host, 'cd /home/user/build');
  const unnamed = await rpcExec(host, 'pwd');
  assert.notEqual(unnamed.stdout.trim(), '/home/user/build', 'an unnamed exec is still one-shot');
  await rpcExec(host, 'export LEAK=1; greet() { echo hi; }; alias ll="ls -l"; set -o noglob');
  const after = await rpcExec(host, 'echo "${LEAK-unset}"; greet 2>/dev/null || echo no-function; alias | grep -q "ll=" && echo alias-leaked || echo no-alias; case $- in *f*) echo noglob;; *) echo glob;; esac');
  assert.equal(after.stdout, 'unset\nno-function\nno-alias\nglob\n', 'its variables, functions, aliases and options do not reach the next unnamed call');
  assert.equal(ws.shell.getEnv().LEAK, undefined, 'nor the session shell');
  const [first, second] = await Promise.all([
    rpcExec(host, 'export Y=first; sleep 0.3; echo "$Y"'),
    rpcExec(host, 'sleep 0.1; echo "${Y-unset}"; export Y=second'),
  ]);
  assert.equal(first.stdout, 'first\n', 'a concurrent call does not overwrite its variable mid-run');
  assert.equal(second.stdout, 'unset\n', 'nor see it');
  // It starts from the session shell's state, and its own cwd and env.
  ws.shell.getEnv().SESSION_VAR = 'from-session';
  const inherited = await rpcExec(host, 'echo "$SESSION_VAR $CALL_VAR"; pwd', { cwd: '/home/user/build', env: { CALL_VAR: 'from-call' } });
  assert.equal(inherited.stdout, 'from-session from-call\n/home/user/build\n');
  assert.equal(ws.shell.getEnv().CALL_VAR, undefined, 'and leaves it as it was');
  delete ws.shell.getEnv().SESSION_VAR;
  const concurrent = Date.now();
  await Promise.all([rpcExec(host, 'sleep 0.5'), rpcExec(host, 'sleep 0.5')]);
  assert.ok(Date.now() - concurrent < 900, 'unnamed calls run concurrently');

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

  ws.shell.getEnv().PWD = '/stale';
  await ws.shell.execute(':', { isolateShellState: true });
  assert.equal(ws.shell.getEnv().PWD, ws.shell.getCwd(), 'restoring a shell frame synchronizes PWD with cwd');

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('programmatic named shell: ok');
