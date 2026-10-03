#!/usr/bin/env bun
// A named programmatic shell: cwd and environment persist between calls.
//
// `exec` has always been one-shot — every call starts at the same cwd with the
// same environment — so `cd build` followed by `make` did not work, and an
// embedder scripting a sandbox had to re-derive the path on every line. Naming
// a shell makes it behave the way a terminal tab does.
//
// An unnamed call remembers nothing and shares nothing with another call.

import assert from 'node:assert/strict';

import { rpcExec, rpcStartProcess } from '../../packages/worker/src/session/programmatic.ts';
import { programmaticHost } from './lib/programmatic-host.mjs';

// `barrier` returns once two invocations are inside it at the same time, and
// fails after 20 s otherwise: two calls that ran one after the other never
// meet in it. The deadline only trips on that failure, never on a slow host.
let entered = 0;
const arrivals = [];
// `hold` returns once `release` has run, and `held` once `hold` was entered:
// together they order two concurrent calls without a clock.
let enterHold = () => {};
const holdEntered = new Promise((resolve) => { enterHold = resolve; });
let releaseHold = () => {};
const holdReleased = new Promise((resolve) => { releaseHold = resolve; });
// `marker` is a script interpreter (#!/bin/marker) that prints the script's
// second line, so a test can tell which of two scripts of one name ran.
const box = await programmaticHost({
  commands: {
    async marker(ctx) {
      await ctx.stdout.write(`${(await ctx.vfs.readFileString(ctx.args[0])).split('\n')[1]}\n`);
      return 0;
    },
    async hold() { enterHold(); await holdReleased; return 0; },
    async held() { await holdEntered; return 0; },
    async release() { releaseHold(); return 0; },
    async barrier() {
      entered += 1;
      if (entered % 2 === 0) { for (const arrive of arrivals.splice(0)) arrive(true); return 0; }
      let timer;
      const met = await new Promise((resolve) => {
        arrivals.push(resolve);
        timer = setTimeout(() => resolve(false), 20_000);
      });
      clearTimeout(timer);
      return met ? 0 : 1;
    },
  },
});
const { ws, host, rows, sql, held } = box;

try {
  await ws.exec('mkdir -p /home/user/build');

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
    rpcExec(host, 'export Y=first; hold; echo "$Y"'),
    rpcExec(host, 'held; echo "${Y-unset}"; export Y=second; release'),
  ]);
  assert.equal(first.stdout, 'first\n', 'a concurrent call does not overwrite its variable mid-run');
  assert.equal(second.stdout, 'unset\n', 'nor see it');
  // It starts from the session shell's state, and its own cwd and env.
  ws.shell.getEnv().SESSION_VAR = 'from-session';
  const inherited = await rpcExec(host, 'echo "$SESSION_VAR $CALL_VAR"; pwd', { cwd: '/home/user/build', env: { CALL_VAR: 'from-call' } });
  assert.equal(inherited.stdout, 'from-session from-call\n/home/user/build\n');
  assert.equal(ws.shell.getEnv().CALL_VAR, undefined, 'and leaves it as it was');
  delete ws.shell.getEnv().SESSION_VAR;
  const together = await Promise.all([rpcExec(host, 'barrier'), rpcExec(host, 'barrier')]);
  assert.deepEqual(together.map((r) => r.exitCode), [0, 0], 'two unnamed calls run at once');

  // A path or an npm bin is found from the call's own cwd, not the session
  // shell's: the registry is shared by every shell, and its resolvers read
  // the cwd of the shell that asks.
  await ws.exec("printf '#!/bin/marker\\nbuild task\\n' > /home/user/build/task.sh && chmod +x /home/user/build/task.sh");
  await ws.exec("printf '#!/bin/marker\\nhome task\\n' > /home/user/task.sh && chmod +x /home/user/task.sh");
  assert.equal(ws.shell.getCwd(), '/home/user', 'the session shell stays at home');
  assert.equal((await rpcExec(host, 'cd /home/user/build; ./task.sh')).stdout, 'build task\n', 'an unnamed call runs ./task.sh from its own cwd');
  assert.equal((await rpcExec(host, './task.sh', { cwd: '/home/user/build' })).stdout, 'build task\n', 'and from the cwd it was given');
  await rpcExec(host, 'cd /home/user/build', { shellId: 'agent-5' });
  assert.equal((await rpcExec(host, './task.sh', { shellId: 'agent-5' })).stdout, 'build task\n', 'a named shell from its own cwd');
  assert.equal((await rpcExec(host, 'command -v ./task.sh', { cwd: '/home/user/build' })).stdout.trim() !== '', true, 'command -v resolves it there too');

  // ── A call's descriptors close when the call ends ─────────────────────────
  // Its shell ends with it, so what an `exec` opened must close then: an open
  // description pins the file's content, and nothing would ever close it.
  const chunks = () => sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;
  const collect = () => {
    for (let pass = 0; pass < 100; pass++) if (ws.vfs.runContentMaintenance(64).transactions === 0) return;
    throw new Error('maintenance did not reach a fixpoint');
  };
  collect();
  const stored = chunks();
  await ws.exec("printf 'held by a descriptor\\n' > /home/user/held.txt");
  assert.equal(chunks(), stored + 1, 'the file is one chunk');
  assert.equal((await rpcExec(host, 'exec 3</home/user/held.txt 5>>/home/user/held.txt; echo more >&5; head -n 1 <&3')).stdout, 'held by a descriptor\n');
  assert.equal((await rpcExec(host, 'exec 3</home/user/held.txt')).exitCode, 0);
  assert.equal((await rpcExec(host, 'exec 4</home/user/held.txt', { shellId: 'agent-5' })).exitCode, 0);
  assert.equal((await rpcExec(host, 'cat /home/user/held.txt')).stdout, 'held by a descriptor\nmore\n', 'a write through the descriptor landed');
  await rpcExec(host, 'rm /home/user/held.txt');
  collect();
  assert.equal(chunks(), stored, 'no descriptor outlived its call to pin the removed file');

  // ── shellRoot seeds a NEW shell only ──────────────────────────────────────
  const seeded = await rpcExec(host, 'pwd', { shellId: 'agent-3', shellRoot: '/home/user/build' });
  assert.equal(seeded.stdout.trim(), '/home/user/build');
  await rpcExec(host, 'cd /home/user', { shellId: 'agent-3', shellRoot: '/home/user/build' });
  const kept = await rpcExec(host, 'pwd', { shellId: 'agent-3', shellRoot: '/home/user/build' });
  assert.equal(kept.stdout.trim(), '/home/user', 'a seed does not reset a shell that already exists');

  // ── A name's first call starts it there, a background one too ────────────
  // A background call saves nothing it changes, but the name exists from its
  // first call: the next call on it starts where the first was rooted.
  await rpcStartProcess(host, 'cd /tmp', { shellId: 'agent-6', shellRoot: '/home/user/build' });
  assert.equal((await rpcExec(host, 'pwd', { shellId: 'agent-6' })).stdout, '/home/user/build\n',
    'the name started where its first call, a background one, was rooted');
  await rpcStartProcess(host, 'cd /tmp', { shellId: 'agent-6' });
  assert.equal((await rpcExec(host, 'pwd', { shellId: 'agent-6' })).stdout, '/home/user/build\n', 'and its cd was not saved');
  await Promise.all(held);

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

  // ── The names are the workspace's: one shell, whichever door it is used by ─
  await rpcExec(host, 'cd /home/user/build; export DOOR=session', { shellId: 'shared' });
  assert.equal((await ws.exec('pwd; echo "$DOOR"', { shellId: 'shared' })).stdout, '/home/user/build\nsession\n',
    'the workspace\'s exec is in the shell the session left');
  await ws.exec('cd /tmp; export DOOR=workspace', { shellId: 'shared' });
  assert.equal((await rpcExec(host, 'pwd; echo "$DOOR"', { shellId: 'shared' })).stdout, '/tmp\nworkspace\n', 'and back');
  assert.equal(rows.size, 0, 'no named shell is kept in the object\'s own storage');
  assert.equal(sql.exec("SELECT id FROM vfs_shells WHERE id = 'shared'").length, 1, 'it is a row of the workspace');

  ws.shell.getEnv().PWD = '/stale';
  await ws.shell.execute(':', { isolateShellState: true });
  assert.equal(ws.shell.getEnv().PWD, ws.shell.getCwd(), 'restoring a shell frame synchronizes PWD with cwd');
} finally {
  box.close();
}

// ── Named shells a session stored before they were the workspace's ────────
// Worker 0.13 kept each in the object's own storage. The first named call
// adopts every one, except a name the workspace already has, and storage
// lets them go.
{
  const legacy = await programmaticHost();
  try {
    await legacy.ws.exec('mkdir -p /home/user/old');
    legacy.rows.set('nimbus_programmatic_shell:kept', { cwd: '/home/user/old', env: { OLD: '1' } });
    legacy.rows.set('nimbus_programmatic_shell:taken', { cwd: '/home/user/old', env: {} });
    await legacy.ws.exec('cd /tmp', { shellId: 'taken' });
    const kept = await rpcExec(legacy.host, 'pwd; echo "$OLD"', { shellId: 'kept' });
    assert.equal(kept.stdout, '/home/user/old\n1\n', 'a stored shell is where it was left');
    assert.equal((await rpcExec(legacy.host, 'pwd', { shellId: 'taken' })).stdout, '/tmp\n', 'the workspace\'s own shell of a name stays');
    assert.equal(legacy.rows.size, 0, 'storage no longer holds them');
  } finally {
    legacy.close();
  }
}

// More than one storage delete can take (128 keys).
{
  const many = await programmaticHost();
  try {
    for (let i = 0; i < 300; i++) many.rows.set(`nimbus_programmatic_shell:old-${i}`, { cwd: '/tmp', env: { N: String(i) } });
    assert.equal((await rpcExec(many.host, 'pwd; echo "$N"', { shellId: 'old-299' })).stdout, '/tmp\n299\n', 'all 300 were adopted');
    assert.equal((await rpcExec(many.host, 'echo "$N"', { shellId: 'old-0' })).stdout, '0\n');
    assert.equal(many.rows.size, 0, 'and storage let every one go');
  } finally {
    many.close();
  }
}

// An adoption that failed is tried again by the next named call, rather than
// failing every named call after it.
{
  const once = await programmaticHost();
  try {
    once.rows.set('nimbus_programmatic_shell:old', { cwd: '/tmp', env: {} });
    const storage = once.host.ctx.storage;
    const list = storage.list;
    storage.list = async () => { storage.list = list; throw new Error('storage is unavailable'); };
    await assert.rejects(() => rpcExec(once.host, 'pwd', { shellId: 'old' }), /storage is unavailable/);
    assert.equal((await rpcExec(once.host, 'pwd', { shellId: 'old' })).stdout, '/tmp\n', 'the next call adopted it');
  } finally {
    once.close();
  }
}

console.log('programmatic named shell: ok');
