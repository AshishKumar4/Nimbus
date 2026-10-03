#!/usr/bin/env bun
// NimbusWorkspace.exec runs every call on a shell of its own, as the
// session's programmatic exec does: built from the workspace shell's cwd and
// environment plus the call's own, under a process of its own, and discarded
// when the call ends. Kinu (ask 9, 2026-10-02): the library host's exec still
// shared one shell, so of two concurrent calls, one doing `cd /tmp`, both
// printed /tmp.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1 });
const home = ws.shell.getCwd();

// `hold` returns once `release` has run, and `held` once `hold` was entered:
// together they order two concurrent calls without a clock. Two calls that
// ran one after the other never meet, so `hold` gives up after 20 s and
// fails; that deadline only trips on that failure, never on a slow host.
// `barrier` returns once two invocations are inside it at the same time,
// under the same rule.
let enterHold = () => {};
const holdEntered = new Promise((resolve) => { enterHold = resolve; });
let releaseHold = () => {};
const holdReleased = new Promise((resolve) => { releaseHold = resolve; });
const met = (promise) => {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 20_000); }),
  ]).finally(() => clearTimeout(timer));
};
let entered = 0;
const arrivals = [];
ws.registry.register('hold', async () => { enterHold(); return (await met(holdReleased)) ? 0 : 1; });
ws.registry.register('held', async () => { await holdEntered; return 0; });
ws.registry.register('release', async () => { releaseHold(); return 0; });
ws.registry.register('barrier', async () => {
  entered += 1;
  if (entered % 2 === 0) { for (const arrive of arrivals.splice(0)) arrive(); return 0; }
  return (await met(new Promise((resolve) => arrivals.push(resolve)))) ? 0 : 1;
});

// ── Kinu's report: a `cd` in one concurrent call is not the other's ───────
{
  const [moved, stayed] = await Promise.all([ws.exec('cd /tmp && pwd'), ws.exec('pwd')]);
  assert.equal(moved.stdout, '/tmp\n');
  assert.equal(stayed.stdout, `${home}\n`, 'the other call kept its own cwd');
}

// ── While one call sits in /tmp, the other runs, and from its own cwd ─────
{
  const [inTmp, meanwhile] = await Promise.all([
    ws.exec('cd /tmp && hold && pwd'),
    ws.exec('held && pwd && release'),
  ]);
  assert.equal(inTmp.exitCode, 0, 'the call in /tmp was released by the other one, which ran meanwhile');
  assert.equal(inTmp.stdout, '/tmp\n');
  assert.equal(meanwhile.stdout, `${home}\n`, 'the call that ran meanwhile did not see the other cd');
}

// ── Two calls run at once ─────────────────────────────────────────────────
{
  const together = await Promise.all([ws.exec('barrier'), ws.exec('barrier')]);
  assert.deepEqual(together.map((r) => r.exitCode), [0, 0], 'two calls met inside one command');
}

// ── What a call changes stays in the call ─────────────────────────────────
{
  const set = await ws.exec(
    'cd /tmp; export LEAK=1; greet() { echo hi; }; alias ll="ls -l"; set -o noglob; umask 077; echo "$$"',
  );
  assert.equal(set.exitCode, 0, set.stderr);
  const after = await ws.exec(
    'pwd; echo "${LEAK-unset}"; greet 2>/dev/null || echo no-function; '
      + 'alias | grep -q "ll=" && echo alias-leaked || echo no-alias; '
      + 'case $- in *f*) echo noglob;; *) echo glob;; esac; umask; echo "$$"',
  );
  const [cwd, leak, fn, alias, glob, umask, pid] = after.stdout.split('\n');
  assert.deepEqual([cwd, leak, fn, alias, glob, umask], [home, 'unset', 'no-function', 'no-alias', 'glob', '0022'],
    'its cwd, variables, functions, aliases, options and umask do not reach the next call');
  assert.notEqual(pid, set.stdout.trim(), 'each call is a process of its own');

  // Nor the workspace shell, which a terminal types into.
  assert.equal(ws.shell.getCwd(), home);
  assert.equal(ws.shell.getEnv().LEAK, undefined);
  assert.equal((await ws.shell.execute('alias')).stdout, '', 'the terminal shell has no alias from a call');
  assert.equal(ws.processes.cred(ws.shellProcessPid).umask, 0o022, 'nor the umask of the shell process');

  // The call's process ended with the call, with its status, and left the
  // process table when its result came back.
  const callPid = Number(set.stdout.trim());
  assert.notEqual(callPid, ws.shellProcessPid);
  assert.equal(ws.processes.get(callPid), undefined, 'the call\'s process was reaped');
  assert.equal((await ws.exec('exit 3')).exitCode, 3);
}

// ── A call is a process with the workspace shell's credential, reaped after ─
// Nothing else reaps a bare workspace's table, so a call that left its entry
// behind would leave one per call forever.
{
  let seen = null;
  ws.registry.register('observe', async (ctx) => {
    seen = { pid: ctx.pid, state: ws.processes.get(ctx.pid)?.state, umask: ws.processes.cred(ctx.pid).umask };
    return 0;
  });
  const before = ws.processes.getAll().map((p) => p.pid);
  assert.equal((await ws.exec('observe')).exitCode, 0);
  assert.equal(seen.state, 'running', 'the call ran as a live process');
  assert.notEqual(seen.pid, ws.shellProcessPid);
  // sudo runs its program as a child process of the call; it goes too.
  assert.equal((await ws.exec('sudo true; echo "$$"')).exitCode, 0);
  await Promise.all([ws.exec('true'), ws.exec('false'), ws.exec('exit 7')]);
  assert.deepEqual(ws.processes.getAll().map((p) => p.pid), before, 'no call left an entry behind');

  // The credential is the workspace shell's process's, as it stands.
  await ws.shell.execute('umask 027');
  assert.equal((await ws.exec('observe; umask')).stdout, '0027\n');
  assert.equal(seen.umask, 0o027);
  await ws.shell.execute('umask 022');
}

// ── A call's process lets go of the filesystem with its entry ─────────────
// Each call binds its pid to the namespace: a descriptor scope that holds
// what the call's commands opened and watched. Released, the pid is refused
// (ESTALE) and what it held is closed; left bound, every call left one more
// scope behind, its watches still firing.
{
  let fired = 0;
  const pids = [];
  ws.registry.register('watch-home', async (ctx) => {
    pids.push(ctx.pid);
    ctx.vfs.process.subscribe(home, () => { fired += 1; });
    return 0;
  });
  for (let i = 0; i < 5; i++) assert.equal((await ws.exec('watch-home')).exitCode, 0);
  // `sudo` runs its program as a child process, bound to a pid of its own.
  assert.equal((await ws.exec('sudo watch-home')).exitCode, 0);
  await ws.fs.writeFile(`${home}/watched.txt`, 'x');
  await ws.fs.remove(`${home}/watched.txt`);
  assert.equal(fired, 0, 'no watch outlived the call that made it');
  const cred = ws.processes.cred(ws.shellProcessPid);
  for (const pid of pids) {
    assert.throws(() => ws.filesystem.bind({ pid, cred }), { code: 'ESTALE' }, `pid ${pid} was released`);
  }
}

// ── A named shell keeps its cwd and environment between calls ─────────────
{
  assert.equal((await ws.exec('cd /tmp; export STAGE=release', { shellId: 'agent-1' })).exitCode, 0);
  assert.equal((await ws.exec('pwd; echo "$STAGE"', { shellId: 'agent-1' })).stdout, '/tmp\nrelease\n');
  assert.equal((await ws.exec('pwd; echo "${STAGE-unset}"')).stdout, `${home}\nunset\n`, 'an unnamed call does not see it');
  assert.equal(ws.shell.getCwd(), home, 'nor the workspace shell');
  assert.equal((await ws.exec('pwd', { shellId: 'agent-2' })).stdout, `${ws.fs.cwd}\n`, 'a new name starts where the workspace did');
  assert.equal((await ws.exec('pwd', { shellId: 'agent-1', cwd: home })).stdout, `${home}\n`, 'a call\'s cwd holds for the call');
  assert.equal((await ws.exec('pwd', { shellId: 'agent-1' })).stdout, '/tmp\n', 'and only for it');

  // Its process is the call's: umask, functions and descriptors end with it.
  await ws.exec('umask 077; greet() { echo hi; }', { shellId: 'agent-1' });
  assert.equal((await ws.exec('umask; greet 2>/dev/null || echo no-function', { shellId: 'agent-1' })).stdout, '0022\nno-function\n');

  // Calls on one name run one at a time, in order: the second reads what the
  // first left. Run at once, it would start where the first started.
  const [moved, after] = await Promise.all([
    ws.exec('cd /etc', { shellId: 'agent-3' }),
    ws.exec('pwd', { shellId: 'agent-3' }),
  ]);
  assert.equal(moved.exitCode, 0);
  assert.equal(after.stdout, '/etc\n', 'the second call on the name ran after the first');
  // Calls on two names run at once, and a failed call frees its name.
  const together = await Promise.all([ws.exec('barrier', { shellId: 'agent-4' }), ws.exec('barrier', { shellId: 'agent-5' })]);
  assert.deepEqual(together.map((r) => r.exitCode), [0, 0], 'two names met inside one command');
  assert.equal((await ws.exec('exit 4', { shellId: 'agent-3' })).exitCode, 4);
  assert.equal((await ws.exec('pwd', { shellId: 'agent-3' })).stdout, '/etc\n');

  // A name is checked before anything runs.
  await assert.rejects(() => ws.exec('pwd', { shellId: '../escape' }), /Invalid/);
  await assert.rejects(() => ws.exec('pwd', { shellId: '' }), /small/);
}

// ── A call starts from the workspace shell's state, and its own ───────────
{
  await ws.shell.execute('cd /tmp; export SESSION_VAR=from-session');
  const inherited = await ws.exec('echo "$SESSION_VAR"; pwd');
  assert.equal(inherited.stdout, 'from-session\n/tmp\n', 'a terminal cd and export are where a call starts');
  const own = await ws.exec('echo "$SESSION_VAR $CALL_VAR"; pwd', { cwd: home, env: { CALL_VAR: 'from-call' } });
  assert.equal(own.stdout, `from-session from-call\n${home}\n`);
  assert.equal(ws.shell.getEnv().CALL_VAR, undefined, 'the call env did not reach the workspace shell');
  assert.equal(ws.shell.getCwd(), '/tmp', 'nor its cwd');
  await ws.shell.execute(`cd ${home}; unset SESSION_VAR`);
}

// ── A call's descriptors close when the call ends ─────────────────────────
// Its shell ends with it, so what an `exec` opened must close then: an open
// description pins the file's content, and nothing would ever close it.
{
  const chunks = () => harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;
  const collect = () => {
    for (let pass = 0; pass < 100; pass++) if (ws.vfs.runContentMaintenance(64).transactions === 0) return;
    throw new Error('maintenance did not reach a fixpoint');
  };
  collect();
  const stored = chunks();
  await ws.exec(`printf 'held by a descriptor\\n' > ${home}/held.txt`);
  assert.equal(chunks(), stored + 1, 'the file is one chunk');
  const wrote = await ws.exec(`exec 3<${home}/held.txt 5>>${home}/held.txt; echo more >&5; head -n 1 <&3`);
  assert.equal(wrote.stdout, 'held by a descriptor\n', wrote.stderr);
  assert.equal((await ws.exec(`exec 4<${home}/held.txt`)).exitCode, 0);
  assert.equal((await ws.exec(`cat ${home}/held.txt`)).stdout, 'held by a descriptor\nmore\n', 'a write through the descriptor landed');
  assert.equal((await ws.exec('echo stale >&4')).exitCode, 1, 'a descriptor is not the next call\'s');
  await ws.exec(`rm ${home}/held.txt`);
  collect();
  assert.equal(chunks(), stored, 'no descriptor outlived its call to pin the removed file');
}

await ws.close();

// ── A named shell outlives the workspace object; destroy drops it ─────────
{
  const reopened = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 2 });
  assert.equal((await reopened.exec('pwd; echo "$STAGE"', { shellId: 'agent-1' })).stdout, '/tmp\nrelease\n',
    'the name is where the last workspace left it');
  reopened.destroy();
  assert.deepEqual(harness.sql.exec("SELECT name FROM sqlite_master WHERE name = 'vfs_shells'"), []);
  await reopened.close();
}

console.log('nimbus-workspace-exec-own-shell: all assertions passed');
