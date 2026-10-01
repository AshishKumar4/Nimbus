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

import { rpcExec } from '../../packages/worker/src/session/programmatic.ts';
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
const box = await programmaticHost({
  commands: {
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
const { ws, host, rows } = box;

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
} finally {
  box.close();
}

console.log('programmatic named shell: ok');
